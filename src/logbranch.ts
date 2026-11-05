// Logs that outlive the machine that wrote them. Each machine (a cloud session, a gate run, the
// owner's Mac) keeps its JSONL logs locally as before, and `forge logs push` copies them to the
// orphan `factory-logs` branch of the target repo under a folder of its own, so two writers never
// touch the same file and a push can always be retried on top of the other's. `forge report`
// reads every writer's files back from the branch. The branch never touches main or the
// worktree: it is built with git plumbing in a throwaway index.

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

export const LOG_BRANCH = 'factory-logs';
const FILES = ['events', 'runs'] as const;
const AUTHOR = { GIT_AUTHOR_NAME: 'forge', GIT_AUTHOR_EMAIL: 'forge@users.noreply.github.com' };
const COMMITTER = { GIT_COMMITTER_NAME: 'forge', GIT_COMMITTER_EMAIL: 'forge@users.noreply.github.com' };

export type GitRun = (args: string[], env?: Record<string, string>) => string;

export const gitRunIn =
  (cwd: string): GitRun =>
  (args, env) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: env ? { ...process.env, ...env } : process.env,
    }).trim();

// The writer's folder on the branch. A gate run gets its own folder per day; any other machine
// keeps one id for its log folder, made once, so its folder is stable and never shared.
export function writerId(localDir: string, env: NodeJS.ProcessEnv = process.env, now = new Date()): string {
  if (env.FACTORY_LOG_WRITER) return clean(env.FACTORY_LOG_WRITER);
  if (env.GITHUB_RUN_ID) return `gate/${now.toISOString().slice(0, 10)}/${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT ?? '1'}`;
  const file = join(localDir, 'writer-id');
  try {
    if (existsSync(file)) return clean(readFileSync(file, 'utf8').trim());
    const id = `host/${clean(hostname()) || 'unknown'}-${randomBytes(3).toString('hex')}`;
    mkdirSync(localDir, { recursive: true });
    writeFileSync(file, `${id}\n`);
    return id;
  } catch {
    return `host/${clean(hostname()) || 'unknown'}`;
  }
}

const clean = (s: string) =>
  s
    .split('/')
    .map((p) => p.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, ''))
    .filter(Boolean)
    .join('/');

export interface PushResult {
  pushed: boolean;
  writer: string;
  files: string[];
  // Why nothing was pushed: no local logs, or the branch already holds them.
  reason?: 'no-logs' | 'up-to-date';
  attempts: number;
}

function remoteHead(git: GitRun, remote: string): string | undefined {
  const line = git(['ls-remote', '--heads', remote, LOG_BRANCH]);
  if (!line) return undefined;
  git(['fetch', '--quiet', '--no-tags', remote, `+refs/heads/${LOG_BRANCH}:refs/remotes/${remote}/${LOG_BRANCH}`]);
  return git(['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${LOG_BRANCH}^{commit}`]);
}

export function pushLogs(opts: { git: GitRun; localDir: string; writer: string; remote?: string; maxAttempts?: number }): PushResult {
  const { git, localDir, writer } = opts;
  const remote = opts.remote ?? 'origin';
  const maxAttempts = opts.maxAttempts ?? 5;
  const files = FILES.filter((f) => {
    const p = join(localDir, `${f}.jsonl`);
    return existsSync(p) && statSync(p).size > 0;
  });
  if (!files.length) return { pushed: false, writer, files: [], reason: 'no-logs', attempts: 0 };

  for (let attempt = 1; ; attempt++) {
    const parent = remoteHead(git, remote);
    const index = join(tmpdir(), `forge-logs-index-${process.pid}-${randomBytes(4).toString('hex')}`);
    const env = { GIT_INDEX_FILE: index };
    try {
      git(parent ? ['read-tree', parent] : ['read-tree', '--empty'], env);
      for (const f of files) {
        const blob = git(['hash-object', '-w', join(localDir, `${f}.jsonl`)]);
        git(['update-index', '--add', '--cacheinfo', `100644,${blob},${writer}/${f}.jsonl`], env);
      }
      const tree = git(['write-tree'], env);
      if (parent && tree === git(['rev-parse', `${parent}^{tree}`])) {
        return { pushed: false, writer, files, reason: 'up-to-date', attempts: attempt };
      }
      const commit = git(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', `Logs from ${writer}`], { ...AUTHOR, ...COMMITTER });
      try {
        git(['push', '--quiet', remote, `${commit}:refs/heads/${LOG_BRANCH}`]);
        return { pushed: true, writer, files, attempts: attempt };
      } catch (e) {
        // Another writer pushed first: build again on top of theirs.
        if (attempt >= maxAttempts) throw e;
      }
    } finally {
      rmSync(index, { force: true });
    }
  }
}

// Every writer's lines of one log file from the branch. Missing branch or no network: none.
export function readBranchLogs(git: GitRun, remote = 'origin'): { events: string[]; runs: string[]; read: boolean } {
  const out = { events: [] as string[], runs: [] as string[], read: false };
  let head: string | undefined;
  try {
    head = remoteHead(git, remote);
  } catch {
    return out;
  }
  out.read = true;
  if (!head) return out;
  for (const path of git(['ls-tree', '-r', '--name-only', head]).split('\n').filter(Boolean)) {
    const kind = FILES.find((f) => path.endsWith(`/${f}.jsonl`));
    if (!kind) continue;
    out[kind].push(...git(['show', `${head}:${path}`]).split('\n'));
  }
  return out;
}
