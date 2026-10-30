import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { init } from './init.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'factory-init-'));

describe('init', () => {
  it('installs agents, the grill skill and a config', () => {
    const dir = tmp();
    const r = init(dir, { repo: 'o/r' });
    expect(r.written).toContain('.claude/agents/factory-builder.md');
    expect(r.written).toContain('.claude/skills/factory-grill/SKILL.md');
    expect(r.written).toContain('factory.config.yml');
    expect(readFileSync(join(dir, 'factory.config.yml'), 'utf8')).toContain('repo: o/r');
    expect(r.skipped).toEqual([]);
  });

  it('keeps existing files unless forced', () => {
    const dir = tmp();
    mkdirSync(join(dir, '.claude/agents'), { recursive: true });
    writeFileSync(join(dir, '.claude/agents/factory-builder.md'), 'mine');
    const r = init(dir);
    expect(r.skipped).toEqual(['.claude/agents/factory-builder.md']);
    expect(readFileSync(join(dir, '.claude/agents/factory-builder.md'), 'utf8')).toBe('mine');

    init(dir, { force: true });
    expect(readFileSync(join(dir, '.claude/agents/factory-builder.md'), 'utf8')).not.toBe('mine');
  });
});
