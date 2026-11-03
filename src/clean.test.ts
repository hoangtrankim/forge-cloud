import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clean, gitIn, parseWorktrees } from './clean.js';
import { run } from './cli.js';
import { Factory } from './factory.js';
import { MemoryTracker } from './tracker/memory.js';

// A real clone layout: repo/ is the main checkout, worktrees/ticket-N sit next to it.
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'forge-clean-'));
  const dir = join(root, 'repo');
  const sh = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  sh('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  for (const n of [1, 2, 4]) sh('worktree', 'add', '-q', '-b', `ticket-${n}`, join(root, 'worktrees', `ticket-${n}`));
  sh('branch', 'ticket-3');
  sh('branch', 'feature');
  // Someone deleted this worktree's folder by hand; git still lists it until pruned.
  rmSync(join(root, 'worktrees', 'ticket-4'), { recursive: true });
  const branches = () => sh('for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean).sort();
  return { root, dir, branches };
}

describe('parseWorktrees', () => {
  it('reads paths and branches, with a detached worktree having none', () => {
    const out = 'worktree /a\nHEAD 1\nbranch refs/heads/main\n\nworktree /b\nHEAD 2\ndetached\n\nworktree /c\nHEAD 3\nbranch refs/heads/ticket-9\n';
    expect(parseWorktrees(out)).toEqual([{ path: '/a', branch: 'main' }, { path: '/b' }, { path: '/c', branch: 'ticket-9' }]);
  });
});

describe('clean', () => {
  const done = (ids: number[]) => async (n: number) => ids.includes(n);

  it('removes the worktrees and branches of done tickets only', async () => {
    const { root, dir, branches } = repo();
    const dry = await clean(gitIn(dir), done([1, 3, 4]), { dryRun: true });
    expect(dry.branches.sort()).toEqual(['ticket-1', 'ticket-3', 'ticket-4']);
    expect(branches()).toContain('ticket-1');

    const r = await clean(gitIn(dir), done([1, 3, 4]));
    expect(r.worktrees.map((w) => w.replace(/.*worktrees\//, ''))).toEqual(['ticket-1', 'ticket-4']);
    expect(r.branches.sort()).toEqual(['ticket-1', 'ticket-3', 'ticket-4']);
    expect(existsSync(join(root, 'worktrees', 'ticket-1'))).toBe(false);
    expect(existsSync(join(root, 'worktrees', 'ticket-2'))).toBe(true);
    expect(branches()).toEqual(['feature', 'main', 'ticket-2']);

    expect(await clean(gitIn(dir), done([1, 3, 4]))).toEqual({ worktrees: [], branches: [] });
  });

  it('never touches the main checkout, even on a done ticket branch', async () => {
    const { dir, branches } = repo();
    execFileSync('git', ['checkout', '-q', 'ticket-3'], { cwd: dir });
    const r = await clean(gitIn(dir), done([3]));
    expect(r).toEqual({ worktrees: [], branches: [] });
    expect(branches()).toContain('ticket-3');
  });

  it('runs as forge clean, asking the tracker which tickets are done', async () => {
    const { dir, branches } = repo();
    const tracker = new MemoryTracker();
    const factory = new Factory(tracker);
    await factory.create({ title: 'Spec', type: 'spec', body: '- AC-1: x' }, 'grill');
    const lines: string[] = [];
    // Tracker ids 1..4 do not exist yet except the spec (#1, not done): nothing is removed.
    await run(['clean'], { tracker, cwd: dir, out: (s) => lines.push(s) });
    expect(lines).toEqual(['Nothing to clean.']);
    expect(branches()).toContain('ticket-1');

    const done1 = { ...(await tracker.get(1)), state: 'done' as const };
    await tracker.update(done1);
    lines.length = 0;
    await run(['clean', '--dry-run'], { tracker, cwd: dir, out: (s) => lines.push(s) });
    expect(lines.join('\n')).toMatch(/Would remove worktree .*ticket-1\nWould remove branch ticket-1/);
    await run(['clean'], { tracker, cwd: dir, out: () => {} });
    expect(branches()).not.toContain('ticket-1');
  });
});
