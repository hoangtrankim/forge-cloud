import { describe, expect, it } from 'vitest';
import { fromBody, fromLabels, isFactoryLabel, toLabels, withBodyFields } from './labels.js';
import type { Ticket } from './lifecycle.js';

const t: Ticket = {
  id: 4,
  title: 'x',
  body: '',
  type: 'build',
  state: 'in-review',
  priority: 1,
  round: 2,
  risky: true,
  testsReady: true,
  gates: { security: 'pass' },
  components: ['api', 'ui'],
  blockedBy: [1, 2],
  covers: ['AC-1'],
  spec: 3,
  pr: 9,
  closed: false,
};

describe('labels', () => {
  it('round-trips a ticket through labels', () => {
    const labels = toLabels(t);
    expect(labels).toEqual([
      'factory:in-review',
      'priority:p1',
      'risky',
      'qa:tests-ready',
      'round:2',
      'component:api',
      'component:ui',
      'gate:security:pass',
    ]);
    expect(fromLabels(labels)).toEqual({
      state: 'in-review',
      type: 'build',
      priority: 1,
      round: 2,
      risky: true,
      testsReady: true,
      components: ['api', 'ui'],
      gates: { security: 'pass' },
    });
  });

  it('defaults to p2, round 0 and no state', () => {
    const f = fromLabels(['bug']);
    expect(f.state).toBeUndefined();
    expect(f.priority).toBe(2);
    expect(f.round).toBe(0);
  });

  it('knows which labels it owns', () => {
    expect(isFactoryLabel('factory:done')).toBe(true);
    expect(isFactoryLabel('gate:security:fail')).toBe(true);
    expect(isFactoryLabel('bug')).toBe(false);
  });
});

describe('body lines', () => {
  it('reads link lines', () => {
    const body = 'Do it.\n\nSpec: #3\nCovers: AC-1, AC-4\nBlocked by: #1, #2\nPR: #9\n';
    expect(fromBody(body)).toEqual({ spec: 3, pr: 9, blockedBy: [1, 2], covers: ['AC-1', 'AC-4'] });
  });

  it('keeps the reviewed commit as a Reviewed line, and only a full SHA', () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const out = withBodyFields('Text', { covers: [], blockedBy: [], reviewedSha: sha });
    expect(out).toContain(`Reviewed: ${sha}`);
    expect(fromBody(out).reviewedSha).toBe(sha);
    expect(withBodyFields(out, { covers: [], blockedBy: [] })).not.toContain('Reviewed:');
    expect(fromBody('Reviewed: abc').reviewedSha).toBeUndefined();
  });

  it('adds, rewrites and removes link lines without touching the rest', () => {
    const body = 'Intro\n\nBlocked by: #1\nOutro';
    const out = withBodyFields(body, { spec: 3, covers: ['AC-2'], blockedBy: [], pr: 5 });
    expect(out).toBe('Intro\n\nOutro\nSpec: #3\nCovers: AC-2\nPR: #5\n');
    expect(fromBody(out)).toEqual({ spec: 3, pr: 5, blockedBy: [], covers: ['AC-2'] });
    expect(withBodyFields(out, { spec: 3, covers: ['AC-2'], blockedBy: [], pr: 6 })).toContain('PR: #6');
  });

  it('writes lines into an empty body', () => {
    expect(withBodyFields('', { covers: ['AC-1'], blockedBy: [] })).toBe('Covers: AC-1\n');
  });
});
