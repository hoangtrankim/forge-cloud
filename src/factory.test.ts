import { beforeEach, describe, expect, it } from 'vitest';
import { Factory, RuleError, type FactoryEvent } from './factory.js';
import { MemoryTracker } from './tracker/memory.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';

let tracker: MemoryTracker;
let events: FactoryEvent[];
let factory: Factory;

beforeEach(() => {
  tracker = new MemoryTracker();
  events = [];
  factory = new Factory(tracker, { onEvent: (e) => events.push(e), now: () => new Date('2026-10-27T00:00:00Z') });
});

async function specWithTicket(risky = false) {
  const spec = await factory.create({ title: 'Todo app', type: 'spec', body: '- AC-1: add\n- AC-2: delete' }, 'grill');
  const t = await factory.create({ title: 'Add todo', spec: spec.id, covers: ['AC-1', 'AC-2'], risky }, 'planner');
  return { spec, t };
}

describe('Factory', () => {
  it('runs a ticket from planned to done and closes the spec', async () => {
    const { spec, t } = await specWithTicket();
    expect(t.state).toBe('planned');

    await factory.move(t.id, { to: 'designed', role: 'designer' });
    await factory.markTestsReady(t.id, 'qa-writer');
    await factory.move(t.id, { to: 'building', role: 'builder' });
    await factory.move(t.id, { to: 'in-review', role: 'builder', pr: 42 });
    await factory.move(t.id, { to: 'in-qa', role: 'reviewer', sha: SHA });
    const done = await factory.move(t.id, { to: 'done', role: 'system' });

    expect(done).toMatchObject({ state: 'done', closed: true, pr: 42 });
    const closed = await factory.closeSpec(spec.id, 'planner');
    expect(closed).toMatchObject({ state: 'done', closed: true });
    expect(events.map((e) => e.kind)).toEqual(['create', 'create', 'move', 'mark', 'move', 'move', 'move', 'move', 'close-spec']);
    expect(events[2]).toEqual({
      at: '2026-10-27T00:00:00.000Z',
      kind: 'move',
      ticket: t.id,
      role: 'designer',
      from: 'planned',
      to: 'designed',
      reason: undefined,
      round: 0,
      escalated: false,
    });
  });

  it('refuses a ticket without a spec or covers', async () => {
    await expect(factory.create({ title: 'x' }, 'planner')).rejects.toThrow(RuleError);
    const spec = await factory.create({ title: 's', type: 'spec' }, 'grill');
    await expect(factory.create({ title: 'x', spec: spec.id }, 'planner')).rejects.toThrow(/covers/);
  });

  it('refuses illegal moves and changes nothing', async () => {
    const { t } = await specWithTicket();
    await expect(factory.move(t.id, { to: 'designed', role: 'builder' })).rejects.toThrow(RuleError);
    expect((await tracker.get(t.id)).state).toBe('planned');
    expect(tracker.posted.get(t.id)).toBeUndefined();
    expect(events.filter((e) => e.kind === 'move')).toHaveLength(0);
  });

  it('checks blockers against the tracker', async () => {
    const { spec, t } = await specWithTicket();
    const b = await factory.create({ title: 'Needs add', spec: spec.id, covers: ['AC-2'], blockedBy: [t.id] }, 'planner');
    await factory.move(b.id, { to: 'designed', role: 'designer' });
    await factory.markTestsReady(b.id, 'qa-writer');
    await expect(factory.move(b.id, { to: 'building', role: 'builder' })).rejects.toThrow(`blocked by #${t.id}`);
    await tracker.update({ ...(await tracker.get(t.id)), state: 'done', closed: true });
    await expect(factory.move(b.id, { to: 'building', role: 'builder' })).resolves.toMatchObject({ state: 'building' });
  });

  it('escalates to needs-human on the third send-back and says so', async () => {
    const { t } = await specWithTicket();
    await factory.move(t.id, { to: 'designed', role: 'designer' });
    await factory.markTestsReady(t.id, 'qa-writer');
    await factory.move(t.id, { to: 'building', role: 'builder' });
    for (let round = 1; round <= 3; round++) {
      await factory.move(t.id, { to: 'in-review', role: 'builder', pr: 1 });
      const after = await factory.move(t.id, { to: 'building', role: 'reviewer', reason: 'missing-test' });
      expect(after.round).toBe(round);
      expect(after.state).toBe(round < 3 ? 'building' : 'needs-human');
    }
    expect(tracker.posted.get(t.id)?.at(-1)).toContain('round 3 of 3');
    expect(events.at(-1)).toMatchObject({ escalated: true, to: 'needs-human', reason: 'missing-test' });
  });

  it('passes a review only for the PR head, and marks that commit reviewed', async () => {
    const statuses: string[][] = [];
    let head = 'f'.repeat(40);
    const host = {
      getPr: async (n: number) => ({ number: n, url: 'u', head: 'ticket-2', headSha: head, state: 'open' as const, merged: false }),
      setStatus: async (sha: string, context: string, state: string) => void statuses.push([sha, context, state]),
    };
    factory = new Factory(tracker, { codeHost: host as never });
    const { t } = await specWithTicket();
    await factory.move(t.id, { to: 'designed', role: 'designer' });
    await factory.markTestsReady(t.id, 'qa-writer');
    await factory.move(t.id, { to: 'building', role: 'builder' });
    await factory.move(t.id, { to: 'in-review', role: 'builder', pr: 7 });

    await expect(factory.move(t.id, { to: 'in-qa', role: 'reviewer', sha: SHA })).rejects.toThrow(/review the new head/);
    expect(statuses).toEqual([]);
    head = SHA;
    await expect(factory.move(t.id, { to: 'in-qa', role: 'reviewer', sha: SHA })).resolves.toMatchObject({ reviewedSha: SHA });
    expect(statuses).toEqual([[SHA, 'factory/review', 'success']]);
  });

  it('runs the security gate on risky tickets', async () => {
    const { t } = await specWithTicket(true);
    await factory.move(t.id, { to: 'designed', role: 'designer' });
    await factory.markTestsReady(t.id, 'qa-writer');
    await factory.move(t.id, { to: 'building', role: 'builder' });
    await factory.move(t.id, { to: 'in-review', role: 'builder', pr: 1 });

    await expect(factory.move(t.id, { to: 'in-qa', role: 'reviewer', sha: SHA })).rejects.toThrow(/security gate/);

    const failed = await factory.recordGate(t.id, 'security', 'fail', 'security', 'unmarked-risk');
    expect(failed).toMatchObject({ state: 'building', round: 1 });

    await factory.move(t.id, { to: 'in-review', role: 'builder' });
    await factory.recordGate(t.id, 'security', 'pass', 'security');
    await expect(factory.move(t.id, { to: 'in-qa', role: 'reviewer', sha: SHA })).resolves.toMatchObject({ state: 'in-qa' });
  });

  it('lists what a builder can start next', async () => {
    const { t } = await specWithTicket();
    expect(await factory.next()).toEqual([]);
    await factory.move(t.id, { to: 'designed', role: 'designer' });
    await factory.markTestsReady(t.id, 'qa-writer');
    expect((await factory.next()).map((x) => x.id)).toEqual([t.id]);
  });

  it('respects maxRounds from options', async () => {
    const f = new Factory(tracker, { maxRounds: 1 });
    const { t } = await specWithTicket();
    await f.move(t.id, { to: 'designed', role: 'designer' });
    await f.markTestsReady(t.id, 'qa-writer');
    await f.move(t.id, { to: 'building', role: 'builder' });
    await f.move(t.id, { to: 'in-review', role: 'builder', pr: 1 });
    await expect(f.move(t.id, { to: 'building', role: 'reviewer', reason: 'design' })).resolves.toMatchObject({
      state: 'needs-human',
    });
  });
});
