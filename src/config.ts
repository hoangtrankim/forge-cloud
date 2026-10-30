// factory.config.yml at the target repo's root. Every field is optional.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { MERGE_METHODS, type MergeMethod } from './codehost.js';
import { DEFAULT_MAX_ROUNDS } from './lifecycle.js';

export interface Config {
  repo?: string;
  maxRounds: number;
  base: string;
  // Component name -> paths it owns. The planner tags tickets with these names, and the
  // reviewer checks that a PR only touches paths of its ticket's components.
  components: Record<string, string[]>;
  // Extra flags for each `claude -p` agent run (default: see DEFAULT_CLAUDE_ARGS in runner.ts).
  claudeArgs?: string[];
  // How the factory merges a green, reviewed PR (default: merge).
  mergeMethod: MergeMethod;
}

export const CONFIG_FILE = 'factory.config.yml';

export function loadConfig(dir = process.cwd()): Config {
  const file = join(dir, CONFIG_FILE);
  const raw = existsSync(file) ? ((parse(readFileSync(file, 'utf8')) ?? {}) as Record<string, unknown>) : {};
  const maxRounds = Number(raw.maxRounds ?? DEFAULT_MAX_ROUNDS);
  if (!Number.isInteger(maxRounds) || maxRounds < 1) throw new Error(`${CONFIG_FILE}: maxRounds must be a positive integer`);
  const components: Record<string, string[]> = {};
  if (raw.components !== undefined) {
    if (typeof raw.components !== 'object' || raw.components === null || Array.isArray(raw.components)) {
      throw new Error(`${CONFIG_FILE}: components must map a name to a list of paths`);
    }
    for (const [name, paths] of Object.entries(raw.components)) {
      const list = typeof paths === 'string' ? [paths] : paths;
      if (!Array.isArray(list) || !list.every((p) => typeof p === 'string')) {
        throw new Error(`${CONFIG_FILE}: components.${name} must be a list of paths`);
      }
      components[name] = list;
    }
  }
  const mergeMethod = raw.mergeMethod ?? 'merge';
  if (!MERGE_METHODS.includes(mergeMethod as MergeMethod)) {
    throw new Error(`${CONFIG_FILE}: mergeMethod must be one of ${MERGE_METHODS.join(', ')}`);
  }
  return {
    repo: typeof raw.repo === 'string' ? raw.repo : undefined,
    maxRounds,
    base: typeof raw.base === 'string' ? raw.base : 'main',
    components,
    claudeArgs: Array.isArray(raw.claudeArgs) ? raw.claudeArgs.map(String) : undefined,
    mergeMethod: mergeMethod as MergeMethod,
  };
}

// owner/name from --repo, FACTORY_REPO, the config file, or the origin remote, in that order.
export function resolveRepo(flag: string | undefined, config: Config, dir = process.cwd()): string {
  const repo = flag ?? process.env.FACTORY_REPO ?? config.repo ?? originRepo(dir);
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error('cannot tell which repo to use; pass --repo owner/name or set FACTORY_REPO');
  }
  return repo;
}

export function originRepo(dir: string): string | undefined {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: dir, encoding: 'utf8' }).trim();
    return parseRemote(url);
  } catch {
    return undefined;
  }
}

export function parseRemote(url: string): string | undefined {
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
  return m ? `${m[1]}/${m[2]}` : undefined;
}
