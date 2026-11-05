// Covers the fixes from the first dry run on todo-app: flawed-test send-backs, plan edits,
// the design note's Public interface, and PRs and CI read over REST.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from './cli.js';
import type { Check, CodeHost, PullRequest } from './codehost.js';
import { RiskFakes } from './testing/fakes.js';
import { loadConfig } from './config.js';
import { Factory, RuleError } from './factory.js';
import { applyMove, canEdit, canMove, canOpenPr, publicInterface, type Ticket } from './lifecycle.js';
import { MemoryTracker } from './tracker/memory.js';

function ticket(over: Partial<Ticket> = {}): Ticket {
  return {
    id: 10, title: 't', body: '', type: 'build', state: 'building', priority: 2, round: 0, risk: 'low',
    testsReady: true, gates: {}, components: [], blockedBy: [], covers: ['AC-1'], spec: 1, closed: false, ...over,
  };
}

class FakeHost extends RiskFakes implements CodeHost {
  prs: PullRequest[] = [];
  checkRuns: Check[] = [];
  async findPr(branch: string) {
    return this.prs.find((p) => p.head === branch);
  }
  async openPr(branch: string): Promise<PullRequest> {
    const pr: PullRequest = { number: 100 + this.prs.length, url: 'u', head: branch, headSha: 'abc', state: 'open', merged: false };
    this.prs.push(pr);
    return pr;
  }
  async getPr(n: number) {
    return this.prs.find((p) => p.number === n)!;
  }
  async diff(n: number) {
    return `diff of #${n}`;
  }
  async checks() {
    return this.checkRuns;
  }
  async setStatus() {}
  merges: Array<[number, string, string]> = [];
  async merge(n: number, sha: string, method: string) {
    this.merges.push([n, sha, method]);
    Object.assign(await this.getPr(n), { state: 'closed', merged: true });
  }
  async updateBranch() {}
  async deleteBranch() {}
}

describe('flawed-test send-back', () => {
  it('lets builder or reviewer send a ticket back to designed, and clears tests-ready', () => {
    const req = { to: 'designed' as const, role: 'builder' as const, reason: 'flawed-test' };
    expect(canMove(ticket(), req)).toEqual({ ok: true });
    expect(canMove(ticket({ state: 'in-review' }), { ...req, role: 'reviewer' })).toEqual({ ok: true });
    const { ticket: t } = applyMove(ticket(), req);
    expect(t).toMatchObject({ state: 'designed', round: 1, testsReady: false });
  });

  it('keeps flawed-test and designed together', () => {
    expect(canMove(ticket(), { to: 'designed', role: 'builder', reason: 'spec-gap' }).ok).toBe(false);
    expect(canMove(ticket({ state: 'in-review' }), { to: 'building', role: 'reviewer', reason: 'flawed-test' }).ok).toBe(false);
  });
});

describe('canEdit and canOpenPr', () => {
  it('allows plan edits before building only, by planner or owner', () => {
    expect(canEdit(ticket({ state: 'planned' }), 'planner').ok).toBe(true);
    expect(canEdit(ticket({ state: 'needs-human' }), 'owner').ok).toBe(true);
    expect(canEdit(ticket({ state: 'building' }), 'planner').ok).toBe(false);
    expect(canEdit(ticket({ state: 'planned' }), 'builder').ok).toBe(false);
  });

  it('lets only the builder open a PR, while building', () => {
    expect(canOpenPr(ticket(), 'builder').ok).toBe(true);
    expect(canOpenPr(ticket(), 'reviewer').ok).toBe(false);
    expect(canOpenPr(ticket({ state: 'designed' }), 'builder').ok).toBe(false);
  });
});

describe('publicInterface', () => {
  it('takes the section from the latest design note, up to the next heading of its level', () => {
    const old = '## Design note\n### Public interface\nold';
    const latest = '## Design note\nInternal stuff\n### Public interface\n- `GET /todos`\n#### Example\nx\n### Internals\nsecret';
    expect(publicInterface([old, 'plain comment', latest])).toBe('### Public interface\n- `GET /todos`\n#### Example\nx');
    expect(publicInterface(['no design here'])).toBeUndefined();
  });
});

describe('Factory edit and PRs', () => {
  async function setup() {
    const tracker = new MemoryTracker();
    const host = new FakeHost();
    const f = new Factory(tracker, { codeHost: host });
    await f.create({ title: 'Spec', type: 'spec', body: 'AC-1' }, 'grill');
    await f.create({ title: 'Add', spec: 1, covers: ['AC-1'], risk: 'high' }, 'planner');
    return { tracker, host, f };
  }

  it('edits only the given fields and says what changed', async () => {
    const { tracker, f } = await setup();
    const t = await f.edit(2, { risk: 'low', blockedBy: [1] }, 'planner', 'Not auth after all.');
    expect(t).toMatchObject({ risk: 'low', blockedBy: [1], title: 'Add' });
    expect(tracker.posted.get(2)?.at(-1)).toContain('edited `risk`, `blockedBy`');
    await expect(f.edit(2, {}, 'planner')).rejects.toThrow(RuleError);
  });

  it('opens one PR per ticket and records it', async () => {
    const { f, host } = await setup();
    await f.move(2, { to: 'designed', role: 'designer' });
    await f.markTestsReady(2, 'qa-writer');
    await f.move(2, { to: 'building', role: 'builder' });
    const pr = await f.openPr(2, 'builder');
    expect(pr.head).toBe('ticket-2');
    expect((await f.openPr(2, 'builder')).number).toBe(pr.number);
    expect(host.prs).toHaveLength(1);
    expect(await f.diff(2)).toBe(`diff of #${pr.number}`);
  });
});

describe('CLI', () => {
  async function harness() {
    const tracker = new MemoryTracker();
    const codeHost = new FakeHost();
    const lines: string[] = [];
    const cwd = mkdtempSync(join(tmpdir(), 'factory-'));
    const exec = (cmd: string) => run(cmd.split(' '), { tracker, codeHost, out: (s) => lines.push(s), cwd });
    await exec('create --as grill --type spec --title Todo --body AC-1');
    await exec('create --as planner --title Add --spec 1 --covers AC-1');
    return { tracker, codeHost, lines, exec, cwd };
  }

  it('shows comments and prints the public interface', async () => {
    const { exec, lines, cwd } = await harness();
    writeFileSync(join(cwd, 'd.md'), '## Design note\n### Public interface\n- POST /todos\n### Plan\nx');
    await exec('move 2 designed --as designer --note-file d.md');
    await exec('show 2 --comments');
    expect(lines.join('\n')).toContain('moved this from `planned` to `designed`');
    lines.length = 0;
    await exec('show 2 --comments --from builder');
    expect(lines.join('\n')).not.toContain('Design note');
    lines.length = 0;
    await exec('show 2 --comments --json');
    expect(JSON.parse(lines.join('\n'))).toMatchObject({ id: 2, comments: [{ author: 'factory' }] });
    await exec('interface 2');
    expect(lines.at(-1)).toBe('### Public interface\n- POST /todos');
  });

  it('exits 3 when a check failed, 4 while pending, 0 when green', async () => {
    const { exec, tracker, codeHost, lines } = await harness();
    await tracker.update({ ...(await tracker.get(2)), pr: 7 });
    codeHost.prs.push({ number: 7, url: 'u', head: 'ticket-2', headSha: 'abc123', state: 'open', merged: false });
    const c = { name: 'test', url: 'u' };
    codeHost.checkRuns = [{ ...c, status: 'completed', conclusion: 'failure' }];
    expect(await exec('checks 2')).toBe(3);
    codeHost.checkRuns = [{ ...c, status: 'in_progress', conclusion: null }];
    expect(await exec('checks 2')).toBe(4);
    codeHost.checkRuns = [{ ...c, status: 'completed', conclusion: 'success' }];
    expect(await exec('checks 2')).toBe(0);
    expect(lines.join('\n')).toContain('PR #7 at abc123');
    codeHost.checkRuns = [];
    expect(await exec('checks 2')).toBe(4);
    codeHost.prs[0]!.merged = true;
    await exec('checks 2 --json');
    expect(JSON.parse(lines.slice(lines.findLastIndex((l) => l.startsWith('{'))).join('\n'))).toMatchObject({ merged: true });
  });

  it('merges a reviewed, green PR for the owner, even a high-risk one, with no hold', async () => {
    const { exec, tracker, codeHost, lines } = await harness();
    const sha = 'a'.repeat(40);
    await tracker.update({ ...(await tracker.get(2)), state: 'in-qa', pr: 7, reviewedSha: sha, risk: 'high' });
    codeHost.prs.push({ number: 7, url: 'u', head: 'ticket-2', headSha: sha, state: 'open', merged: false });
    codeHost.checkRuns = [{ name: 'test', url: 'u', status: 'completed', conclusion: 'failure' }];
    await expect(exec('merge 2 --as owner')).rejects.toThrow(/checks failed: test/);
    codeHost.checkRuns = [{ name: 'test', url: 'u', status: 'completed', conclusion: 'success' }];
    await expect(exec('merge 2 --as qa-reporter')).rejects.toThrow(/only the dispatcher or the owner/);
    expect(codeHost.merges).toEqual([]);
    expect(await exec('merge 2 --as owner')).toBe(0);
    expect(codeHost.merges).toEqual([[7, sha, 'merge']]);
    expect(await tracker.get(2)).toMatchObject({ state: 'done', closed: true });
    const comment = tracker.posted.get(2)?.at(-1) ?? '';
    expect(comment).toContain(`PR #7 merged by the owner (merge) at the reviewed commit ${sha}`);
    expect(lines.at(-1)).toContain('#2');
  });

  it('prints the tier a PR calls for, and why', async () => {
    const { exec, tracker, codeHost, lines } = await harness();
    await tracker.update({ ...(await tracker.get(2)), pr: 7 });
    codeHost.riskYml = 'medium: [server.js]\ndefault: low\n';
    codeHost.changed = [{ path: 'server.js', additions: 4, deletions: 0 }, { path: 'public/a.js', additions: 1, deletions: 0 }];
    await exec('risk 2');
    expect(lines.slice(-2)).toEqual([
      "#2 is medium risk: the ticket says low, PR #7's changes under risk.yml say medium (5 changed lines).",
      '- server.js: medium (matches `server.js`)',
    ]);
    await exec('risk 2 --json');
    expect(JSON.parse(lines.at(-1)!.startsWith('{') ? lines.at(-1)! : lines.slice(lines.findLastIndex((l) => l.startsWith('{'))).join('\n'))).toMatchObject({ planner: 'low', diff: 'medium', tier: 'medium', lines: 5 });
    // Showing the tier changes nothing.
    expect((await tracker.get(2)).risk).toBe('low');
  });

  it('edits risk with --risk, and the old --risky and --not-risky', async () => {
    const { exec, tracker } = await harness();
    await exec('edit 2 --as planner --risky');
    expect((await tracker.get(2)).risk).toBe('high');
    await exec('edit 2 --as planner --not-risky');
    expect((await tracker.get(2)).risk).toBe('low');
    await exec('edit 2 --as planner --risk medium');
    expect((await tracker.get(2)).risk).toBe('medium');
    await expect(exec('edit 2 --as planner --risk huge')).rejects.toThrow(/--risk must be one of low, medium, high/);
  });
});

describe('config components', () => {
  it('reads a component map and the base branch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-'));
    writeFileSync(join(dir, 'factory.config.yml'), 'base: trunk\ncomponents:\n  ui: [public/**]\n  server: server.js\n');
    expect(loadConfig(dir)).toMatchObject({ base: 'trunk', components: { ui: ['public/**'], server: ['server.js'] } });
  });

  it('reads the merge method, and rejects an unknown one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-'));
    expect(loadConfig(dir).mergeMethod).toBe('merge');
    writeFileSync(join(dir, 'factory.config.yml'), 'mergeMethod: squash\n');
    expect(loadConfig(dir).mergeMethod).toBe('squash');
    writeFileSync(join(dir, 'factory.config.yml'), 'mergeMethod: fast-forward\n');
    expect(() => loadConfig(dir)).toThrow(/mergeMethod must be one of/);
    writeFileSync(join(dir, 'factory.config.yml'), '');
    expect(loadConfig(dir).reviewStatus).toBe('reviewer');
    writeFileSync(join(dir, 'factory.config.yml'), 'reviewStatus: gate\n');
    expect(loadConfig(dir).reviewStatus).toBe('gate');
    writeFileSync(join(dir, 'factory.config.yml'), 'reviewStatus: nobody\n');
    expect(() => loadConfig(dir)).toThrow(/reviewStatus must be one of/);
  });

  it('reads the owner and the hold, and rejects bad ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-'));
    expect(loadConfig(dir)).toMatchObject({ owner: undefined, holdHours: 24 });
    writeFileSync(join(dir, 'factory.config.yml'), 'owner: hoangtrankim\nholdHours: 4\n');
    expect(loadConfig(dir)).toMatchObject({ owner: 'hoangtrankim', holdHours: 4 });
    writeFileSync(join(dir, 'factory.config.yml'), 'holdHours: soon\n');
    expect(() => loadConfig(dir)).toThrow(/holdHours must be a number/);
    writeFileSync(join(dir, 'factory.config.yml'), 'owner: "two words"\n');
    expect(() => loadConfig(dir)).toThrow(/owner must be a GitHub login/);
  });

  it('rejects a malformed map', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-'));
    writeFileSync(join(dir, 'factory.config.yml'), 'components: [ui]\n');
    expect(() => loadConfig(dir)).toThrow(/components must map/);
  });
});
