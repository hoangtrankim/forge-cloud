// Local cleanup after merges: the builder and QA writer each leave a worktree for ticket-N
// (`../worktrees/ticket-N`) and a local ticket-N branch. Once the ticket is done, both go.
// Only done tickets are touched, and the clone's main worktree never is.

import { execFileSync } from 'node:child_process';

export type Git = (args: string[]) => string;

export const gitIn =
  (cwd: string): Git =>
  (args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

export interface Worktree {
  path: string;
  branch?: string;
}

// `git worktree list --porcelain`: blocks of lines split by a blank line; the first is the main one.
export function parseWorktrees(porcelain: string): Worktree[] {
  return porcelain
    .split(/\n\s*\n/)
    .map((block) => block.split('\n'))
    .filter((lines) => lines[0]?.startsWith('worktree '))
    .map((lines) => {
      const branch = lines.find((l) => l.startsWith('branch '))?.slice('branch refs/heads/'.length);
      return { path: lines[0]!.slice('worktree '.length), ...(branch ? { branch } : {}) };
    });
}

const ticketOf = (branch: string | undefined) => {
  const m = branch && /^ticket-(\d+)$/.exec(branch);
  return m ? Number(m[1]) : undefined;
};

export interface CleanReport {
  worktrees: string[];
  branches: string[];
}

export async function clean(git: Git, isDone: (ticket: number) => Promise<boolean>, opts: { dryRun?: boolean } = {}): Promise<CleanReport> {
  const report: CleanReport = { worktrees: [], branches: [] };
  const done = new Map<number, boolean>();
  const doneTicket = async (branch: string | undefined) => {
    const n = ticketOf(branch);
    if (n === undefined) return false;
    if (!done.has(n)) done.set(n, await isDone(n));
    return done.get(n)!;
  };

  const [, ...linked] = parseWorktrees(git(['worktree', 'list', '--porcelain']));
  for (const wt of linked) {
    if (!(await doneTicket(wt.branch))) continue;
    if (!opts.dryRun) git(['worktree', 'remove', '--force', wt.path]);
    report.worktrees.push(wt.path);
  }

  // A worktree whose folder was deleted by hand still holds its branch until pruned.
  if (!opts.dryRun) git(['worktree', 'prune']);
  // Git refuses to delete a branch some worktree still has checked out (the main one, say).
  const removed = new Set(report.worktrees);
  const inUse = new Set(
    parseWorktrees(git(['worktree', 'list', '--porcelain']))
      .filter((w) => !removed.has(w.path))
      .map((w) => w.branch),
  );
  const branches = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/ticket-*']).split('\n').filter(Boolean);
  for (const b of branches) {
    if (inUse.has(b) || !(await doneTicket(b))) continue;
    if (!opts.dryRun) git(['branch', '-D', b]);
    report.branches.push(b);
  }
  return report;
}
