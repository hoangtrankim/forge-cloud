// The guard hook: read-only agents keep Bash (to run forge, git and the tests), but every
// command they run is checked here first, so "read-only" is enforced, not just asked for.
// The dispatcher installs it as a Claude Code PreToolUse hook for the roles listed below.

import { appendFileSync, mkdirSync } from 'node:fs';
import type { Role } from './lifecycle.js';

export const GUARDED_ROLES: readonly Role[] = ['reviewer', 'security'];

// The builder may change anything except the blind acceptance tests and the test config the
// QA writer owns. Its file edits (and the obvious Bash writes) to those paths are blocked.
export const TEST_GUARDED_ROLES: readonly Role[] = ['builder'];

// Every role the hook knows by its subagent type.
export const HOOKED_ROLES: readonly Role[] = [...GUARDED_ROLES, ...TEST_GUARDED_ROLES];

// The tools the hook watches: Bash for everyone it guards, the file tools for the builder.
export const GUARD_MATCHER = 'Bash|Edit|Write|MultiEdit|NotebookEdit';
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export function isQaOwnedPath(path: string): boolean {
  const p = path.replace(/\\/g, '/');
  return /(^|\/)tests\/acceptance(\/|$)/.test(p) || /(^|\/)playwright\.config\.[cm]?[jt]s$/.test(p);
}

// Scratch space for notes, logs and throwaway worktrees. Writes and npm runs stay in here.
export const SCRATCH = '/tmp/factory';

export type Verdict = { ok: true } | { ok: false; reason: string };

const allow: Verdict = { ok: true };
const deny = (reason: string): Verdict => ({ ok: false, reason });

const READ_ONLY = new Set([
  'cat', 'head', 'tail', 'grep', 'rg', 'ls', 'wc', 'echo', 'printf', 'sort', 'uniq', 'diff',
  'jq', 'pwd', 'true', 'test', '[', 'cut', 'tr', 'basename', 'dirname', 'realpath', 'date', 'which',
]);
const GIT_READ = new Set([
  'fetch', 'log', 'show', 'diff', 'rev-parse', 'status', 'ls-files', 'blame', 'merge-base', 'cat-file', 'branch', 'remote',
]);
const NPM_RUN = new Set(['ci', 'test', 'run', 'install']);

interface Segment {
  words: string[];
  // Targets of > and >> redirections.
  writes: string[];
}

// Splits a command line into simple commands on unquoted ;, &&, ||, | and newlines.
// Heredoc bodies are dropped (they are data). Returns a reason when the line uses shell
// features that hide what runs, such as command substitution.
export function parse(command: string): Segment[] | string {
  const lines = command.split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    kept.push(line);
    const m = /<<-?\s*(['"]?)(\w+)\1/.exec(line);
    if (!m) continue;
    const end = lines.findIndex((l, j) => j > i && l.trim() === m[2]);
    if (end === -1) return 'unterminated heredoc';
    i = end;
  }
  const text = kept.join('\n');

  const segments: Segment[] = [];
  let words: string[] = [];
  let writes: string[] = [];
  let word = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  let redirect = false;
  const endWord = () => {
    if (!inWord) return;
    if (redirect) writes.push(word);
    else words.push(word);
    word = '';
    inWord = false;
    redirect = false;
  };
  const endSegment = () => {
    endWord();
    if (redirect) return 'a redirection without a target';
    if (words.length || writes.length) segments.push({ words, writes });
    words = [];
    writes = [];
    return undefined;
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const next = text[i + 1];
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
      continue;
    }
    if (c === '`') return 'backticks (command substitution) are not allowed';
    if (c === '$' && next === '(' && text[i + 2] === '(') {
      // $(( ... )) is arithmetic, such as PORT=$((4500 + N)); keep it as one word.
      const close = text.indexOf('))', i + 3);
      if (close === -1) return 'unterminated $(( ))';
      const expr = text.slice(i + 3, close);
      if (/[`$]\(|`/.test(expr)) return '$( ) (command substitution) is not allowed';
      word += text.slice(i, close + 2);
      inWord = true;
      i = close + 1;
      continue;
    }
    if (c === '$' && next === '(') return '$( ) (command substitution) is not allowed';
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && next !== undefined) word += text[++i];
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
      continue;
    }
    if (c === '\\' && next !== undefined) {
      if (next !== '\n') word += next;
      inWord = inWord || next !== '\n';
      i++;
      continue;
    }
    if (c === ' ' || c === '\t') {
      endWord();
      continue;
    }
    if (c === ';' || c === '\n' || c === '|' || (c === '&' && next === '&')) {
      if ((c === '|' && next === '|') || c === '&') i++;
      const bad = endSegment();
      if (bad) return bad;
      continue;
    }
    if (c === '&') return 'background jobs (&) are not allowed';
    if (c === '<' && next === '(') return '<( ) (process substitution) is not allowed';
    if (c === '>' && next === '(') return '>( ) (process substitution) is not allowed';
    if (c === '>' || c === '<') {
      // 2>&1, >&2 and friends duplicate a stream; they write no file.
      const dup = /^>&\d/.exec(text.slice(i));
      const fd = /^\d$/.test(word) && inWord;
      if (fd) {
        word = '';
        inWord = false;
      } else endWord();
      if (dup) {
        i += dup[0].length - 1;
        continue;
      }
      if (c === '>' && next === '>') i++;
      if (c === '<') {
        // Input redirection reads a file, which is fine; the next word is that file.
        continue;
      }
      redirect = true;
      continue;
    }
    word += c;
    inWord = true;
  }
  if (quote) return 'unterminated quote';
  const bad = endSegment();
  if (bad) return bad;
  return segments;
}

const inScratch = (path: string, cwd: string) => {
  const abs = path.startsWith('/') ? path : `${cwd.replace(/\/$/, '')}/${path}`;
  const parts: string[] = [];
  for (const p of abs.split('/')) {
    if (!p || p === '.') continue;
    if (p === '..') parts.pop();
    else parts.push(p);
  }
  const norm = `/${parts.join('/')}`;
  return norm === SCRATCH || norm.startsWith(`${SCRATCH}/`);
};

function checkSegment(seg: Segment, role: Role, cwd: string): Verdict {
  for (const w of seg.writes) {
    if (w !== '/dev/null' && !inScratch(w, cwd)) return deny(`writing to ${w}; write only under ${SCRATCH}`);
  }
  // Leading VAR=value assignments only set the environment of the command.
  const words = [...seg.words];
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words.shift();
  const [cmd, ...args] = words;
  if (!cmd) return allow;

  if (cmd === 'cd') return allow;
  if (cmd === 'sort' && args.some((a) => /^-[a-zA-Z]*o/.test(a) || a.startsWith('--output'))) return deny('sort -o writes a file');
  if (READ_ONLY.has(cmd)) return allow;
  if (cmd === 'sed') {
    return args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place')) ? deny('sed -i edits files') : allow;
  }
  if (cmd === 'find') {
    return args.some((a) => ['-exec', '-execdir', '-delete', '-ok', '-okdir', '-fprint', '-fprintf', '-fls'].includes(a))
      ? deny('find may only list files')
      : allow;
  }
  if (cmd === 'mkdir') {
    return args.filter((a) => !a.startsWith('-')).every((a) => inScratch(a, cwd)) ? allow : deny(`mkdir only under ${SCRATCH}`);
  }
  if (cmd === 'forge') {
    const as = args.indexOf('--as');
    if (as !== -1 && args[as + 1] !== role) return deny(`forge --as ${args[as + 1]}; you are ${role}`);
    if (['init', 'setup', 'dispatch', 'clean', 'logs', 'log-run'].includes(args[0] ?? '')) return deny(`forge ${args[0]} is not for agents`);
    return allow;
  }
  if (cmd === 'git') {
    const rest = args.filter((a, i) => !(a === '-C' || args[i - 1] === '-C'));
    const sub = rest[0];
    if (sub === 'worktree') {
      const action = rest[1];
      if (action === 'list' || action === 'prune') return allow;
      if (action === 'add' || action === 'remove') {
        const paths = rest.slice(2).filter((a) => !a.startsWith('-') && !a.startsWith('origin/') && !/^[0-9a-f]{7,40}$/.test(a));
        if (action === 'add' && !rest.includes('--detach')) return deny('git worktree add needs --detach (never a branch)');
        return paths[0] && inScratch(paths[0], cwd) ? allow : deny(`worktrees go under ${SCRATCH}`);
      }
      return deny(`git worktree ${action ?? ''} is not allowed`);
    }
    if (sub === 'branch' && rest.slice(1).some((a) => !['--list', '-a', '-r', '--show-current', '-v', '-vv'].includes(a))) {
      return deny('git branch may only list branches');
    }
    if (sub === 'remote' && rest.slice(1).some((a) => !['-v', 'show', 'get-url', 'origin'].includes(a))) {
      return deny('git remote may only be read');
    }
    return sub && GIT_READ.has(sub) ? allow : deny(`git ${sub ?? ''} changes the repository; reviewers only read`);
  }
  if (cmd === 'npm' || cmd === 'npx') {
    // Tests and installs run only in a throwaway worktree under the scratch folder.
    if (!inScratch(cwd, '/')) return deny(`run npm only inside a worktree under ${SCRATCH} (cd there first)`);
    if (cmd === 'npx') return args[0] === 'playwright' && args[1] !== 'install' ? allow : deny(`npx ${args[0] ?? ''} is not allowed`);
    return args[0] && NPM_RUN.has(args[0]) ? allow : deny(`npm ${args[0] ?? ''} is not allowed`);
  }
  if (cmd === 'curl') {
    const urls = args.filter((a) => /^https?:\/\//.test(a));
    if (!urls.length || !urls.every((u) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(u))) {
      return deny('curl only to the app on localhost');
    }
    return args.some((a) => a === '-o' || a === '--output' || a === '-O') ? deny('curl may not write files') : allow;
  }
  if (cmd === 'sleep') return allow;
  return deny(`${cmd} is not on the read-only list`);
}

// Commands that change the files they name. `git` subcommands that rewrite tracked files are
// checked the same way.
const FILE_WRITERS = new Set(['rm', 'mv', 'cp', 'tee', 'truncate', 'touch', 'chmod', 'ln', 'install']);
const IN_PLACE = new Set(['sed', 'perl']);
const GIT_FILE_WRITERS = new Set(['rm', 'mv', 'checkout', 'restore', 'apply']);

// The builder's Bash command: blocked only when it plainly writes a QA-owned path. A line
// the parser cannot follow ($( ), backticks) is not blocked: the builder is not read-only,
// and the reviewer's scope check still catches any change to those files.
function checkBuilderCommand(command: string): Verdict {
  const segments = parse(command);
  if (typeof segments === 'string') return allow;
  const no = (path: string) => deny(`${path} belongs to the QA writer; send a flawed test back instead of changing it`);
  for (const seg of segments) {
    const target = seg.writes.find(isQaOwnedPath);
    if (target) return no(target);
    const words = seg.words.filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    const [cmd, ...args] = words;
    if (!cmd) continue;
    const paths = args.filter(isQaOwnedPath);
    if (!paths.length) continue;
    if (FILE_WRITERS.has(cmd)) return no(paths[0]!);
    if (IN_PLACE.has(cmd) && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) return no(paths[0]!);
    if (cmd === 'git' && args[0] && GIT_FILE_WRITERS.has(args[0])) return no(paths[0]!);
  }
  return allow;
}

// The verdict for one Bash command run by `role` from `cwd`. `cd` inside the line moves
// the working directory for the commands after it.
export function checkCommand(command: string, role: Role, cwd: string): Verdict {
  if (TEST_GUARDED_ROLES.includes(role)) return checkBuilderCommand(command);
  if (!GUARDED_ROLES.includes(role)) return allow;
  const segments = parse(command);
  if (typeof segments === 'string') return deny(segments);
  let dir = cwd;
  for (const seg of segments) {
    const v = checkSegment(seg, role, dir);
    if (!v.ok) return v;
    const [cmd, target] = seg.words;
    if (cmd === 'cd' && target) dir = target.startsWith('/') ? target : `${dir.replace(/\/$/, '')}/${target}`;
  }
  return allow;
}

// The guarded role a hook event's subagent runs as: `factory-reviewer` -> reviewer.
// Claude Code puts `agent_type` on the events of a subagent's own tool calls.
export function roleOfAgentType(agentType: unknown): Role | undefined {
  const m = typeof agentType === 'string' ? /^factory-([a-z-]+)$/.exec(agentType) : null;
  const role = m?.[1] as Role | undefined;
  return role && HOOKED_ROLES.includes(role) ? role : undefined;
}

// Reads a Claude Code PreToolUse event from stdin. Exit 2 blocks the call and shows Claude
// the reason. The role is the one given (--role, FACTORY_ROLE) or, from the project's
// settings hook, the subagent's type. With a role, anything unreadable is blocked too, so
// the guard fails closed; with none, the call is not a guarded agent's and passes.
// `role` and `command` are set when a guarded agent's Bash call was checked, for the log.
export interface GuardResult {
  code: number;
  message?: string;
  role?: Role;
  command?: string;
  tool?: string;
}

export function runGuard(input: string, given: string | undefined): GuardResult {
  let event: { tool_name?: string; tool_input?: { command?: unknown; file_path?: unknown; notebook_path?: unknown }; cwd?: string; agent_type?: unknown };
  try {
    event = JSON.parse(input);
  } catch (e) {
    return given ? { code: 2, message: `guard: could not read the hook input (${(e as Error).message})` } : { code: 0 };
  }
  const role = (given ?? roleOfAgentType(event.agent_type)) as Role | undefined;
  if (!role) return { code: 0 };
  const tool = event.tool_name ?? '';
  if (FILE_TOOLS.has(tool)) {
    if (!TEST_GUARDED_ROLES.includes(role)) return { code: 0 };
    const path = event.tool_input?.file_path ?? event.tool_input?.notebook_path;
    if (typeof path !== 'string') return { code: 2, message: `guard: no file path to check`, role };
    const command = `${tool} ${path}`;
    return isQaOwnedPath(path)
      ? { code: 2, message: `Blocked by the factory guard: ${path} belongs to the QA writer; send a flawed test back instead of changing it.`, role, command, tool }
      : { code: 0, role, command, tool };
  }
  if (tool !== 'Bash') return { code: 0 };
  const command = event.tool_input?.command;
  if (typeof command !== 'string') return { code: 2, message: 'guard: no command to check', role };
  const v = checkCommand(command, role, event.cwd ?? process.cwd());
  if (v.ok) return { code: 0, role, command, tool };
  const why = GUARDED_ROLES.includes(role) ? `${role} is read-only` : `${role} may not change the acceptance tests`;
  return { code: 2, message: `Blocked by the factory guard (${why}): ${v.reason}.`, role, command, tool };
}

// Every check of a guarded agent's command is one line here. The session loop reads it after
// a reviewer or security run: no line means the hook never fired, so the agent ran unguarded.
export const GUARD_LOG = `${SCRATCH}/guard.log`;

export interface GuardLogLine {
  time: string;
  role: Role;
  verdict: 'allow' | 'block';
  command?: string;
  reason?: string;
}

// The builder's allowed Bash commands are not logged: there are many and they prove nothing
// the file-tool checks don't.
export function guardLogLine(r: GuardResult, now = new Date()): GuardLogLine | undefined {
  if (!r.role) return undefined;
  if (TEST_GUARDED_ROLES.includes(r.role) && r.tool === 'Bash' && r.code === 0) return undefined;
  return {
    time: now.toISOString(),
    role: r.role,
    verdict: r.code === 0 ? 'allow' : 'block',
    ...(r.command !== undefined ? { command: r.command.slice(0, 200) } : {}),
    ...(r.message ? { reason: r.message } : {}),
  };
}

export function appendGuardLog(line: GuardLogLine, file = GUARD_LOG): void {
  try {
    mkdirSync(SCRATCH, { recursive: true });
    appendFileSync(file, `${JSON.stringify(line)}\n`);
  } catch {
    // The verdict stands without the log line. A log that cannot be written shows up as a
    // missing line, which `forge guard --ran` reports, so this failure is not silent.
  }
}

// Whether the guard checked a command of `role` at or after `since` (an ISO time). Lines
// that are not JSON are skipped: the file is append-only and may end in a torn write.
export function guardRanSince(log: string, role: string, since: string): number {
  const from = Date.parse(since);
  if (Number.isNaN(from)) throw new Error(`--since needs an ISO time such as 2026-11-04T03:00:00Z, got "${since}"`);
  let count = 0;
  for (const text of log.split('\n')) {
    if (!text.trim()) continue;
    let line: Partial<GuardLogLine>;
    try {
      line = JSON.parse(text) as Partial<GuardLogLine>;
    } catch {
      continue;
    }
    if (line.role === role && typeof line.time === 'string' && Date.parse(line.time) >= from) count++;
  }
  return count;
}
