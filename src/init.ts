// forge init: installs the agents and the grill skill into a project's .claude folder.

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
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

  const config = [
    '# System factory settings. See https://github.com/hoangtrankim/system-factory',
    ...(opts.repo ? [`repo: ${opts.repo}`] : []),
    'base: main',
    'maxRounds: 3',
    '# How the factory merges a reviewed, green PR: merge, squash or rebase.',
    'mergeMethod: merge',
    '# Component name -> paths it owns. Tickets are tagged with these names; the reviewer',
    '# checks that a PR stays inside its components (tests/ is always allowed).',
    'components:',
    '  app: ["src/**"]',
    '',
  ].join('\n');
  place('', join(target, CONFIG_FILE), config);
  return result;
}
