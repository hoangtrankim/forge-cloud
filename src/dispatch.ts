// The dispatcher: reads the tickets, asks the router for the next step, runs that agent, and
// repeats. One agent at a time on one runner machine. It merges a PR itself once the reviewed
// commit is green and the qa-reporter has posted its evidence; a PR the owner merged by hand
// is marked done too.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CodeHost } from './codehost.js';
import type { Factory } from './factory.js';
import { PASSED_CONCLUSIONS, specStatus, type Ticket } from './lifecycle.js';
import type { JsonlLog } from './logs.js';
import { route, routeAll, waitingOnOwner, type PrFacts, type Snapshot, type Step } from './router.js';
import type { AgentRunner, RunResult } from './runner.js';
import type { Tracker } from './tracker/tracker.js';

export interface DispatchOptions {
  maxRuns?: number;
  // Keep polling for merges and new specs instead of stopping when nothing can move.
  watch?: boolean;
  intervalMs?: number;
  // Print the next step without running it.
  dryRun?: boolean;
}

export interface RunRecord {
  step: Step & { kind: 'agent' };
  result: RunResult;
  changed: boolean;
}

export interface DispatchReport {
  next?: Step;
  runs: RunRecord[];
  merged: number[];
  markedDone: number[];
  stuck: string[];
  needsHuman: number[];
  stoppedBy: 'idle' | 'max-runs' | 'dry-run' | 'auth';
}

export interface GateReport {
  // The rule steps that were due, in the order they ran.
  steps: Step[];
  merged: number[];
  markedDone: number[];
  needsHuman: number[];
}

export interface DispatcherDeps {
  tracker: Tracker;
  factory: Factory;
  codeHost: CodeHost;
  runner: AgentRunner;
  cwd: string;
  log?: JsonlLog;
  out?: (s: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

const AUTH_FAILURE = /failed to authenticate|not logged in|invalid api key|please run \/login|oauth/i;

const fingerprint = (t: Ticket | undefined) =>
  t ? JSON.stringify([t.state, t.round, t.testsReady, t.gates, t.pr, t.reviewedSha, t.risky, t.blockedBy, t.closed]) : '';

export class Dispatcher {
  constructor(private readonly d: DispatcherDeps) {}

  private out(s: string) {
    this.d.out?.(s);
  }

  async snapshot(): Promise<Snapshot> {
    const tickets = await this.d.tracker.list({ includeClosed: true });
    const specs = tickets.filter((t) => t.type === 'spec' && !t.closed).map((spec) => ({ spec, status: specStatus(spec, tickets) }));
    const prs = new Map<number, PrFacts>();
    const reported = new Map<number, Set<string>>();
    for (const t of tickets.filter((x) => x.type === 'build' && x.state === 'in-qa' && x.pr)) {
      const pr = await this.d.codeHost.getPr(t.pr!);
      const checks = pr.merged ? [] : await this.d.codeHost.checks(pr.number);
      prs.set(t.id, {
        headSha: pr.headSha,
        merged: pr.merged,
        checksDone: checks.length > 0 && checks.every((c) => c.status === 'completed'),
        checksGreen: checks.length > 0 && checks.every((c) => c.status === 'completed' && PASSED_CONCLUSIONS.includes(c.conclusion ?? '')),
        behind: !!pr.behind,
      });
      const notes = (await this.d.tracker.comments(t.id)).filter((c) => c.body.startsWith('**qa-reporter**'));
      reported.set(t.id, new Set(notes.some((c) => c.body.includes(pr.headSha)) ? [pr.headSha] : []));
    }
    return { tickets, specs, prs, reported };
  }

  async run(opts: DispatchOptions = {}): Promise<DispatchReport> {
    const maxRuns = opts.maxRuns ?? 25;
    const report: DispatchReport = { runs: [], merged: [], markedDone: [], stuck: [], needsHuman: [], stoppedBy: 'idle' };
    // "agent:ticket" -> the ticket's fingerprint when that agent last changed nothing.
    const gaveUp = new Map<string, string>();

    for (;;) {
      const snap = await this.snapshot();
      const byId = new Map(snap.tickets.map((t) => [t.id, t]));
      const skip = new Set([...gaveUp].filter(([k, fp]) => fingerprint(byId.get(Number(k.split(':')[1]))) === fp).map(([k]) => k));
      const step = route(snap, skip);
      Object.assign(report, waitingOnOwner(snap));

      if (opts.dryRun) {
        report.next = step;
        report.stoppedBy = 'dry-run';
        return report;
      }
      if (!step) {
        if (!opts.watch) return report;
        await (this.d.sleep ?? sleep)(opts.intervalMs ?? 5 * 60 * 1000);
        continue;
      }
      if (step.kind !== 'agent') {
        await this.runSystemStep(step, snap, report);
        continue;
      }
      if (!opts.watch && report.runs.length >= maxRuns) {
        report.stoppedBy = 'max-runs';
        return report;
      }

      const record = await this.runAgent(step, snap);
      report.runs.push(record);
      // Claude Code is logged out: every later run would fail the same way, so stop and say so.
      if (!record.result.ok && AUTH_FAILURE.test(record.result.summary)) {
        this.out(`  stopping: claude is not logged in on this machine. Run \`claude auth login\`, then start the dispatcher again.`);
        report.stoppedBy = 'auth';
        return report;
      }
      if (!record.changed) {
        const key = `${step.agent}:${step.ticket}`;
        const after = (await this.d.tracker.list({ includeClosed: true })).find((t) => t.id === step.ticket);
        gaveUp.set(key, fingerprint(after));
        report.stuck.push(key);
        this.out(`  stuck: factory-${step.agent} changed nothing on #${step.ticket}; skipping it until the ticket changes`);
      }
    }
  }

  // Agent steps that could run now, one per ticket, in routing order.
  async steps(): Promise<Array<Step & { kind: 'agent' }>> {
    return routeAll(await this.snapshot()).filter((s): s is Step & { kind: 'agent' } => s.kind === 'agent');
  }

  // The merge gate: runs every rule step that is due (merge, mark done, back to review, bring
  // main in), one per ticket, and never an agent. A session dispatcher runs the agents.
  async gate(opts: { dryRun?: boolean; maxSteps?: number } = {}): Promise<GateReport> {
    const report: GateReport = { steps: [], merged: [], markedDone: [], needsHuman: [] };
    // Each step changes its ticket, so the loop ends; the cap guards against a host that
    // reports the same facts after a step (a merge GitHub has not finished, say).
    for (let i = 0; i < (opts.maxSteps ?? 20); i++) {
      // A fresh look each time: merging one PR can leave another behind main.
      const snap = await this.snapshot();
      report.needsHuman = waitingOnOwner(snap).needsHuman;
      const due = routeAll(snap).filter((s): s is Exclude<Step, { kind: 'agent' }> => s.kind !== 'agent');
      if (opts.dryRun) {
        report.steps = due;
        return report;
      }
      const step = due[0];
      if (!step) return report;
      report.steps.push(step);
      await this.runSystemStep(step, snap, report);
    }
    return report;
  }

  private async runSystemStep(step: Exclude<Step, { kind: 'agent' }>, snap: Snapshot, report: Pick<DispatchReport, 'merged' | 'markedDone'>): Promise<void> {
    const t = snap.tickets.find((x) => x.id === step.ticket)!;
    if (step.kind === 'mark-done') {
      await this.d.factory.move(step.ticket, { to: 'done', role: 'system', note: `PR #${t.pr} is merged.` });
      report.markedDone.push(step.ticket);
      this.out(`#${step.ticket} done (PR #${t.pr} merged)`);
      return;
    }
    if (step.kind === 'merge') {
      try {
        await this.d.factory.merge(step.ticket, 'system');
        report.merged.push(step.ticket);
        this.out(`#${step.ticket} merged (PR #${t.pr}) and done`);
      } catch (e) {
        // Behind main, a conflict, or a check the host still wants: a human decides.
        const why = e instanceof Error ? e.message : String(e);
        await this.d.factory.move(step.ticket, { to: 'needs-human', role: 'system', reason: `could not merge: ${why}` });
        this.out(`#${step.ticket} could not merge: ${why}`);
      }
      return;
    }
    const head = snap.prs.get(step.ticket)?.headSha;
    if (step.kind === 're-review') {
      await this.d.factory.move(step.ticket, {
        to: 'in-review',
        role: 'system',
        note: `PR #${t.pr} moved from the reviewed commit ${t.reviewedSha ?? '(none)'} to ${head}, so it needs a new review.`,
      });
      this.out(`#${step.ticket} back to review (PR #${t.pr} changed after its review)`);
      return;
    }
    try {
      await this.d.codeHost.updateBranch(t.pr!, head!);
      await this.d.factory.move(step.ticket, {
        to: 'in-review',
        role: 'system',
        note: `PR #${t.pr} was behind main, so the factory merged main into it. The new head needs a new review.`,
      });
      this.out(`#${step.ticket} updated with main (PR #${t.pr}), back to review`);
    } catch (e) {
      // Usually a conflict with main: a human decides.
      const why = e instanceof Error ? e.message : String(e);
      await this.d.factory.move(step.ticket, { to: 'needs-human', role: 'system', reason: `could not bring main into PR #${t.pr}: ${why}` });
      this.out(`#${step.ticket} could not be updated with main: ${why}`);
    }
  }

  private async runAgent(step: Step & { kind: 'agent' }, before: Snapshot): Promise<RunRecord> {
    const name = `factory-${step.agent}`;
    this.out(`#${step.ticket} ${step.rule}: running ${name}`);
    await this.d.factory.note(step.ticket, 'system', `Started \`${name}\` (${step.rule}).`);
    const commentsBefore = (await this.d.tracker.comments(step.ticket)).length;

    const result = await this.d.runner.run({ agent: name, prompt: step.prompt, cwd: this.d.cwd });

    const after = await this.d.tracker.list({ includeClosed: true });
    const ticketsChanged = JSON.stringify(after.map((t) => [t.id, fingerprint(t)])) !==
      JSON.stringify(before.tickets.map((t) => [t.id, fingerprint(t)]));
    const changed = ticketsChanged || (await this.d.tracker.comments(step.ticket)).length > commentsBefore;

    this.d.log?.write('runs', {
      at: (this.d.now?.() ?? new Date()).toISOString(),
      ticket: step.ticket,
      agent: step.agent,
      rule: step.rule,
      ok: result.ok,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      costUsd: result.costUsd,
      turns: result.turns,
      sessionId: result.sessionId,
      changed,
      summary: result.summary,
    });
    this.out(`  ${result.ok ? 'ok' : `failed (exit ${result.exitCode})`}: ${result.summary}`);
    return { step, result, changed };
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// One dispatcher per repo per machine: a second one would run agents on the same tickets.
export class Lock {
  constructor(private readonly file: string) {}

  acquire(): void {
    if (existsSync(this.file)) {
      const pid = Number(readFileSync(this.file, 'utf8'));
      if (pid && alive(pid)) throw new Error(`another dispatcher is running (pid ${pid}); lock file ${this.file}`);
    }
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, String(process.pid));
  }

  release(): void {
    rmSync(this.file, { force: true });
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
