import { describe, expect, it } from 'vitest';
import {
  RULES,
  acceptanceCriteria,
  applyMove,
  canCloseSpec,
  canCreate,
  canMarkTestsReady,
  canMerge,
  canMove,
  canRecordGate,
  pickReady,
  specStatus,
  type Ticket,
} from './lifecycle.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';

function ticket(over: Partial<Ticket> = {}): Ticket {
  return {
    id: 10,
    title: 't',
    body: '',
    type: 'build',
    state: 'planned',
    priority: 2,
    round: 0,
    risky: false,
    testsReady: false,
    gates: {},
    components: [],
    blockedBy: [],
    covers: ['AC-1'],
    spec: 1,
    closed: false,
    ...over,
  };
}

describe('canMove', () => {
  it('walks the happy path with the right role at each step', () => {
    let t = ticket({ testsReady: true });
    const steps = [
      { to: 'designed', role: 'designer' },
      { to: 'building', role: 'builder' },
      { to: 'in-review', role: 'builder', pr: 7 },
      { to: 'in-qa', role: 'reviewer', sha: SHA },
      { to: 'done', role: 'system' },
    ] as const;
    for (const s of steps) {
      expect(canMove(t, s)).toEqual({ ok: true });
      t = applyMove(t, s).ticket;
      expect(t.state).toBe(s.to);
    }
    expect(t.closed).toBe(true);
    expect(t.pr).toBe(7);
  });

  it('refuses the wrong role', () => {
    const r = canMove(ticket(), { to: 'designed', role: 'builder' });
    expect(r).toEqual({ ok: false, error: expect.stringContaining('allowed: designer') });
  });

  it('refuses skipping a state', () => {
    expect(canMove(ticket(), { to: 'in-review', role: 'builder', pr: 1 }).ok).toBe(false);
  });

  it('refuses any move out of done', () => {
    expect(canMove(ticket({ state: 'done' }), { to: 'blocked', role: 'owner', reason: 'x' }).ok).toBe(false);
  });

  it('refuses moving a spec', () => {
    expect(canMove(ticket({ type: 'spec', state: 'spec' }), { to: 'planned', role: 'planner' }).ok).toBe(false);
  });

  it('refuses building before the blind QA tests exist', () => {
    const r = canMove(ticket({ state: 'designed' }), { to: 'building', role: 'builder' });
    expect(r).toEqual({ ok: false, error: expect.stringContaining('blind QA tests') });
  });

  it('refuses building while a blocker is open', () => {
    const t = ticket({ state: 'designed', testsReady: true, blockedBy: [3] });
    expect(canMove(t, { to: 'building', role: 'builder' }, { openBlockers: [3] })).toEqual({
      ok: false,
      error: expect.stringContaining('#3'),
    });
    expect(canMove(t, { to: 'building', role: 'builder' }, { openBlockers: [] }).ok).toBe(true);
  });

  it('needs a PR to enter review and to finish', () => {
    expect(canMove(ticket({ state: 'building' }), { to: 'in-review', role: 'builder' }).ok).toBe(false);
    expect(canMove(ticket({ state: 'in-qa' }), { to: 'done', role: 'system' }).ok).toBe(false);
  });

  it('only the system marks a ticket done', () => {
    expect(canMove(ticket({ state: 'in-qa', pr: 3 }), { to: 'done', role: 'qa-reporter' }).ok).toBe(false);
  });

  it('holds a risky ticket in review until the security gate passes', () => {
    const t = ticket({ state: 'in-review', risky: true, pr: 3 });
    expect(canMove(t, { to: 'in-qa', role: 'reviewer', sha: SHA }).ok).toBe(false);
    expect(canMove({ ...t, gates: { security: 'pass' } }, { to: 'in-qa', role: 'reviewer', sha: SHA }).ok).toBe(true);
  });

  it('needs a typed reason for a send-back', () => {
    const t = ticket({ state: 'in-review', pr: 3 });
    expect(canMove(t, { to: 'building', role: 'reviewer' }).ok).toBe(false);
    expect(canMove(t, { to: 'building', role: 'reviewer', reason: 'looks off' }).ok).toBe(false);
    expect(canMove(t, { to: 'building', role: 'reviewer', reason: 'missing-test' }).ok).toBe(true);
    expect(canMove(t, { to: 'building', role: 'reviewer', reason: 'quality' }).ok).toBe(true);
  });

  it('passes a review only for a full commit SHA, and forgets it on any later move', () => {
    const t = ticket({ state: 'in-review', pr: 3 });
    expect(canMove(t, { to: 'in-qa', role: 'reviewer' }).ok).toBe(false);
    expect(canMove(t, { to: 'in-qa', role: 'reviewer', sha: 'abc123' }).ok).toBe(false);
    const passed = applyMove(t, { to: 'in-qa', role: 'reviewer', sha: SHA }).ticket;
    expect(passed.reviewedSha).toBe(SHA);
    const back = applyMove(passed, { to: 'in-review', role: 'system' }).ticket;
    expect(back).toMatchObject({ state: 'in-review', round: 0, reviewedSha: undefined });
    expect(applyMove(passed, { to: 'building', role: 'qa-reporter', reason: 'wrong-behavior' }).ticket.reviewedSha).toBeUndefined();
  });

  it('lets only the system send a changed PR back to review', () => {
    const t = ticket({ state: 'in-qa', pr: 3, reviewedSha: SHA });
    expect(canMove(t, { to: 'in-review', role: 'system' }).ok).toBe(true);
    expect(canMove(t, { to: 'in-review', role: 'builder' }).ok).toBe(false);
  });

  it('needs a reason to block or escalate', () => {
    expect(canMove(ticket(), { to: 'blocked', role: 'planner' }).ok).toBe(false);
    expect(canMove(ticket(), { to: 'blocked', role: 'planner', reason: 'waiting on #2' }).ok).toBe(true);
    expect(canMove(ticket(), { to: 'needs-human', role: 'builder', reason: 'spec unclear' }).ok).toBe(true);
  });

  it('only planner or owner unblock', () => {
    const t = ticket({ state: 'needs-human' });
    expect(canMove(t, { to: 'planned', role: 'builder' }).ok).toBe(false);
    expect(canMove(t, { to: 'planned', role: 'owner' }).ok).toBe(true);
  });

  it('never lets grill move a ticket', () => {
    for (const r of RULES) expect(r.roles).not.toContain('grill');
  });
});

describe('applyMove', () => {
  it('counts a send-back as a round and clears gate results', () => {
    const t = ticket({ state: 'in-review', pr: 3, gates: { security: 'pass' } });
    const { ticket: next, escalated } = applyMove(t, { to: 'building', role: 'reviewer', reason: 'scope-creep' });
    expect(next.round).toBe(1);
    expect(next.gates).toEqual({});
    expect(next.state).toBe('building');
    expect(escalated).toBe(false);
  });

  it('does not count forward moves', () => {
    expect(applyMove(ticket(), { to: 'designed', role: 'designer' }).ticket.round).toBe(0);
  });

  it('sends the ticket to needs-human on the round that reaches the limit', () => {
    const t = ticket({ state: 'in-qa', pr: 3, round: 2 });
    const { ticket: next, escalated } = applyMove(t, { to: 'building', role: 'qa-reporter', reason: 'failing-check' }, 3);
    expect(escalated).toBe(true);
    expect(next.state).toBe('needs-human');
    expect(next.round).toBe(3);
  });

  it('does not mutate the input', () => {
    const t = ticket({ state: 'in-review', pr: 3, gates: { security: 'pass' } });
    applyMove(t, { to: 'building', role: 'reviewer', reason: 'design' });
    expect(t.round).toBe(0);
    expect(t.gates).toEqual({ security: 'pass' });
  });
});

describe('other rules', () => {
  it('only qa-writer marks tests ready, and only before building', () => {
    expect(canMarkTestsReady(ticket(), 'builder').ok).toBe(false);
    expect(canMarkTestsReady(ticket(), 'qa-writer').ok).toBe(true);
    expect(canMarkTestsReady(ticket({ state: 'building' }), 'qa-writer').ok).toBe(false);
  });

  it('only security records the security gate, during review', () => {
    const t = ticket({ state: 'in-review' });
    expect(canRecordGate(t, 'security', 'pass', 'reviewer').ok).toBe(false);
    expect(canRecordGate(t, 'security', 'pass', 'security').ok).toBe(true);
    expect(canRecordGate(t, 'security', 'fail', 'security').ok).toBe(false);
    expect(canRecordGate(t, 'security', 'fail', 'security', 'unmarked-risk').ok).toBe(true);
    expect(canRecordGate(ticket({ state: 'in-qa' }), 'security', 'pass', 'security').ok).toBe(false);
  });

  it('limits who files specs and tickets', () => {
    expect(canCreate('spec', 'grill').ok).toBe(true);
    expect(canCreate('spec', 'planner').ok).toBe(false);
    expect(canCreate('build', 'planner').ok).toBe(true);
    expect(canCreate('build', 'builder').ok).toBe(false);
  });
});

describe('specs', () => {
  const spec = ticket({
    id: 1,
    type: 'spec',
    state: 'spec',
    covers: [],
    spec: undefined,
    body: '## Criteria\n- AC-1: add a todo\n- [ ] AC-2: delete a todo\n**AC-3** mark done\nnot AC-4 here',
  });

  it('reads AC-n lines', () => {
    expect(acceptanceCriteria(spec.body)).toEqual(['AC-1', 'AC-2', 'AC-3']);
  });

  it('reports uncovered criteria and open tickets', () => {
    const tickets = [
      ticket({ id: 2, covers: ['AC-1', 'AC-2'], state: 'done', closed: true }),
      ticket({ id: 3, covers: ['AC-3'], spec: 99 }),
    ];
    expect(specStatus(spec, tickets)).toEqual({ criteria: ['AC-1', 'AC-2', 'AC-3'], uncovered: ['AC-3'], openTickets: [] });
  });

  it('closes only when everything is covered and done', () => {
    const open = [ticket({ id: 2, covers: ['AC-1', 'AC-2', 'AC-3'] })];
    expect(canCloseSpec(spec, open, 'planner').ok).toBe(false);
    const done = [ticket({ id: 2, covers: ['AC-1', 'AC-2', 'AC-3'], state: 'done', closed: true })];
    expect(canCloseSpec(spec, done, 'builder').ok).toBe(false);
    expect(canCloseSpec(spec, done, 'planner').ok).toBe(true);
  });
});

describe('pickReady', () => {
  it('returns designed tickets with tests ready and blockers done, by priority then id', () => {
    const tickets = [
      ticket({ id: 5, state: 'designed', testsReady: true, priority: 2 }),
      ticket({ id: 4, state: 'designed', testsReady: true, priority: 2 }),
      ticket({ id: 6, state: 'designed', testsReady: true, priority: 0 }),
      ticket({ id: 7, state: 'designed', testsReady: false }),
      ticket({ id: 8, state: 'designed', testsReady: true, blockedBy: [9] }),
      ticket({ id: 9, state: 'building' }),
      ticket({ id: 11, state: 'designed', testsReady: true, blockedBy: [12] }),
      ticket({ id: 12, state: 'done', closed: true }),
    ];
    expect(pickReady(tickets).map((t) => t.id)).toEqual([6, 4, 5, 11]);
    expect(pickReady(tickets, 2).map((t) => t.id)).toEqual([6, 4]);
  });
});

describe('canMerge', () => {
  const green = { headSha: SHA, open: true, checks: [{ name: 'test', status: 'completed', conclusion: 'success' }] };
  const inQa = ticket({ state: 'in-qa', pr: 5, reviewedSha: SHA });

  it('merges only the reviewed head of an open PR, with every check green', () => {
    expect(canMerge(inQa, 'system', green)).toEqual({ ok: true });
    expect(canMerge(inQa, 'owner', green)).toEqual({ ok: true });
    expect(canMerge(inQa, 'system', { ...green, headSha: 'f'.repeat(40) })).toMatchObject({ error: expect.stringMatching(/not the reviewed/) });
    expect(canMerge(inQa, 'system', { ...green, open: false })).toMatchObject({ error: expect.stringMatching(/not open/) });
    expect(canMerge(ticket({ state: 'in-qa', pr: 5 }), 'system', green)).toMatchObject({ error: expect.stringMatching(/no reviewed commit/) });
  });

  it('refuses agents, other states and checks that are missing, running or red', () => {
    expect(canMerge(inQa, 'qa-reporter', green).ok).toBe(false);
    expect(canMerge(inQa, 'builder', green).ok).toBe(false);
    expect(canMerge({ ...inQa, state: 'in-review' }, 'system', green).ok).toBe(false);
    expect(canMerge({ ...inQa, pr: undefined }, 'system', green).ok).toBe(false);
    expect(canMerge(inQa, 'system', { ...green, checks: [] })).toMatchObject({ error: expect.stringMatching(/no checks/) });
    const running = [{ name: 'test', status: 'in_progress', conclusion: null }];
    expect(canMerge(inQa, 'system', { ...green, checks: running })).toMatchObject({ error: 'checks still running: test' });
    const red = [...green.checks, { name: 'lint', status: 'completed', conclusion: 'failure' }];
    expect(canMerge(inQa, 'system', { ...green, checks: red })).toMatchObject({ error: 'checks failed: lint' });
  });
});
