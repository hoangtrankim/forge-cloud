// GitHub Issues adapter. Talks to GitHub only through `gh api`, so it reuses the owner's login.

import { execFile } from 'node:child_process';
import type { Ticket } from '../lifecycle.js';
import { FIXED_LABELS, fromBody, fromLabels, isFactoryLabel, toLabels, withBodyFields } from '../labels.js';
import { NotFoundError, type Comment, type ListFilter, type NewTicket, type Tracker } from './tracker.js';

export const EVIDENCE_BRANCH = 'factory-evidence';

export interface GhRequest {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
  paginate?: boolean;
  // A non-JSON media type (such as a diff) returns the raw text.
  accept?: string;
}

export type GhApi = (req: GhRequest) => Promise<unknown>;

export class GhError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export const ghCli: GhApi = (req) =>
  new Promise((resolve, reject) => {
    const args = ['api', '-X', req.method ?? 'GET', req.path];
    if (req.accept) args.push('-H', `Accept: ${req.accept}`);
    if (req.paginate) args.push('--paginate', '--slurp');
    if (req.body !== undefined) args.push('--input', '-');
    const child = execFile('gh', args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const m = /HTTP (\d{3})/.exec(stderr);
        reject(new GhError(`gh api ${req.path}: ${stderr.trim() || err.message}`, m ? Number(m[1]) : undefined));
        return;
      }
      if (!stdout.trim()) return resolve(undefined);
      if (req.accept && !req.accept.includes('json')) return resolve(stdout);
      const data = JSON.parse(stdout);
      resolve(req.paginate && Array.isArray(data) ? data.flat() : data);
    });
    if (req.body !== undefined) child.stdin?.end(JSON.stringify(req.body));
  });

interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: Array<{ name: string } | string>;
  pull_request?: unknown;
}

const labelNames = (i: GhIssue) => i.labels.map((l) => (typeof l === 'string' ? l : l.name));

export function issueToTicket(issue: GhIssue): Ticket | undefined {
  const f = fromLabels(labelNames(issue));
  if (!f.state) return undefined;
  const body = issue.body ?? '';
  const b = fromBody(body);
  return {
    id: issue.number,
    title: issue.title,
    body,
    type: f.type,
    state: f.state,
    priority: f.priority,
    round: f.round,
    risky: f.risky,
    testsReady: f.testsReady,
    gates: f.gates,
    components: f.components,
    blockedBy: b.blockedBy,
    covers: b.covers,
    spec: b.spec,
    pr: b.pr,
    reviewedSha: b.reviewedSha,
    closed: issue.state === 'closed',
  };
}

export class GitHubTracker implements Tracker {
  constructor(
    private readonly repo: string,
    private readonly gh: GhApi = ghCli,
  ) {}

  private path(p: string) {
    return `repos/${this.repo}/${p}`;
  }

  async setup(): Promise<void> {
    const existing = (await this.gh({ path: this.path('labels?per_page=100'), paginate: true })) as Array<{ name: string }>;
    const have = new Set(existing.map((l) => l.name));
    for (const l of FIXED_LABELS) {
      if (have.has(l.name)) continue;
      await this.gh({ method: 'POST', path: this.path('labels'), body: l });
    }
  }

  async list(filter: ListFilter = {}): Promise<Ticket[]> {
    const params = new URLSearchParams({ state: filter.includeClosed ? 'all' : 'open', per_page: '100' });
    if (filter.state) params.set('labels', `factory:${filter.state}`);
    const issues = (await this.gh({ path: this.path(`issues?${params}`), paginate: true })) as GhIssue[];
    return issues
      .filter((i) => !i.pull_request)
      .map(issueToTicket)
      .filter((t): t is Ticket => !!t)
      .filter((t) => !filter.type || t.type === filter.type);
  }

  private async issue(id: number): Promise<GhIssue> {
    try {
      return (await this.gh({ path: this.path(`issues/${id}`) })) as GhIssue;
    } catch (e) {
      if (e instanceof GhError && e.status === 404) throw new NotFoundError(`#${id} not found`);
      throw e;
    }
  }

  async get(id: number): Promise<Ticket> {
    const t = issueToTicket(await this.issue(id));
    if (!t) throw new NotFoundError(`#${id} is not a factory ticket (no factory: state label)`);
    return t;
  }

  async create(input: NewTicket): Promise<Ticket> {
    const draft: Ticket = { ...input, id: 0, round: 0, testsReady: false, gates: {}, closed: false };
    const issue = (await this.gh({
      method: 'POST',
      path: this.path('issues'),
      body: { title: input.title, body: withBodyFields(input.body, draft), labels: toLabels(draft) },
    })) as GhIssue;
    return issueToTicket(issue)!;
  }

  async update(ticket: Ticket): Promise<Ticket> {
    const current = await this.issue(ticket.id);
    const kept = labelNames(current).filter((l) => !isFactoryLabel(l));
    const issue = (await this.gh({
      method: 'PATCH',
      path: this.path(`issues/${ticket.id}`),
      body: {
        labels: [...kept, ...toLabels(ticket)],
        body: withBodyFields(current.body ?? '', ticket),
        state: ticket.closed ? 'closed' : 'open',
      },
    })) as GhIssue;
    return issueToTicket(issue)!;
  }

  async comment(id: number, body: string): Promise<void> {
    await this.gh({ method: 'POST', path: this.path(`issues/${id}/comments`), body: { body } });
  }

  async comments(id: number): Promise<Comment[]> {
    const list = (await this.gh({ path: this.path(`issues/${id}/comments?per_page=100`), paginate: true })) as Array<{
      user: { login: string } | null;
      body: string | null;
      created_at: string;
    }>;
    return list.map((c) => ({ author: c.user?.login ?? 'ghost', body: c.body ?? '', createdAt: c.created_at }));
  }

  async close(id: number): Promise<void> {
    await this.gh({ method: 'PATCH', path: this.path(`issues/${id}`), body: { state: 'closed', state_reason: 'completed' } });
  }

  // Evidence lives on an orphan branch so it never mixes with code or triggers CI.
  async upload(id: number, name: string, content: Buffer): Promise<string> {
    await this.ensureEvidenceBranch();
    const file = `${id}/${name}`;
    let sha: string | undefined;
    try {
      const existing = (await this.gh({ path: this.path(`contents/${file}?ref=${EVIDENCE_BRANCH}`) })) as { sha: string };
      sha = existing.sha;
    } catch (e) {
      if (!(e instanceof GhError && e.status === 404)) throw e;
    }
    const res = (await this.gh({
      method: 'PUT',
      path: this.path(`contents/${file}`),
      body: { message: `Evidence for #${id}: ${name}`, content: content.toString('base64'), branch: EVIDENCE_BRANCH, sha },
    })) as { content: { html_url: string } };
    return res.content.html_url;
  }

  private async ensureEvidenceBranch(): Promise<void> {
    try {
      await this.gh({ path: this.path(`git/ref/heads/${EVIDENCE_BRANCH}`) });
      return;
    } catch (e) {
      if (!(e instanceof GhError && e.status === 404)) throw e;
    }
    const tree = (await this.gh({
      method: 'POST',
      path: this.path('git/trees'),
      body: {
        tree: [{ path: 'README.md', mode: '100644', type: 'blob', content: '# Factory evidence\n\nQA evidence, one folder per ticket.\n' }],
      },
    })) as { sha: string };
    const commit = (await this.gh({
      method: 'POST',
      path: this.path('git/commits'),
      body: { message: 'Start evidence branch', tree: tree.sha, parents: [] },
    })) as { sha: string };
    await this.gh({
      method: 'POST',
      path: this.path('git/refs'),
      body: { ref: `refs/heads/${EVIDENCE_BRANCH}`, sha: commit.sha },
    });
  }
}
