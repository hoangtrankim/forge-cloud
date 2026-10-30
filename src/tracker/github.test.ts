import { describe, expect, it } from 'vitest';
import { GhError, GitHubTracker, issueToTicket, type GhRequest } from './github.js';
import { NotFoundError } from './tracker.js';
import { GitHubCodeHost } from '../codehost.js';

function fakeGh(routes: Record<string, (req: GhRequest) => unknown>) {
  const calls: GhRequest[] = [];
  const gh = async (req: GhRequest) => {
    calls.push(req);
    const key = `${req.method ?? 'GET'} ${req.path}`;
    const handler = routes[key];
    if (!handler) throw new GhError(`no route for ${key}`, 404);
    return handler(req);
  };
  return { gh, calls };
}

const issue = (over: object = {}) => ({
  number: 5,
  title: 'Add todo',
  body: 'Do it\nSpec: #1\nCovers: AC-1\n',
  state: 'open',
  labels: [{ name: 'factory:planned' }, { name: 'priority:p1' }, { name: 'bug' }],
  ...over,
});

describe('issueToTicket', () => {
  it('maps labels and body lines', () => {
    expect(issueToTicket(issue() as never)).toMatchObject({
      id: 5,
      state: 'planned',
      priority: 1,
      spec: 1,
      covers: ['AC-1'],
      closed: false,
    });
  });

  it('ignores issues without a factory state', () => {
    expect(issueToTicket(issue({ labels: [{ name: 'bug' }] }) as never)).toBeUndefined();
  });
});

describe('GitHubTracker', () => {
  it('lists factory tickets and skips pull requests and other issues', async () => {
    const { gh, calls } = fakeGh({
      'GET repos/o/r/issues?state=open&per_page=100&labels=factory%3Aplanned': () => [
        issue(),
        issue({ number: 6, pull_request: {} }),
        issue({ number: 7, labels: [] }),
      ],
    });
    const list = await new GitHubTracker('o/r', gh).list({ state: 'planned' });
    expect(list.map((t) => t.id)).toEqual([5]);
    expect(calls[0]?.paginate).toBe(true);
  });

  it('keeps non-factory labels and rewrites body lines on update', async () => {
    const { gh, calls } = fakeGh({
      'GET repos/o/r/issues/5': () => issue({ labels: [{ name: 'factory:planned' }, { name: 'bug' }] }),
      'PATCH repos/o/r/issues/5': (req) => ({ ...issue(), ...(req.body as object), labels: (req.body as { labels: string[] }).labels }),
    });
    const tracker = new GitHubTracker('o/r', gh);
    const t = await tracker.get(5);
    await tracker.update({ ...t, state: 'designed', pr: 9, round: 1 });
    const body = calls.at(-1)?.body as { labels: string[]; body: string; state: string };
    expect(body.labels).toEqual(['bug', 'factory:designed', 'priority:p2', 'round:1']);
    expect(body.body).toContain('PR: #9');
    expect(body.body).toContain('Do it');
    expect(body.state).toBe('open');
  });

  it('turns a 404 into NotFoundError', async () => {
    const { gh } = fakeGh({});
    await expect(new GitHubTracker('o/r', gh).get(99)).rejects.toThrow(NotFoundError);
  });

  it('creates only missing labels on setup', async () => {
    const { gh, calls } = fakeGh({
      'GET repos/o/r/labels?per_page=100': () => [{ name: 'factory:spec' }],
      'POST repos/o/r/labels': () => ({}),
    });
    await new GitHubTracker('o/r', gh).setup();
    const created = calls.filter((c) => c.method === 'POST').map((c) => (c.body as { name: string }).name);
    expect(created).not.toContain('factory:spec');
    expect(created).toContain('factory:planned');
    expect(created).toContain('risky');
  });

  it('creates an issue with labels and link lines', async () => {
    const { gh, calls } = fakeGh({
      'POST repos/o/r/issues': (req) => {
        const b = req.body as { title: string; body: string; labels: string[] };
        return { number: 12, title: b.title, body: b.body, state: 'open', labels: b.labels };
      },
    });
    const t = await new GitHubTracker('o/r', gh).create({
      title: 'Add todo',
      body: 'Do it',
      type: 'build',
      state: 'planned',
      priority: 1,
      risky: true,
      components: ['ui'],
      blockedBy: [3],
      covers: ['AC-1'],
      spec: 1,
    });
    expect(t).toMatchObject({ id: 12, state: 'planned', risky: true, blockedBy: [3], spec: 1, components: ['ui'] });
    expect((calls[0]?.body as { body: string }).body).toBe('Do it\nSpec: #1\nCovers: AC-1\nBlocked by: #3\n');
  });

  it('starts the orphan evidence branch on first upload', async () => {
    const { gh, calls } = fakeGh({
      'POST repos/o/r/git/trees': () => ({ sha: 'tree1' }),
      'POST repos/o/r/git/commits': () => ({ sha: 'commit1' }),
      'POST repos/o/r/git/refs': () => ({}),
      'PUT repos/o/r/contents/5/result.txt': () => ({ content: { html_url: 'https://x/5/result.txt' } }),
    });
    const url = await new GitHubTracker('o/r', gh).upload(5, 'result.txt', Buffer.from('ok'));
    expect(url).toBe('https://x/5/result.txt');
    const commit = calls.find((c) => c.path.endsWith('git/commits'));
    expect((commit?.body as { parents: string[] }).parents).toEqual([]);
    const put = calls.at(-1)?.body as { content: string; branch: string };
    expect(put.branch).toBe('factory-evidence');
    expect(Buffer.from(put.content, 'base64').toString()).toBe('ok');
  });
});

describe('GitHubCodeHost.merge', () => {
  it('merges over REST, pinned to the head commit', async () => {
    const { gh, calls } = fakeGh({ 'PUT repos/o/r/pulls/7/merge': () => ({ merged: true }) });
    await new GitHubCodeHost('o/r', gh).merge(7, 'abc', 'squash');
    expect(calls).toEqual([{ method: 'PUT', path: 'repos/o/r/pulls/7/merge', body: { sha: 'abc', merge_method: 'squash' } }]);
  });
});

describe('GitHubCodeHost.updateBranch', () => {
  it('merges main into the PR over REST, pinned to the head commit, and reads behind', async () => {
    const { gh, calls } = fakeGh({
      'PUT repos/o/r/pulls/7/update-branch': () => ({ message: 'Updating pull request branch.' }),
      'GET repos/o/r/pulls/7': () => ({ number: 7, html_url: 'u', head: { ref: 'b', sha: 'abc' }, state: 'open', merged_at: null, mergeable_state: 'behind' }),
    });
    const host = new GitHubCodeHost('o/r', gh);
    await host.updateBranch(7, 'abc');
    expect(calls[0]).toEqual({ method: 'PUT', path: 'repos/o/r/pulls/7/update-branch', body: { expected_head_sha: 'abc' } });
    expect((await host.getPr(7)).behind).toBe(true);
  });
});
