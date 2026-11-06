import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RISK_RULES,
  assessDiff,
  atLeast,
  fileTier,
  globToRegExp,
  holdDecision,
  parseRiskRules,
  stricter,
  type HoldFacts,
  type LabelEvent,
} from './risk.js';

// The risk.yml the design note proposes for todo-app.
const TODO_APP = parseRiskRules(`
default: medium
maxLowLines: 300
high:
  - .github/workflows/**
  - .claude/**
  - factory.config.yml
  - risk.yml
  - package.json
  - package-lock.json
  - '**/*auth*'
  - '**/*session*'
  - '**/*payment*'
medium:
  - server.js
low:
  - public/**
  - tests/**
  - docs/**
  - '*.md'
`);

const file = (path: string, additions = 5, deletions = 0) => ({ path, additions, deletions });

describe('tiers', () => {
  it('orders low < medium < high', () => {
    expect(stricter('low', 'medium')).toBe('medium');
    expect(stricter('high', 'medium')).toBe('high');
    expect(atLeast('medium', 'medium')).toBe(true);
    expect(atLeast('low', 'medium')).toBe(false);
  });
});

describe('globToRegExp', () => {
  it('keeps * inside a folder and lets ** cross folders', () => {
    expect(globToRegExp('public/*').test('public/app.js')).toBe(true);
    expect(globToRegExp('public/*').test('public/js/app.js')).toBe(false);
    expect(globToRegExp('public/**').test('public/js/app.js')).toBe(true);
    expect(globToRegExp('**/*auth*').test('auth.js')).toBe(true);
    expect(globToRegExp('**/*auth*').test('src/lib/oauth-client.js')).toBe(true);
    expect(globToRegExp('docs/').test('docs/a/b.md')).toBe(true);
    expect(globToRegExp('**/*auth*/**').test('src/auth/login.js')).toBe(true);
    expect(globToRegExp('**/*auth*/**').test('auth/login.js')).toBe(true);
    expect(globToRegExp('**/*auth*/**').test('src/author.js')).toBe(false);
    expect(globToRegExp('./server.js').test('server.js')).toBe(true);
  });

  it('matches a pattern with no slash against the file name in any folder', () => {
    expect(globToRegExp('*.md').test('README.md')).toBe(true);
    expect(globToRegExp('*.md').test('docs/guide/x.md')).toBe(true);
    expect(globToRegExp('server.js').test('lib/server.js')).toBe(true);
    expect(globToRegExp('server.js').test('server.jsx')).toBe(false);
    expect(globToRegExp('a.b').test('axb')).toBe(false);
  });
});

describe('fileTier and assessDiff', () => {
  it('gives each file its strictest matching rule, and unknown files the default', () => {
    expect(fileTier('public/app.js', TODO_APP)).toEqual({ tier: 'low', rule: 'public/**' });
    expect(fileTier('server.js', TODO_APP)).toEqual({ tier: 'medium', rule: 'server.js' });
    expect(fileTier('public/auth.js', TODO_APP)).toEqual({ tier: 'high', rule: '**/*auth*' });
    expect(fileTier('.claude/agents/factory-builder.md', TODO_APP).tier).toBe('high');
    expect(fileTier('lib/store.js', TODO_APP)).toEqual({ tier: 'medium' });
  });

  it('keeps the factory files high even when risk.yml leaves them out', () => {
    const loose = parseRiskRules('default: low\n');
    expect(fileTier('.github/workflows/forge-gate.yml', loose).tier).toBe('high');
    expect(fileTier('risk.yml', loose).tier).toBe('high');
    expect(fileTier('factory.config.yml', loose).tier).toBe('high');
    expect(fileTier('src/app.js', loose).tier).toBe('low');
  });

  it('takes the strictest file for the PR, and says why', () => {
    expect(assessDiff([file('public/app.js'), file('tests/a.spec.ts')], TODO_APP)).toEqual({ tier: 'low', reasons: [], lines: 5 });
    const a = assessDiff([file('public/app.js'), file('server.js'), file('.github/workflows/ci.yml')], TODO_APP);
    expect(a.tier).toBe('high');
    expect(a.reasons).toEqual([
      '.github/workflows/ci.yml: high (matches `.github/workflows/**`)',
      'server.js: medium (matches `server.js`)',
    ]);
    expect(assessDiff([file('lib/new.js')], TODO_APP).reasons).toEqual(['lib/new.js: medium (no rule matches it)']);
  });

  it('rates a rename by its old path too', () => {
    const a = assessDiff([{ path: 'public/old-auth.js', previousPath: 'lib/auth.js', additions: 0, deletions: 0 }], TODO_APP);
    expect(a.tier).toBe('high');
  });

  it('makes a big PR at least medium, not counting tests', () => {
    expect(assessDiff([file('public/app.js', 200, 101)], TODO_APP)).toMatchObject({ tier: 'medium', lines: 301 });
    expect(assessDiff([file('public/app.js', 200, 101)], TODO_APP).reasons).toEqual(['301 changed lines, over the 300 a low-risk PR may have']);
    expect(assessDiff([file('public/app.js', 100), file('tests/big.spec.ts', 900)], TODO_APP)).toMatchObject({ tier: 'low', lines: 100 });
  });

  it('lists at most eight reasons', () => {
    const many = Array.from({ length: 12 }, (_, i) => file(`lib/f${i}.js`));
    const r = assessDiff(many, TODO_APP).reasons;
    expect(r).toHaveLength(9);
    expect(r.at(-1)).toBe('and 4 more');
  });
});

describe('parseRiskRules', () => {
  it('fills in defaults and refuses bad values', () => {
    expect(parseRiskRules('')).toMatchObject({ default: 'medium', maxLowLines: 300, sizeIgnore: ['tests/**'], high: [], low: [] });
    expect(parseRiskRules('low: docs/**\n').low).toEqual(['docs/**']);
    expect(() => parseRiskRules('default: huge\n')).toThrow(/default must be one of/);
    expect(() => parseRiskRules('maxLowLines: -1\n')).toThrow(/maxLowLines/);
    expect(() => parseRiskRules('high: [1, 2]\n')).toThrow(/high must be a list of paths/);
    expect(() => parseRiskRules('- a\n- b\n')).toThrow(/expected a map/);
  });

  it('has defaults that rate an unknown file medium and docs low', () => {
    expect(fileTier('src/x.js', DEFAULT_RISK_RULES).tier).toBe('medium');
    expect(fileTier('docs/x.md', DEFAULT_RISK_RULES).tier).toBe('low');
    expect(fileTier('package.json', DEFAULT_RISK_RULES).tier).toBe('high');
  });
});

describe('holdDecision', () => {
  const HELD = '2026-11-05T10:00:00Z';
  const at = (h: number) => new Date(Date.parse(HELD) + h * 3600 * 1000);
  const ev = (event: LabelEvent['event'], label: string, hours: number, actor = 'hoang', viaApp?: string): LabelEvent => ({
    event,
    label,
    actor,
    at: at(hours).toISOString().replace('.000', ''),
    ...(viaApp ? { viaApp } : {}),
  });
  const facts = (over: Partial<HoldFacts> = {}): HoldFacts => ({
    labels: ['held'],
    events: [ev('labeled', 'held', 0, 'forge-bot', 'forge-bot')],
    owner: 'hoang',
    heldAt: HELD,
    hours: 24,
    now: at(1),
    ...over,
  });

  it('starts a hold for a commit it has not held yet', () => {
    expect(holdDecision(facts({ heldAt: undefined, labels: [], events: [] }))).toEqual({ decision: { kind: 'start' }, remove: [] });
  });

  it('waits until the hours are up, then merges', () => {
    expect(holdDecision(facts()).decision).toEqual({ kind: 'wait', until: at(24) });
    expect(holdDecision(facts({ now: at(24) })).decision).toEqual({ kind: 'due' });
  });

  it('merges at once when the owner approves by hand after the hold started', () => {
    const r = holdDecision(facts({ labels: ['held', 'approve'], events: [ev('labeled', 'approve', 2)] }));
    expect(r).toEqual({ decision: { kind: 'approved', by: 'hoang' }, remove: [] });
    expect(holdDecision(facts({ labels: ['approve'], events: [ev('labeled', 'approve', 2, 'Hoang')] })).decision.kind).toBe('approved');
  });

  it('takes off an approve that is not the owner by hand, or is from before this hold', () => {
    for (const e of [ev('labeled', 'approve', 2, 'someone'), ev('labeled', 'approve', 2, 'hoang', 'claude'), ev('labeled', 'approve', -5)]) {
      expect(holdDecision(facts({ labels: ['held', 'approve'], events: [e] }))).toEqual({ decision: { kind: 'wait', until: at(24) }, remove: ['approve'] });
    }
    // No hold yet: an early approve does not skip it.
    expect(holdDecision(facts({ heldAt: undefined, labels: ['approve'], events: [ev('labeled', 'approve', 2)] }))).toEqual({
      decision: { kind: 'start' },
      remove: ['approve'],
    });
  });

  it('stops on a hold from anyone, even past the hours and over an approve', () => {
    const r = holdDecision(facts({ labels: ['held', 'hold', 'approve'], events: [ev('labeled', 'hold', 3, 'someone'), ev('labeled', 'approve', 4)], now: at(30) }));
    expect(r).toEqual({ decision: { kind: 'on-hold', by: 'someone' }, remove: [] });
  });

  it('restarts the clock when a hold comes off', () => {
    const events = [ev('labeled', 'hold', 3), ev('unlabeled', 'hold', 20)];
    expect(holdDecision(facts({ events, now: at(30) })).decision).toEqual({ kind: 'wait', until: at(44) });
    expect(holdDecision(facts({ events, now: at(44) })).decision).toEqual({ kind: 'due' });
  });
});
