// Runs one agent as its own Claude Code process, in the target repo, with only the ticket
// number as its prompt. The agent's own file in .claude/agents/ sets its tools and model.

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { GUARDED_ROLES } from './guard.js';
import { PACKAGE_ROOT } from './init.js';
import type { Role } from './lifecycle.js';

// Claude Code settings for a read-only agent's run: every Bash call goes through `forge guard`
// first, which blocks anything that is not on that role's read-only list.
export function guardSettings(cli = join(PACKAGE_ROOT, 'dist', 'cli.js')): string {
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} guard`;
  return JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command }] }] } });
}

export interface RunRequest {
  agent: string; // e.g. factory-builder
  prompt: string;
  cwd: string;
}

export interface RunResult {
  ok: boolean;
  exitCode: number;
  durationMs: number;
  // Claude Code's final message, which by every agent prompt ends in a one-line summary.
  summary: string;
  sessionId?: string;
  costUsd?: number;
  turns?: number;
}

export interface AgentRunner {
  run(req: RunRequest): Promise<RunResult>;
}

// Default flags for unattended runs on the runner machine. Agents still only get the tools
// their file lists; Bash is pre-approved so a run never stops at a permission prompt.
export const DEFAULT_CLAUDE_ARGS = ['--permission-mode', 'acceptEdits', '--allowedTools', 'Bash'];

export class ClaudeRunner implements AgentRunner {
  constructor(
    private readonly bin = 'claude',
    private readonly extraArgs: readonly string[] = DEFAULT_CLAUDE_ARGS,
    private readonly timeoutMs = 60 * 60 * 1000,
  ) {}

  run(req: RunRequest): Promise<RunResult> {
    // The prompt goes on stdin: a variadic flag such as --allowedTools would swallow it as an argument.
    const role = req.agent.replace(/^factory-/, '') as Role;
    const guarded = GUARDED_ROLES.includes(role);
    const args = ['-p', '--agent', req.agent, '--output-format', 'json', ...(guarded ? ['--settings', guardSettings()] : []), ...this.extraArgs];
    const started = Date.now();
    return new Promise((resolve) => {
      const env = { ...process.env, FACTORY_ROLE: role };
      const child = spawn(this.bin, args, { cwd: req.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdin.end(req.prompt);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      const timer = setTimeout(() => child.kill('SIGTERM'), this.timeoutMs);
      const finish = (exitCode: number) => {
        clearTimeout(timer);
        resolve(parseResult(stdout, stderr, exitCode, Date.now() - started));
      };
      child.on('error', (e) => {
        stderr += e.message;
        finish(127);
      });
      child.on('close', (code) => finish(code ?? 1));
    });
  }
}

export function parseResult(stdout: string, stderr: string, exitCode: number, durationMs: number): RunResult {
  try {
    const j = JSON.parse(stdout) as {
      result?: string;
      is_error?: boolean;
      session_id?: string;
      total_cost_usd?: number;
      num_turns?: number;
    };
    return {
      ok: exitCode === 0 && !j.is_error,
      exitCode,
      durationMs,
      summary: lastLine(j.result ?? ''),
      sessionId: j.session_id,
      costUsd: j.total_cost_usd,
      turns: j.num_turns,
    };
  } catch {
    return { ok: false, exitCode, durationMs, summary: lastLine(stderr || stdout) || `exit ${exitCode}` };
  }
}

const lastLine = (s: string) => s.trim().split('\n').at(-1)?.trim().slice(0, 500) ?? '';
