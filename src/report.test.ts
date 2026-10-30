import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from './cli.js';
import type { FactoryEvent } from './factory.js';
import { formatReport, reviewerReport, type RunLine } from './report.js';
import { MemoryTracker } from './tracker/memory.js';

const move = (at: string, ticket: number, role: string, from: string, to: string, reason?: string, round = 0): FactoryEvent =>
  ({ at, kind: 'move', ticket, role, from, to, reason, round }) as FactoryEvent;

const day = (d: string) => [new Date(`${d}T00:00:00Z`), new Date(Date.parse(`${d}T00:00:00Z`) + 86400000)] as const;

const events: FactoryEvent[] = [
  // #2: passed yesterday, QA sent it back today, so the escape counts today.
  move('2026-10-27T10:00:00Z', 2, 'reviewer', 'in-review', 'in-qa'),
  move('2026-10-28T09:00:00Z', 2, 'qa-reporter', 'in-qa', 'building', 'wrong-behavior', 1),
  // #3: sent back for quality, then passed, pushed after review, passed again and merged.
  move('2026-10-28T10:00:00Z', 3, 'reviewer', 'in-review', 'building', 'quality', 1),
  move('2026-10-28T11:00:00Z', 3, 'reviewer', 'in-review', 'in-qa', undefined, 1),
  move('2026-10-28T11:30:00Z', 3, 'system', 'in-qa', 'in-review', undefined, 1),
  move('2026-10-28T12:00:00Z', 3, 'reviewer', 'in-review', 'in-qa', undefined, 1),
  move('2026-10-28T13:00:00Z', 3, 'system', 'in-qa', 'done', undefined, 1),
  // #4: a builder send-back is not a review.
  move('2026-10-28T14:00:00Z', 4, 'builder', 'building', 'designed', 'flawed-test', 1),
];
const runs: RunLine[] = [
  { at: '2026-10-28T10:00:00Z', ticket: 3, agent: 'reviewer', ok: true, durationMs: 600000, costUsd: 1.5 },
  { at: '2026-10-28T11:00:00Z', ticket: 3, agent: 'reviewer', ok: false, durationMs: 300000, costUsd: 0.5 },
  { at: '2026-10-28T11:00:00Z', ticket: 3, agent: 'builder', ok: true, durationMs: 300000, costUsd: 9 },
];

describe('reviewer report', () => {
  it('counts reviews, send-backs, re-reviews and escapes in the window', () => {
    const r = reviewerReport(events, runs, ...day('2026-10-28'));
    expect(r).toMatchObject({
      reviews: 3,
      passes: 2,
      sendBacks: { quality: 1 },
      reReviews: 1,
      escapes: [{ ticket: 2, by: 'qa-reporter', reason: 'wrong-behavior' }],
      done: [{ ticket: 3, round: 1 }],
      runs: { count: 2, failed: 1, costUsd: 2, minutes: 15 },
    });
    const text = formatReport(r);
    expect(text).toContain('Reviews: 3 (2 passed, 1 sent back, pass rate 67%)');
    expect(text).toContain('Escapes: 1 (#2 by qa-reporter, wrong-behavior)');
  });

  it('does not count a re-review or a merge as an escape', () => {
    expect(reviewerReport(events, runs, ...day('2026-10-27'))).toMatchObject({ reviews: 1, passes: 1, escapes: [] });
    const only3 = events.filter((e) => e.ticket === 3);
    expect(reviewerReport(only3, [], ...day('2026-10-28')).escapes).toEqual([]);
  });

  it('prints from the log folder with forge report', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-report-'));
    writeFileSync(join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\nnot json\n');
    const lines: string[] = [];
    const code = await run(['report', '--days', '1'], {
      tracker: new MemoryTracker(),
      logDir: dir,
      out: (s) => lines.push(s),
      now: () => new Date('2026-10-28T23:00:00Z'),
    });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('Escapes: 1');
  });
});
