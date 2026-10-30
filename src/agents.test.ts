// Checks the agent prompts against the rules, so a prompt edit cannot quietly drift from the CLI.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { PACKAGE_ROOT } from './init.js';
import { ROLES, SEND_BACK_REASONS, STATES } from './lifecycle.js';

interface Agent {
  file: string;
  meta: { name: string; description: string; tools: string; model: string };
  body: string;
}

function load(path: string): Agent {
  const text = readFileSync(path, 'utf8');
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`${path} has no frontmatter`);
  return { file: path, meta: parse(m[1]!), body: m[2]! };
}

const dir = join(PACKAGE_ROOT, 'agents');
const agents = readdirSync(dir).map((f) => load(join(dir, f)));
const role = (a: Agent) => a.meta.name.replace(/^factory-/, '');
const tools = (a: Agent) => a.meta.tools.split(',').map((t) => t.trim());

// Agents whose output is judgement, not code. They must not be able to edit files.
const READ_ONLY = ['reviewer', 'security', 'qa-reporter', 'planner'];

describe('agent prompts', () => {
  it('has one agent per working role', () => {
    expect(agents.map(role).sort()).toEqual(
      ['builder', 'designer', 'planner', 'qa-reporter', 'qa-writer', 'reviewer', 'security'].sort(),
    );
  });

  for (const a of agents) {
    describe(a.meta.name, () => {
      it('is named after its file and a real role', () => {
        expect(a.file.endsWith(`${a.meta.name}.md`)).toBe(true);
        expect(ROLES).toContain(role(a));
        expect(a.meta.description.length).toBeGreaterThan(40);
        expect(['sonnet', 'opus', 'haiku']).toContain(a.meta.model);
      });

      it('acts only as its own role', () => {
        const asFlags = [...a.body.matchAll(/--as ([\w-]+)/g)].map((m) => m[1]);
        expect(asFlags.length).toBeGreaterThan(0);
        expect(new Set(asFlags)).toEqual(new Set([role(a)]));
      });

      it('names only real states and send-back reasons', () => {
        for (const m of a.body.matchAll(/forge move \S+ ([\w-]+)/g)) expect(STATES).toContain(m[1]);
        for (const m of a.body.matchAll(/--reason ([\w-]+)/g)) expect(SEND_BACK_REASONS).toContain(m[1]);
      });

      it('reads its lessons file', () => {
        expect(a.body).toContain(`lessons/${role(a)}.md`);
      });

      it('reads GitHub over REST only and keeps temp files out of the repo', () => {
        expect(a.body).not.toMatch(/`gh (issue|pr) /);
        expect(a.body).not.toMatch(/^\s*gh (issue|pr) /m);
        expect(a.body).toContain(`/tmp/factory/${role(a)}-`);
      });

      if (READ_ONLY.includes(role(a))) {
        it('cannot edit files', () => {
          expect(tools(a)).not.toContain('Edit');
          expect(tools(a)).not.toContain('Write');
        });
      }
    });
  }

  it('keeps the qa-writer blind to application code', () => {
    const qa = agents.find((a) => role(a) === 'qa-writer')!;
    expect(qa.body).toMatch(/must \*\*not\*\* read application source code/);
    expect(tools(qa)).not.toContain('Grep');
  });

  it('sends flawed acceptance tests back to the qa-writer', () => {
    for (const r of ['builder', 'reviewer']) {
      const a = agents.find((x) => role(x) === r)!;
      expect(a.body).toContain(`forge move N designed --as ${r} --reason flawed-test`);
    }
  });

  it('marks acceptance-test commits so the reviewer can tell them apart', () => {
    for (const r of ['qa-writer', 'reviewer']) {
      expect(agents.find((x) => role(x) === r)!.body).toContain('Add acceptance tests for #N');
    }
  });

  it('passes the patterns catalog from the design note to the builder and reviewer', () => {
    const body = (r: string) => agents.find((a) => role(a) === r)!.body;
    expect(body('designer')).toContain('### Patterns');
    for (const r of ['designer', 'builder', 'reviewer']) expect(body(r)).toContain('docs/patterns.md');
    expect(body('builder')).toContain('**New pattern**');
  });

  it('forbids the builder from touching acceptance tests', () => {
    const b = agents.find((a) => role(a) === 'builder')!;
    expect(b.body).toContain('Never edit, skip, delete or weaken anything under `tests/acceptance/`');
  });
});

describe('grill skill', () => {
  const skill = load(join(PACKAGE_ROOT, 'skills', 'factory-grill', 'SKILL.md'));

  it('files specs as grill', () => {
    expect(skill.meta.name).toBe('factory-grill');
    expect(skill.body).toContain('forge create --as grill --type spec');
  });

  it('asks for AC-n criteria', () => {
    expect(skill.body).toContain('- AC-1: Given');
  });
});
