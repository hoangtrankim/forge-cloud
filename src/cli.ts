#!/usr/bin/env node
// forge: the only way agents change tickets. Every command that changes something needs --as.

import { readFileSync, realpathSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, resolveRepo } from './config.js';
import { Factory, RuleError } from './factory.js';
import { GATES, PASSED_CONCLUSIONS, ROLES, STATES, isRole, isState, type Gate, type Priority, type Role, type Ticket } from './lifecycle.js';
import { GitHubCodeHost, type CodeHost } from './codehost.js';
import { Dispatcher, Lock } from './dispatch.js';
import { JsonlLog, logDir } from './logs.js';
import { ClaudeRunner, DEFAULT_CLAUDE_ARGS, type AgentRunner } from './runner.js';
import { init } from './init.js';
import { runGuard } from './guard.js';
import { formatReport, loadLogs, reviewerReport } from './report.js';
import { GitHubTracker } from './tracker/github.js';
import type { Tracker } from './tracker/tracker.js';

const USAGE = `Usage: forge <command> [options]

Commands
  init [dir] [--force]                    Install the agents, the grill skill and factory.config.yml
  setup                                   Create the factory labels in the repo
  list [--state S] [--type spec|build] [--all]
  show <id> [--comments [--from role,role]]   --from keeps comments written by those roles
  interface <id>                          Print the Public interface from the design note
  next [--limit N]                        Tickets a builder may start now
  create --as R --title T [--body B | --body-file F] [--type spec]
         [--spec N --covers AC-1,AC-2] [--blocked-by 1,2] [--component C]...
         [--priority p0..p3] [--risky]
  edit <id> --as planner|owner [--title T] [--body-file F] [--blocked-by 1,2]
         [--component C]... [--covers AC-1] [--priority p0..p3] [--risky | --not-risky]
  pr <id> --as builder [--title T] [--body-file F]   Open (or find) the PR for branch ticket-<id>
  diff <id>                               The diff of the ticket's PR
  checks <id>                             CI checks of the PR's head commit, and whether it is merged;
                                          exit 3 if any failed, 4 if pending or none yet
  merge <id> --as owner                   Merge the reviewed commit once every check is green, mark done
                                          (the dispatcher does this itself after the QA report)
  move <id> <state> --as R [--reason R] [--note N | --note-file F] [--pr N] [--sha SHA]
                                          a reviewer's pass to in-qa needs --sha, the commit reviewed
  tests-ready <id> --as qa-writer [--note N | --note-file F]
  gate <id> <gate> pass|fail --as R [--reason R] [--note N | --note-file F]
  note <id> --as R (--note N | --note-file F)   Comment on a ticket
  evidence <id> <file> --as qa-reporter          Upload an evidence file, print its link
  spec-status <id>
  report [--date YYYY-MM-DD | --days N]   The reviewer report from the logs (default: today)
  close-spec <id> --as R
  guard                                   PreToolUse hook: checks a read-only agent's Bash command
                                          (stdin: the hook event, FACTORY_ROLE: the agent's role)
  dispatch [--dry-run] [--max-runs N] [--watch [--interval SECONDS]]
                                          Run the agents ticket by ticket, merging green reviewed
                                          PRs, until a ticket needs a human or nothing can move

Commands that read GitHub use the REST API only, so they work where GraphQL is blocked.

Options
  --repo owner/name   Defaults to FACTORY_REPO, factory.config.yml, then the origin remote
  --json              Print JSON

States: ${STATES.join(', ')}
Roles:  ${ROLES.join(', ')}`;

interface Args {
  positional: string[];
  flags: Map<string, string[]>;
}

const BOOLEAN_FLAGS = new Set(['risky', 'not-risky', 'json', 'all', 'help', 'force', 'comments', 'dry-run', 'watch']);

export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const [name, inline] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    let value = inline;
    if (value === undefined) {
      if (BOOLEAN_FLAGS.has(name)) value = 'true';
      else {
        value = argv[++i];
        if (value === undefined) throw new UsageError(`--${name} needs a value`);
      }
    }
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return { positional, flags };
}

class UsageError extends Error {}

const flag = (a: Args, name: string) => a.flags.get(name)?.at(-1);
const flagAll = (a: Args, name: string) => (a.flags.get(name) ?? []).flatMap((v) => v.split(',')).map((s) => s.trim()).filter(Boolean);

function note(a: Args, cwd = process.cwd()): string | undefined {
  const file = flag(a, 'note-file');
  return file ? readFileSync(resolve(cwd, file), 'utf8') : flag(a, 'note');
}

function role(a: Args): Role {
  const r = flag(a, 'as');
  if (!r) throw new UsageError('--as <role> is required for every change');
  if (!isRole(r)) throw new UsageError(`unknown role "${r}" (${ROLES.join(', ')})`);
  return r;
}

function id(v: string | undefined, what = 'id'): number {
  const n = Number(String(v ?? '').replace(/^#/, ''));
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`expected an issue number for ${what}, got "${v ?? ''}"`);
  return n;
}

function priority(v: string | undefined): Priority | undefined {
  if (v === undefined) return undefined;
  const m = /^p?([0-3])$/.exec(v);
  if (!m) throw new UsageError(`priority must be p0..p3, got "${v}"`);
  return Number(m[1]) as Priority;
}

function summary(t: Ticket): string {
  const bits = [`#${t.id}`, t.state.padEnd(11), `p${t.priority}`, t.title];
  const extra = [
    t.type === 'spec' ? 'spec' : '',
    t.round ? `round ${t.round}` : '',
    t.risky ? 'risky' : '',
    t.testsReady ? 'tests-ready' : '',
    t.pr ? `PR #${t.pr}` : '',
  ].filter(Boolean);
  return bits.join('  ') + (extra.length ? `  [${extra.join(', ')}]` : '');
}

export interface Deps {
  tracker?: Tracker;
  codeHost?: CodeHost;
  runner?: AgentRunner;
  logDir?: string;
  out?: (s: string) => void;
  now?: () => Date;
  cwd?: string;
}

export async function run(argv: string[], deps: Deps = {}): Promise<number> {
  const out = deps.out ?? ((s: string) => console.log(s));
  const a = parseArgs(argv);
  const [cmd, ...rest] = a.positional;
  if (!cmd || flag(a, 'help')) {
    out(USAGE);
    return cmd || flag(a, 'help') ? 0 : 1;
  }

  if (cmd === 'init') {
    const dir = resolve(deps.cwd ?? process.cwd(), rest[0] ?? '.');
    const r = init(dir, { force: flag(a, 'force') === 'true', repo: flag(a, 'repo') });
    for (const f of r.written) out(`wrote   ${f}`);
    for (const f of r.skipped) out(`kept    ${f} (exists; --force to overwrite)`);
    return 0;
  }

  const config = loadConfig(deps.cwd);
  const repo = () => resolveRepo(flag(a, 'repo'), config, deps.cwd);
  const tracker = deps.tracker ?? new GitHubTracker(repo());
  const codeHost = deps.codeHost ?? (deps.tracker ? undefined : new GitHubCodeHost(repo()));
  const log = deps.logDir || !deps.tracker ? new JsonlLog(deps.logDir ?? logDir(repo())) : undefined;
  const factory = new Factory(tracker, {
    maxRounds: config.maxRounds,
    codeHost,
    baseBranch: config.base,
    mergeMethod: config.mergeMethod,
    onEvent: (e) => log?.write('events', e),
  });
  const body = () => {
    const file = flag(a, 'body-file');
    return file ? readFileSync(resolve(deps.cwd ?? process.cwd(), file), 'utf8') : flag(a, 'body');
  };
  const json = flag(a, 'json') === 'true';
  const print = (v: Ticket | Ticket[] | object) => {
    if (json) return out(JSON.stringify(v, null, 2));
    if (Array.isArray(v)) return out(v.length ? v.map(summary).join('\n') : '(none)');
    if ('id' in v && 'state' in v) return out(summary(v as Ticket));
    out(JSON.stringify(v, null, 2));
  };

  switch (cmd) {
    case 'setup':
      await tracker.setup();
      out('Labels are in place.');
      return 0;

    case 'list': {
      const state = flag(a, 'state');
      if (state && !isState(state)) throw new UsageError(`unknown state "${state}"`);
      const type = flag(a, 'type');
      if (type && type !== 'spec' && type !== 'build') throw new UsageError(`--type must be spec or build`);
      print(await tracker.list({ state: state as never, type: type as never, includeClosed: flag(a, 'all') === 'true' }));
      return 0;
    }

    case 'show': {
      const n = id(rest[0]);
      const ticket = await tracker.get(n);
      const from = flagAll(a, 'from');
      const comments =
        flag(a, 'comments') === 'true'
          ? (await factory.comments(n)).filter((c) => !from.length || from.some((r) => c.body.startsWith(`**${r}**`)))
          : undefined;
      if (json) {
        out(JSON.stringify(comments ? { ...ticket, comments } : ticket, null, 2));
        return 0;
      }
      out(summary(ticket));
      const facts = [
        ticket.components.length ? `Components: ${ticket.components.join(', ')}` : '',
        ticket.gates.security ? `Security gate: ${ticket.gates.security}` : '',
      ].filter(Boolean);
      if (facts.length) out(facts.join('\n'));
      if (ticket.body.trim()) out(`\n${ticket.body.trim()}`);
      for (const c of comments ?? []) out(`\n--- ${c.author}, ${c.createdAt}\n${c.body}`);
      return 0;
    }

    case 'interface':
      out(await factory.publicInterface(id(rest[0])));
      return 0;

    case 'edit': {
      const risky = flag(a, 'risky') === 'true' ? true : flag(a, 'not-risky') === 'true' ? false : undefined;
      const list = (name: string) => (a.flags.has(name) ? flagAll(a, name) : undefined);
      print(
        await factory.edit(
          id(rest[0]),
          {
            title: flag(a, 'title'),
            body: body(),
            priority: priority(flag(a, 'priority')),
            risky,
            components: list('component'),
            blockedBy: list('blocked-by')?.map((v) => id(v, '--blocked-by')),
            covers: list('covers'),
          },
          role(a),
          note(a, deps.cwd),
        ),
      );
      return 0;
    }

    case 'pr': {
      const pr = await factory.openPr(id(rest[0]), role(a), flag(a, 'title'), body());
      if (json) out(JSON.stringify(pr, null, 2));
      else out(`PR #${pr.number} ${pr.url}`);
      return 0;
    }

    case 'diff':
      out(await factory.diff(id(rest[0])));
      return 0;

    case 'checks': {
      const result = await factory.checks(id(rest[0]));
      const { checks } = result;
      if (json) out(JSON.stringify(result, null, 2));
      else {
        out(`PR #${result.pr} at ${result.headSha}${result.merged ? ' (merged)' : result.state === 'closed' ? ' (closed)' : ''}`);
        out(
          checks.length
            ? checks.map((c) => `${(c.conclusion ?? c.status).padEnd(10)} ${c.name}${c.runId ? `  run ${c.runId}` : ''}  ${c.url}`).join('\n')
            : '(no checks yet)',
        );
      }
      if (checks.some((c) => c.conclusion && !PASSED_CONCLUSIONS.includes(c.conclusion))) return 3;
      if (!checks.length || checks.some((c) => c.status !== 'completed')) return 4;
      return 0;
    }

    case 'merge':
      print(await factory.merge(id(rest[0]), role(a)));
      return 0;

    case 'next': {
      const limit = flag(a, 'limit');
      print(await factory.next(limit ? id(limit, '--limit') : undefined));
      return 0;
    }

    case 'create': {
      const title = flag(a, 'title');
      if (!title) throw new UsageError('--title is required');
      const type = flag(a, 'type') ?? 'build';
      if (type !== 'spec' && type !== 'build') throw new UsageError(`--type must be spec or build`);
      const spec = flag(a, 'spec');
      print(
        await factory.create(
          {
            title,
            body: body() ?? '',
            type,
            priority: priority(flag(a, 'priority')),
            risky: flag(a, 'risky') === 'true',
            components: flagAll(a, 'component'),
            blockedBy: flagAll(a, 'blocked-by').map((v) => id(v, '--blocked-by')),
            covers: flagAll(a, 'covers'),
            spec: spec ? id(spec, '--spec') : undefined,
          },
          role(a),
        ),
      );
      return 0;
    }

    case 'move': {
      const to = rest[1];
      if (!to || !isState(to)) throw new UsageError(`move <id> <state>: state must be one of ${STATES.join(', ')}`);
      const pr = flag(a, 'pr');
      print(
        await factory.move(id(rest[0]), {
          to,
          role: role(a),
          reason: flag(a, 'reason'),
          note: note(a, deps.cwd),
          pr: pr ? id(pr, '--pr') : undefined,
          sha: flag(a, 'sha'),
        }),
      );
      return 0;
    }

    case 'tests-ready':
      print(await factory.markTestsReady(id(rest[0]), role(a), note(a, deps.cwd)));
      return 0;

    case 'gate': {
      const [ticket, gate, result] = rest;
      if (!gate || !(GATES as readonly string[]).includes(gate)) throw new UsageError(`gate must be one of ${GATES.join(', ')}`);
      if (result !== 'pass' && result !== 'fail') throw new UsageError('gate result must be pass or fail');
      print(await factory.recordGate(id(ticket), gate as Gate, result, role(a), flag(a, 'reason'), note(a, deps.cwd)));
      return 0;
    }

    case 'note': {
      const text = note(a, deps.cwd);
      if (!text) throw new UsageError('note needs --note or --note-file');
      await factory.note(id(rest[0]), role(a), text);
      out('Noted.');
      return 0;
    }

    case 'evidence': {
      const file = rest[1];
      if (!file) throw new UsageError('evidence <id> <file>');
      out(await factory.evidence(id(rest[0]), role(a), basename(file), readFileSync(resolve(deps.cwd ?? process.cwd(), file))));
      return 0;
    }

    case 'report': {
      // A local calendar day (default today), or the last N days with --days.
      const days = flag(a, 'days');
      const date = flag(a, 'date');
      let from: Date;
      let to: Date;
      if (days) {
        to = deps.now?.() ?? new Date();
        from = new Date(to.getTime() - Number(days) * 86400000);
      } else {
        const d = date ? new Date(`${date}T00:00:00`) : (deps.now?.() ?? new Date());
        if (Number.isNaN(d.getTime())) throw new UsageError(`--date must be YYYY-MM-DD`);
        from = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1);
      }
      const { events, runs } = loadLogs(deps.logDir ?? logDir(repo()));
      const r = reviewerReport(events, runs, from, to);
      out(json ? JSON.stringify(r, null, 2) : formatReport(r));
      return 0;
    }

    case 'spec-status':
      print(await factory.specStatus(id(rest[0])));
      return 0;

    case 'close-spec':
      print(await factory.closeSpec(id(rest[0]), role(a)));
      return 0;

    case 'dispatch': {
      if (!codeHost) throw new UsageError('dispatch needs a code host');
      const cwd = deps.cwd ?? process.cwd();
      const dispatcher = new Dispatcher({
        tracker,
        factory,
        codeHost,
        runner: deps.runner ?? new ClaudeRunner('claude', config.claudeArgs ?? DEFAULT_CLAUDE_ARGS),
        cwd,
        log,
        out,
      });
      const dryRun = flag(a, 'dry-run') === 'true';
      const maxRuns = flag(a, 'max-runs');
      const interval = flag(a, 'interval');
      const lock = dryRun ? undefined : new Lock(`${deps.logDir ?? logDir(repo())}/dispatch.lock`);
      lock?.acquire();
      try {
        const r = await dispatcher.run({
          dryRun,
          maxRuns: maxRuns ? id(maxRuns, '--max-runs') : undefined,
          watch: flag(a, 'watch') === 'true',
          intervalMs: interval ? id(interval, '--interval') * 1000 : undefined,
        });
        if (json) out(JSON.stringify(r, null, 2));
        else {
          if (dryRun) {
            const n = r.next;
            out(!n ? 'Nothing can move.' : n.kind === 'mark-done' ? `Next: mark #${n.ticket} done (PR merged)` : n.kind === 'merge' ? `Next: merge the PR of #${n.ticket} (reviewed, green, reported)` : n.kind === 're-review' ? `Next: send #${n.ticket} back to review (PR changed after its review)` : n.kind === 'update-branch' ? `Next: merge main into the PR of #${n.ticket} (behind main), then review again` : `Next: factory-${n.agent} on #${n.ticket} (${n.rule}): "${n.prompt}"`);
          } else {
            out(`\n${r.runs.length} agent run(s); stopped: ${r.stoppedBy}`);
            if (r.merged.length) out(`Merged: ${r.merged.map((n) => `#${n}`).join(', ')}`);
            if (r.markedDone.length) out(`Done: ${r.markedDone.map((n) => `#${n}`).join(', ')}`);
          }
          if (r.needsHuman.length) out(`Waiting on a human: ${r.needsHuman.map((n) => `#${n}`).join(', ')}`);
          if (r.stuck.length) out(`Stuck (agent changed nothing): ${r.stuck.join(', ')}`);
        }
      } finally {
        lock?.release();
      }
      return 0;
    }

    default:
      throw new UsageError(`unknown command "${cmd}"`);
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  // The hook entry point: no repo or config needed, and it must answer fast.
  if (argv[0] === 'guard') {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    const r = runGuard(input, process.env.FACTORY_ROLE);
    if (r.message) console.error(r.message);
    process.exitCode = r.code;
    return;
  }
  try {
    process.exitCode = await run(argv);
  } catch (e) {
    if (e instanceof RuleError) {
      console.error(`refused: ${e.message}`);
      process.exitCode = 2;
    } else if (e instanceof UsageError) {
      console.error(`${e.message}\n\nRun "forge --help" for usage.`);
      process.exitCode = 64;
    } else {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) void main();
