import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { GUARD_HOOK_COMMAND, addGuardHook, init } from './init.js';

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

  it('installs the session loop, the merge gate workflow, and a config the gate can work with', () => {
    const dir = tmp();
    const r = init(dir);
    expect(r.written).toContain('.claude/skills/forge-loop/SKILL.md');
    expect(r.written).toContain('.github/workflows/forge-gate.yml');
    const workflow = readFileSync(join(dir, '.github/workflows/forge-gate.yml'), 'utf8');
    expect(workflow).toContain('run: forge merge-gate');
    expect(workflow).toContain('actions/create-github-app-token');
    // Rules only: no agent runs here, so no Claude login either.
    expect(workflow).not.toMatch(/CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|claude -p/);
    expect(loadConfig(dir).reviewStatus).toBe('gate');
    expect(loadConfig(dir).holdHours).toBe(24);
    // Held PRs need a clock, and the owner's labels on a PR start a run.
    expect(workflow).toContain("cron: '17 * * * *'");
    expect(workflow).toContain('pull_request_target');
  });

  it('installs a starter risk.yml that forge can read', async () => {
    const dir = tmp();
    expect(init(dir).written).toContain('risk.yml');
    const { parseRiskRules, fileTier } = await import('./risk.js');
    const rules = parseRiskRules(readFileSync(join(dir, 'risk.yml'), 'utf8'));
    expect(rules.default).toBe('medium');
    expect(fileTier('src/auth/login.js', rules).tier).toBe('high');
    expect(fileTier('README.md', rules).tier).toBe('low');
  });

  it('adds the guard hook to the project settings once, keeping what is there', () => {
    const dir = tmp();
    mkdirSync(join(dir, '.claude'), { recursive: true });
    const file = join(dir, '.claude/settings.json');
    writeFileSync(file, JSON.stringify({ permissions: { allow: ['Bash(npm test)'] } }));
    expect(init(dir).written).toContain('.claude/settings.json');
    const settings = JSON.parse(readFileSync(file, 'utf8'));
    expect(settings.permissions).toEqual({ allow: ['Bash(npm test)'] });
    expect(settings.hooks.PreToolUse).toEqual([{ matcher: 'Bash|Edit|Write|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: GUARD_HOOK_COMMAND, onFailure: 'block' }] }]);
    expect(addGuardHook(file)).toBe(false);
    expect(JSON.parse(readFileSync(file, 'utf8')).hooks.PreToolUse).toHaveLength(1);
  });

  it('upgrades an older plain forge guard hook in place', () => {
    const dir = tmp();
    mkdirSync(join(dir, '.claude'), { recursive: true });
    const file = join(dir, '.claude/settings.json');
    writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'forge guard' }] }] } }));
    expect(addGuardHook(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8')).hooks.PreToolUse).toEqual([
      { matcher: 'Bash|Edit|Write|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: GUARD_HOOK_COMMAND, onFailure: 'block' }] },
    ]);
    expect(addGuardHook(file)).toBe(false);
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
