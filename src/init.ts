// forge init: installs the agents and skills into a project's .claude folder, the merge gate
// workflow, and factory.config.yml.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE } from './config.js';

// src/ and dist/ both sit one level below the package root.
export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export interface InitResult {
  written: string[];
  skipped: string[];
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

export function init(target: string, opts: { force?: boolean; repo?: string; source?: string } = {}): InitResult {
  const source = opts.source ?? PACKAGE_ROOT;
  const result: InitResult = { written: [], skipped: [] };
  const place = (from: string, to: string, content?: string) => {
    const rel = relative(target, to);
    if (existsSync(to) && !opts.force) {
      result.skipped.push(rel);
      return;
    }
    mkdirSync(dirname(to), { recursive: true });
    if (content === undefined) copyFileSync(from, to);
    else writeFileSync(to, content);
    result.written.push(rel);
  };

  for (const [from, to] of [
    ['agents', '.claude/agents'],
    ['skills', '.claude/skills'],
  ] as const) {
    const dir = join(source, from);
    for (const f of files(dir)) place(f, join(target, to, relative(dir, f)));
  }

  const gate = join(source, 'templates', 'forge-gate.yml');
  place(gate, join(target, '.github', 'workflows', 'forge-gate.yml'));

  const config = [
    '# System factory settings. See https://github.com/hoangtrankim/system-factory',
    ...(opts.repo ? [`repo: ${opts.repo}`] : []),
    'base: main',
    'maxRounds: 3',
    '# How the factory merges a reviewed, green PR: merge, squash or rebase.',
    'mergeMethod: merge',
    '# Who posts the factory/review status: reviewer (its pass) or gate (the merge gate, right',
    '# before it merges). Use gate when a Claude session dispatches, since it cannot post statuses.',
    'reviewStatus: gate',
    '# Component name -> paths it owns. Tickets are tagged with these names; the reviewer',
    '# checks that a PR stays inside its components (tests/ is always allowed).',
    'components:',
    '  app: ["src/**"]',
    '',
  ].join('\n');
  place('', join(target, CONFIG_FILE), config);
  if (addGuardHook(join(target, '.claude', 'settings.json'))) result.written.push(join('.claude', 'settings.json'));
  return result;
}

export const GUARD_COMMAND = 'forge guard';

// The project's settings get a PreToolUse hook on Bash that runs `forge guard`. Settings
// hooks also fire inside subagents, so the reviewer and security stay read-only however
// they were started. Merged into what is there; returns false when it was already there.
export function addGuardHook(file: string): boolean {
  type Hook = { type: string; command: string };
  type Settings = { hooks?: Record<string, Array<{ matcher?: string; hooks: Hook[] }>>; [k: string]: unknown };
  const settings: Settings = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Settings) : {};
  const pre = ((settings.hooks ??= {}).PreToolUse ??= []);
  if (pre.some((m) => m.hooks.some((h) => h.command === GUARD_COMMAND))) return false;
  pre.push({ matcher: 'Bash', hooks: [{ type: 'command', command: GUARD_COMMAND }] });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return true;
}
