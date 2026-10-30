import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Check, CodeHost, PullRequest } from './codehost.js';
import { Dispatcher, Lock } from './dispatch.js';
import { Factory } from './factory.js';
import { specStatus, type Ticket } from './lifecycle.js';
import { JsonlLog } from './logs.js';
import { route, waitingOnOwner, type Snapshot } from './router.js';
import { parseResult, type AgentRunner, type RunRequest } from './runner.js';
import { MemoryTracker } from './tracker/memory.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';

function ticket(over: Partial<Ticket> = {}): Ticket {
  return {
    id: 10, title: 't', body: '', type: 'build', state: 'planned', priority: 2, round: 0, risky: false,
    testsReady: false, gates: {}, components: [], blockedBy: [], covers: ['AC-1'], spec: 1, closed: false, ...over,
  };
}

const spec = (over: Partial<Ticket> = {}) => ticket({ id: 1, type: 'spec', state: 'spec', body: '- AC-1: x', covers: [], spec: undefined, ...over });

function snap(tickets: Ticket[], over: Partial<Snapshot> = {}): Snapshot {
  const specs = tickets.filter((t) => t.type === 'spec' && !t.closed).map((s) => ({ spec: s, status: specStatus(s, tickets) }));
  return { tickets, specs, prs: new Map(), reported: new Map(), ...over };
}

describe('route', () => {
  it('splits an uncovered spec before anything else', () => {
    expect(route(snap([spec(), ticket({ id: 2, covers: ['AC-9'] })]))).toMatchObject({ agent: 'planner', ticket: 1, rule: 'split-spec' });
  });

  it('sends each state to its agent', () => {
    const cases: Array<[Partial<Ticket>, string]> = [
      [{ state: 'planned' }, 'designer'],
      [{ state: 'designed' }, 'qa-writer'],
      [{ state: 'designed', testsReady: true }, 'builder'],
      [{ state: 'building', round: 1 }, 'builder'],
      [{ state: 'in-review', pr: 5 }, 'reviewer'],
      [{ state: 'in-review', pr: 5, risky: true }, 'security'],
      [{ state: 'in-review', pr: 5, risky: true, gates: { security: 'pass' } }, 'reviewer'],
    ];
    for (const [over, agent] of cases) {
      expect(route(snap([spec(), ticket(over)])), JSON.stringify(over)).toMatchObject({ agent, ticket: 10 });
    }
  });

  it('finishes work before starting new work, and respects blockers and priority', () => {
    const tickets = [spec(), ticket({ id: 2, state: 'planned', priority: 0 }), ticket({ id: 3, state: 'in-review', pr: 7 })];
    expect(route(snap(tickets))).toMatchObject({ agent: 'reviewer', ticket: 3 });
    const blocked = [spec(), ticket({ id: 4, state: 'designed', testsReady: true, blockedBy: [5] }), ticket({ id: 5, state: 'in-qa', pr: 8 })];
    expect(route(snap(blocked))).toBeUndefined();
  });

  it('reports QA once per head SHA, merges it when green, and marks a merged PR done', () => {
    const t = ticket({ state: 'in-qa', pr: 5, reviewedSha: 'abc' });
    const prs = new Map([[10, { headSha: 'abc', merged: false, checksDone: true, checksGreen: true }]]);
    expect(route(snap([spec(), t], { prs }))).toMatchObject({ agent: 'qa-reporter' });
    expect(route(snap([spec(), t], { prs: new Map([[10, { headSha: 'abc', merged: false, checksDone: false, checksGreen: false }]]) }))).toBeUndefined();
    const reported = new Map([[10, new Set(['abc'])]]);
    expect(route(snap([spec(), t], { prs, reported }))).toEqual({ kind: 'merge', ticket: 10, rule: 'merge-green' });
    const merged = new Map([[10, { headSha: 'abc', merged: true, checksDone: false, checksGreen: false }]]);
    expect(route(snap([spec(), t], { prs: merged }))).toEqual({ kind: 'mark-done', ticket: 10, rule: 'merged-pr' });
  });

  it('never merges a red PR, and shows it to the owner', () => {
    const t = ticket({ state: 'in-qa', pr: 5, reviewedSha: 'abc' });
    const prs = new Map([[10, { headSha: 'abc', merged: false, checksDone: true, checksGreen: false }]]);
    const reported = new Map([[10, new Set(['abc'])]]);
    expect(route(snap([spec(), t], { prs, reported }))).toBeUndefined();
    expect(waitingOnOwner(snap([spec(), t], { prs, reported })).needsHuman).toEqual([10]);
  });

  it('sends a PR that changed after its review back to review, before QA or merge', () => {
    const t = ticket({ state: 'in-qa', pr: 5, reviewedSha: 'abc' });
    const prs = new Map([[10, { headSha: 'def', merged: false, checksDone: true, checksGreen: true }]]);
    const reported = new Map([[10, new Set(['def'])]]);
    expect(route(snap([spec(), t], { prs, reported }))).toEqual({ kind: 're-review', ticket: 10, rule: 'pushed-after-review' });
    const legacy = ticket({ state: 'in-qa', pr: 5 });
    expect(route(snap([spec(), legacy], { prs }))).toMatchObject({ kind: 're-review' });
  });

  it('brings main into a reviewed PR that is behind, before QA or merge', () => {
    const t = ticket({ state: 'in-qa', pr: 5, reviewedSha: 'abc' });
    const prs = new Map([[10, { headSha: 'abc', merged: false, checksDone: true, checksGreen: true, behind: true }]]);
    expect(route(snap([spec(), t], { prs }))).toEqual({ kind: 'update-branch', ticket: 10, rule: 'behind-main' });
    expect(route(snap([spec(), t], { prs, reported: new Map([[10, new Set(['abc'])]]) }))).toMatchObject({ kind: 'update-branch' });
  });

  it('closes a spec whose tickets are all done, and skips what it was told to', () => {
    const tickets = [spec(), ticket({ state: 'done', closed: true })];
    expect(route(snap(tickets))).toMatchObject({ agent: 'planner', rule: 'close-spec' });
    expect(route(snap([spec(), ticket()]), new Set(['designer:10']))).toBeUndefined();
  });

  it('leaves blocked and needs-human tickets to the owner', () => {
    const tickets = [spec(), ticket({ state: 'needs-human' }), ticket({ id: 11, state: 'blocked' })];
    expect(route(snap(tickets))).toBeUndefined();
    expect(waitingOnOwner(snap(tickets)).needsHuman).toEqual([10, 11]);
  });
});

class FakeHost implements CodeHost {
  prs = new Map<number, PullRequest>();
  checkRuns: Check[] = [{ name: 'test', status: 'completed', conclusion: 'success', url: 'u' }];
  async findPr() {
    return undefined;
  }
  async openPr(): Promise<PullRequest> {
    throw new Error('unused');
  }
  async getPr(n: number) {
    return this.prs.get(n) ?? { number: n, url: 'u', head: 'h', headSha: SHA, state: 'open' as const, merged: false };
  }
  async diff() {
    return '';
  }
  async checks() {
    return this.checkRuns;
  }
  statuses: Array<[string, string, string]> = [];
  async setStatus(sha: string, context: string, state: string) {
    this.statuses.push([sha, context, state]);
  }
  merges: Array<[number, string, string]> = [];
  refuse?: string;
  async merge(n: number, sha: string, method: string) {
    if (this.refuse) throw new Error(this.refuse);
    this.merges.push([n, sha, method]);
    this.prs.set(n, { ...(await this.getPr(n)), state: 'closed', merged: true });
  }
  updates: Array<[number, string]> = [];
  conflict?: string;
  async updateBranch(n: number, sha: string) {
    if (this.conflict) throw new Error(this.conflict);
    this.updates.push([n, sha]);
    this.prs.set(n, { ...(await this.getPr(n)), headSha: 'f'.repeat(40), behind: false });
  }
}

// Plays each agent by applying the move its prompt would make.
class ScriptedRunner implements AgentRunner {
  calls: RunRequest[] = [];
  constructor(private readonly act: (agent: string, ticket: number) => Promise<void>) {}
  async run(req: RunRequest) {
    this.calls.push(req);
    await this.act(req.agent, Number(/(\d+)/.exec(req.prompt)![1]));
    return { ok: true, exitCode: 0, durationMs: 1, summary: `${req.agent} done` };
  }
}

describe('Dispatcher', () => {
  async function setup(act: (f: Factory, host: FakeHost, agent: string, n: number) => Promise<void>) {
    const tracker = new MemoryTracker();
    const host = new FakeHost();
    const factory = new Factory(tracker, { codeHost: host });
    await factory.create({ title: 'Spec', type: 'spec', body: '- AC-1: x' }, 'grill');
    await factory.create({ title: 'Add', spec: 1, covers: ['AC-1'] }, 'planner');
    const runner = new ScriptedRunner((agent, n) => act(factory, host, agent, n));
    const dir = mkdtempSync(join(tmpdir(), 'factory-logs-'));
    const lines: string[] = [];
    const d = new Dispatcher({ tracker, factory, codeHost: host, runner, cwd: '.', log: new JsonlLog(dir), out: (s) => lines.push(s) });
    return { tracker, host, factory, runner, d, dir, lines };
  }

  const happyPath = async (f: Factory, host: FakeHost, agent: string, n: number) => {
    if (agent === 'factory-designer') await f.move(n, { to: 'designed', role: 'designer' });
    if (agent === 'factory-qa-writer') await f.markTestsReady(n, 'qa-writer');
    if (agent === 'factory-builder') {
      await f.move(n, { to: 'building', role: 'builder' });
      await f.move(n, { to: 'in-review', role: 'builder', pr: 5 });
    }
    if (agent === 'factory-reviewer') await f.move(n, { to: 'in-qa', role: 'reviewer', sha: SHA });
    if (agent === 'factory-qa-reporter') await f.note(n, 'qa-reporter', `PASS at ${SHA}`);
    if (agent === 'factory-planner') await f.closeSpec(1, 'planner');
    void host;
  };

  it('runs a ticket through review and QA, merges it, then finishes the spec', async () => {
    const { d, runner, host, tracker, dir } = await setup(happyPath);
    const r = await d.run();
    expect(runner.calls.map((c) => c.agent)).toEqual([
      'factory-designer', 'factory-qa-writer', 'factory-builder', 'factory-reviewer', 'factory-qa-reporter', 'factory-planner',
    ]);
    expect(r).toMatchObject({ merged: [2], stoppedBy: 'idle' });
    expect(runner.calls[0]!.prompt).toBe('Ticket 2 (spec 1). Follow your prompt.');
    expect(host.merges).toEqual([[5, SHA, 'merge']]);
    expect(await tracker.get(2)).toMatchObject({ state: 'done', closed: true });
    expect((await tracker.get(1)).closed).toBe(true);

    const runs = readFileSync(join(dir, 'runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(runs).toHaveLength(6);
    expect(runs[0]).toMatchObject({ ticket: 2, agent: 'designer', rule: 'design', ok: true, changed: true });
  });

  it('marks a PR the owner merged by hand done', async () => {
    const { d, host, tracker } = await setup(async (f, h, agent, n) => {
      if (agent === 'factory-qa-reporter') {
        h.prs.set(5, { number: 5, url: 'u', head: 'ticket-2', headSha: SHA, state: 'closed', merged: true });
      } else await happyPath(f, h, agent, n);
    });
    const r = await d.run();
    expect(r).toMatchObject({ merged: [], markedDone: [2] });
    expect(host.merges).toEqual([]);
    expect((await tracker.get(2)).state).toBe('done');
  });

  it('hands a PR GitHub refuses to merge to a human', async () => {
    const { d, host, tracker, lines } = await setup(happyPath);
    host.refuse = 'HTTP 405: Head branch is out of date';
    const r = await d.run();
    expect(r).toMatchObject({ merged: [], needsHuman: [2] });
    expect((await tracker.get(2)).state).toBe('needs-human');
    expect(tracker.posted.get(2)?.at(-1)).toContain('could not merge: GitHub refused to merge PR #5: HTTP 405');
    expect(lines.join('\n')).toContain('#2 could not merge');
  });

  it('reviews again when the builder pushes after the review', async () => {
    const pushed = 'e'.repeat(40);
    const { d, runner, host, tracker } = await setup(async (f, h, agent, n) => {
      if (agent === 'factory-reviewer') {
        const head = (await h.getPr(5)).headSha;
        await f.move(n, { to: 'in-qa', role: 'reviewer', sha: head });
        // The first time, a push lands right after the review.
        if (head === SHA) h.prs.set(5, { number: 5, url: 'u', head: 'ticket-2', headSha: pushed, state: 'open', merged: false });
      } else if (agent === 'factory-qa-reporter') await f.note(n, 'qa-reporter', `PASS at ${(await h.getPr(5)).headSha}`);
      else await happyPath(f, h, agent, n);
    });
    const r = await d.run();
    expect(runner.calls.map((c) => c.agent).slice(-4)).toEqual(['factory-reviewer', 'factory-reviewer', 'factory-qa-reporter', 'factory-planner']);
    expect(r.merged).toEqual([2]);
    expect(host.merges).toEqual([[5, pushed, 'merge']]);
    expect(host.statuses.map((s) => s[0])).toEqual([SHA, pushed]);
    void tracker;
  });

  it('brings main into a PR that is behind, reviews the new head, then merges it', async () => {
    const { d, runner, host, tracker, lines } = await setup(async (f, h, agent, n) => {
      if (agent === 'factory-reviewer') {
        const head = (await h.getPr(5)).headSha;
        await f.move(n, { to: 'in-qa', role: 'reviewer', sha: head });
        // Main moves on while the first review runs.
        if (head === SHA) h.prs.set(5, { number: 5, url: 'u', head: 'ticket-2', headSha: SHA, state: 'open', merged: false, behind: true });
      } else if (agent === 'factory-qa-reporter') await f.note(n, 'qa-reporter', `PASS at ${(await h.getPr(5)).headSha}`);
      else await happyPath(f, h, agent, n);
    });
    const r = await d.run();
    expect(host.updates).toEqual([[5, SHA]]);
    expect(runner.calls.map((c) => c.agent).slice(-4)).toEqual(['factory-reviewer', 'factory-reviewer', 'factory-qa-reporter', 'factory-planner']);
    expect(host.merges).toEqual([[5, 'f'.repeat(40), 'merge']]);
    expect(r.merged).toEqual([2]);
    expect((await tracker.get(2)).round).toBe(0);
    expect(lines.join('\n')).toContain('#2 updated with main (PR #5), back to review');
  });

  it('hands a PR that cannot take main to a human', async () => {
    const { d, host, tracker } = await setup(async (f, h, agent, n) => {
      await happyPath(f, h, agent, n);
      if (agent === 'factory-reviewer') h.prs.set(5, { number: 5, url: 'u', head: 'ticket-2', headSha: SHA, state: 'open', merged: false, behind: true });
    });
    host.conflict = 'HTTP 422: merge conflict';
    const r = await d.run();
    expect(r).toMatchObject({ merged: [], needsHuman: [2] });
    expect(tracker.posted.get(2)?.at(-1)).toContain('could not bring main into PR #5: HTTP 422: merge conflict');
  });

  it('stops when claude is not logged in, instead of skipping the ticket', async () => {
    const { tracker, factory, host } = await setup(happyPath);
    const runner: AgentRunner = {
      run: async () => ({ ok: false, exitCode: 1, durationMs: 1, summary: 'Failed to authenticate: OAuth session expired and could not be refreshed' }),
    };
    const lines: string[] = [];
    const d = new Dispatcher({ tracker, factory, codeHost: host, runner, cwd: '.', out: (s) => lines.push(s) });
    const r = await d.run({ watch: true });
    expect(r).toMatchObject({ stoppedBy: 'auth', stuck: [] });
    expect(r.runs).toHaveLength(1);
    expect(lines.join('\n')).toContain('claude auth login');
  });

  it('gives up on an agent that changes nothing, until the ticket changes', async () => {
    const { d, runner, lines } = await setup(async () => {});
    const r = await d.run();
    expect(runner.calls).toHaveLength(1);
    expect(r.stuck).toEqual(['designer:2']);
    expect(lines.join('\n')).toContain('stuck');
  });

  it('stops at max runs and can dry-run', async () => {
    const { d, runner } = await setup(happyPath);
    expect(await d.run({ dryRun: true })).toMatchObject({ stoppedBy: 'dry-run', next: { agent: 'designer', ticket: 2 } });
    expect(runner.calls).toHaveLength(0);
    expect(await d.run({ maxRuns: 2 })).toMatchObject({ stoppedBy: 'max-runs' });
    expect(runner.calls).toHaveLength(2);
  });
});

describe('runner and lock', () => {
  it('reads claude -p JSON output', () => {
    const out = JSON.stringify({ result: 'did things\nMoved #3 to in-review, PR #6', is_error: false, session_id: 's', total_cost_usd: 0.42, num_turns: 9 });
    expect(parseResult(out, '', 0, 5)).toEqual({ ok: true, exitCode: 0, durationMs: 5, summary: 'Moved #3 to in-review, PR #6', sessionId: 's', costUsd: 0.42, turns: 9 });
    expect(parseResult('not json', 'boom', 1, 5)).toMatchObject({ ok: false, summary: 'boom' });
  });

  it('allows one dispatcher at a time', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'factory-lock-')), 'dispatch.lock');
    const a = new Lock(file);
    a.acquire();
    expect(() => new Lock(file).acquire()).toThrow(/another dispatcher/);
    a.release();
    new Lock(file).acquire();
  });
});

describe('ClaudeRunner', () => {
  it('passes the prompt on stdin, after variadic flags', async () => {
    const { ClaudeRunner } = await import('./runner.js');
    // A stand-in for claude that echoes its stdin and args as the JSON result.
    const dir = mkdtempSync(join(tmpdir(), 'factory-claude-'));
    const bin = join(dir, 'claude');
    const { writeFileSync, chmodSync } = await import('node:fs');
    writeFileSync(bin, `#!/usr/bin/env node
let input = '';
process.stdin.on('data', (d) => (input += d)).on('end', () =>
  console.log(JSON.stringify({ result: input + ' | ' + process.argv.slice(2).join(' '), is_error: false })));
`);
    chmodSync(bin, 0o755);
    const r = await new ClaudeRunner(bin).run({ agent: 'factory-designer', prompt: 'Ticket 8.', cwd: dir });
    expect(r.ok).toBe(true);
    expect(r.summary).toBe('Ticket 8. | -p --agent factory-designer --output-format json --permission-mode acceptEdits --allowedTools Bash');
    const guarded = await new ClaudeRunner(bin).run({ agent: 'factory-reviewer', prompt: 'Ticket 8.', cwd: dir });
    expect(guarded.summary).toMatch(/--agent factory-reviewer --output-format json --settings \{"hooks":\{"PreToolUse".*guard"\}\]\}\]\}\} --permission-mode/);
  });
});
