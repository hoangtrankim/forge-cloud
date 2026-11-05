import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from './cli.js';
import { LOG_BRANCH, gitRunIn, pushLogs, readBranchLogs, writerId, type GitRun } from './logbranch.js';
import { MemoryTracker } from './tracker/memory.js';

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// A bare "GitHub" remote and a clone of it with one commit on main.
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'forge-logs-'));
  const remote = join(root, 'remote.git');
  sh(root, 'init', '--quiet', '--bare', remote);
  const clone = (name: string) => {
    const dir = join(root, name);
    sh(root, 'clone', '--quiet', remote, dir);
    sh(dir, 'config', 'user.email', 't@example.com');
    sh(dir, 'config', 'user.name', 't');
    return dir;
  };
  const main = clone('a');
  writeFileSync(join(main, 'README.md'), 'app\n');
  sh(main, 'add', '.');
  sh(main, 'commit', '--quiet', '-m', 'app');
  sh(main, 'push', '--quiet', 'origin', 'HEAD:main');
  const logs = (name: string, events: string[], runs: string[] = []) => {
    const dir = join(root, `logs-${name}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'events.jsonl'), events.map((e) => `${e}\n`).join(''));
    if (runs.length) writeFileSync(join(dir, 'runs.jsonl'), runs.map((e) => `${e}\n`).join(''));
    return dir;
  };
  return { root, remote, main, clone, logs };
}

const ev = (at: string, ticket: number) => JSON.stringify({ at, kind: 'note', ticket, role: 'builder' });

describe('logs branch', () => {
  it('pushes each writer to its own folder and reads every writer back', () => {
    const r = repo();
    const a = pushLogs({ git: gitRunIn(r.main), localDir: r.logs('a', [ev('2026-11-05T01:00:00Z', 1)]), writer: 'host/a' });
    expect(a).toMatchObject({ pushed: true, files: ['events'] });
    const other = r.clone('b');
    const b = pushLogs({
      git: gitRunIn(other),
      localDir: r.logs('b', [ev('2026-11-05T02:00:00Z', 2)], [JSON.stringify({ at: '2026-11-05T02:00:00Z', ticket: 2 })]),
      writer: 'gate/2026-11-05/9-1',
    });
    expect(b).toMatchObject({ pushed: true, files: ['events', 'runs'] });

    const files = sh(r.root, '--git-dir', r.remote, 'ls-tree', '-r', '--name-only', LOG_BRANCH).split('\n').sort();
    expect(files).toEqual(['gate/2026-11-05/9-1/events.jsonl', 'gate/2026-11-05/9-1/runs.jsonl', 'host/a/events.jsonl']);
    // An orphan branch: nothing from main, and main untouched.
    expect(sh(r.root, '--git-dir', r.remote, 'rev-list', '--count', LOG_BRANCH)).toBe('2');
    expect(sh(r.root, '--git-dir', r.remote, 'ls-tree', '--name-only', 'main')).toBe('README.md');
    expect(sh(r.main, 'status', '--porcelain')).toBe('');

    const back = readBranchLogs(gitRunIn(r.main));
    expect(back.read).toBe(true);
    expect(back.events.filter(Boolean).map((l) => JSON.parse(l).ticket).sort()).toEqual([1, 2]);
    expect(back.runs.filter(Boolean)).toHaveLength(1);
  });

  it('does nothing without local logs or when the branch already has them', () => {
    const r = repo();
    const empty = join(r.root, 'none');
    expect(pushLogs({ git: gitRunIn(r.main), localDir: empty, writer: 'host/a' })).toMatchObject({ pushed: false, reason: 'no-logs' });
    const dir = r.logs('a', [ev('2026-11-05T01:00:00Z', 1)]);
    expect(pushLogs({ git: gitRunIn(r.main), localDir: dir, writer: 'host/a' }).pushed).toBe(true);
    expect(pushLogs({ git: gitRunIn(r.main), localDir: dir, writer: 'host/a' })).toMatchObject({ pushed: false, reason: 'up-to-date' });
  });

  it('builds again on top of a push that landed in between', () => {
    const r = repo();
    const other = r.clone('b');
    const otherLogs = r.logs('b', [ev('2026-11-05T02:00:00Z', 2)]);
    let raced = false;
    const base = gitRunIn(r.main);
    const git: GitRun = (args, env) => {
      if (args[0] === 'push' && !raced) {
        raced = true;
        pushLogs({ git: gitRunIn(other), localDir: otherLogs, writer: 'host/b' });
      }
      return base(args, env);
    };
    const res = pushLogs({ git, localDir: r.logs('a', [ev('2026-11-05T01:00:00Z', 1)]), writer: 'host/a' });
    expect(res).toMatchObject({ pushed: true, attempts: 2 });
    const files = sh(r.root, '--git-dir', r.remote, 'ls-tree', '-r', '--name-only', LOG_BRANCH).split('\n').sort();
    expect(files).toEqual(['host/a/events.jsonl', 'host/b/events.jsonl']);
  });

  it('reads nothing, without failing, when the remote is unreachable', () => {
    const r = repo();
    sh(r.main, 'remote', 'set-url', 'origin', join(r.root, 'missing.git'));
    expect(readBranchLogs(gitRunIn(r.main))).toEqual({ events: [], runs: [], read: false });
  });

  it('names the writer by gate run, by override, or by a stable id per log folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-writer-'));
    const now = new Date('2026-11-05T03:00:00Z');
    expect(writerId(dir, { GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '2' }, now)).toBe('gate/2026-11-05/42-2');
    expect(writerId(dir, { FACTORY_LOG_WRITER: 'mac mini/../x' }, now)).toBe('mac-mini/x');
    const id = writerId(dir, {}, now);
    expect(id).toMatch(/^host\/[A-Za-z0-9._-]+-[0-9a-f]{6}$/);
    expect(writerId(dir, {}, now)).toBe(id);
    expect(readFileSync(join(dir, 'writer-id'), 'utf8').trim()).toBe(id);
  });
});

describe('forge log-run, logs push and report', () => {
  it('records a session run, pushes it, and reports from the branch', async () => {
    const r = repo();
    const logDir = join(r.root, 'logs-cli');
    const lines: string[] = [];
    const now = new Date('2026-11-05T04:10:00Z');
    const exec = (cmd: string, cwd = r.main, dir = logDir) =>
      run(cmd.split(' '), { tracker: new MemoryTracker(), out: (s) => lines.push(s), cwd, logDir: dir, now: () => now, env: { FACTORY_LOG_WRITER: 'host/test' } });

    await exec('log-run 7 --agent factory-reviewer --rule review --started 2026-11-05T04:00:00Z --changed --tokens 1200 --summary passed');
    const run1 = JSON.parse(readFileSync(join(logDir, 'runs.jsonl'), 'utf8').trim());
    expect(run1).toMatchObject({ ticket: 7, agent: 'reviewer', rule: 'review', ok: true, durationMs: 600000, tokens: 1200, changed: true, by: 'session' });
    await expect(exec('log-run 7 --agent reviewer --started soon')).rejects.toThrow(/--started/);

    await exec('logs push');
    expect(lines.at(-1)).toBe('Pushed runs to factory-logs as host/test.');

    // Another machine with no local logs still sees the run in its report.
    lines.length = 0;
    await exec('report --date 2026-11-05 --json', r.clone('c'), join(r.root, 'logs-empty'));
    expect(JSON.parse(lines.join('\n')).runs).toMatchObject({ count: 1, minutes: 10 });

    lines.length = 0;
    await exec('report --date 2026-11-05 --json --local', r.clone('d'), join(r.root, 'logs-empty2'));
    expect(JSON.parse(lines.join('\n')).runs.count).toBe(0);
  });
});
