// The end-of-day reviewer report, read from the logs. With no human reading PRs, this is how
// the owner sees whether the reviewer can be trusted: how often it passes, why it sends work
// back, and how often a PR it passed failed later anyway (an escape).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FactoryEvent } from './factory.js';
import { isSendBackReason } from './lifecycle.js';

export interface RunLine {
  at: string;
  ticket: number;
  agent: string;
  ok: boolean;
  durationMs: number;
  costUsd?: number;
}

export interface Escape {
  ticket: number;
  // Who caught what the reviewer passed, and why.
  by: string;
  reason?: string;
  at: string;
}

export interface ReviewerReport {
  from: string;
  to: string;
  reviews: number;
  passes: number;
  sendBacks: Record<string, number>;
  // Passed PRs that got new commits, so the reviewer had to read them again.
  reReviews: number;
  escapes: Escape[];
  // Tickets that reached done in the window, with the rounds each took.
  done: Array<{ ticket: number; round: number }>;
  runs: { count: number; failed: number; costUsd: number; minutes: number };
}

export function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as T];
      } catch {
        return [];
      }
    });
}

const inWindow = (at: string, from: Date, to: Date) => {
  const t = Date.parse(at);
  return t >= from.getTime() && t < to.getTime();
};

// `events` should hold the whole log, not just the window: an escape today can follow a pass
// from an earlier day.
export function reviewerReport(events: FactoryEvent[], runs: RunLine[], from: Date, to: Date): ReviewerReport {
  const moves = events.filter((e) => e.kind === 'move').sort((a, b) => a.at.localeCompare(b.at));
  const report: ReviewerReport = {
    from: from.toISOString(),
    to: to.toISOString(),
    reviews: 0,
    passes: 0,
    sendBacks: {},
    reReviews: 0,
    escapes: [],
    done: [],
    runs: { count: 0, failed: 0, costUsd: 0, minutes: 0 },
  };
  // Tickets whose latest review passed and has not been undone since.
  const passed = new Set<number>();

  for (const e of moves) {
    const now = inWindow(e.at, from, to);
    if (e.role === 'reviewer' && e.from === 'in-review') {
      if (e.to === 'in-qa') passed.add(e.ticket);
      else passed.delete(e.ticket);
      if (!now) continue;
      report.reviews++;
      if (e.to === 'in-qa') report.passes++;
      else report.sendBacks[e.reason ?? 'unknown'] = (report.sendBacks[e.reason ?? 'unknown'] ?? 0) + 1;
      continue;
    }
    if (e.from === 'in-qa' && e.to === 'in-review') {
      passed.delete(e.ticket);
      if (now) report.reReviews++;
      continue;
    }
    // Anything that sends a passed ticket back from QA is a miss the reviewer let through.
    if (e.from === 'in-qa' && e.to !== 'done' && passed.has(e.ticket) && e.reason && isSendBackReason(e.reason)) {
      passed.delete(e.ticket);
      if (now) report.escapes.push({ ticket: e.ticket, by: e.role, reason: e.reason, at: e.at });
      continue;
    }
    if (e.to === 'done') {
      passed.delete(e.ticket);
      if (now) report.done.push({ ticket: e.ticket, round: e.round ?? 0 });
    }
  }

  for (const r of runs) {
    if (r.agent !== 'reviewer' || !inWindow(r.at, from, to)) continue;
    report.runs.count++;
    if (!r.ok) report.runs.failed++;
    report.runs.costUsd += r.costUsd ?? 0;
    report.runs.minutes += r.durationMs / 60000;
  }
  return report;
}

const pct = (n: number, of: number) => (of ? `${Math.round((100 * n) / of)}%` : 'n/a');

export function formatReport(r: ReviewerReport): string {
  const sendBacks = Object.entries(r.sendBacks).sort((a, b) => b[1] - a[1]);
  const totalSendBacks = sendBacks.reduce((n, [, c]) => n + c, 0);
  const rounds = r.done.reduce((n, d) => n + d.round, 0);
  const lines = [
    `# Reviewer report, ${r.from.slice(0, 10)}${r.to.slice(0, 10) !== r.from.slice(0, 10) ? ` to ${r.to.slice(0, 10)}` : ''}`,
    '',
    `Reviews: ${r.reviews} (${r.passes} passed, ${totalSendBacks} sent back, pass rate ${pct(r.passes, r.reviews)})`,
    `Send-backs: ${sendBacks.length ? sendBacks.map(([k, c]) => `${k} ${c}`).join(', ') : 'none'}`,
    `Escapes: ${r.escapes.length}${r.escapes.length ? ` (${r.escapes.map((e) => `#${e.ticket} by ${e.by}, ${e.reason}`).join('; ')})` : ''}`,
    `Re-reviews after a push: ${r.reReviews}`,
    `Done: ${r.done.length} ticket${r.done.length === 1 ? '' : 's'}${r.done.length ? `, ${(rounds / r.done.length).toFixed(1)} send-back rounds on average` : ''}`,
    `Reviewer runs: ${r.runs.count}${r.runs.failed ? ` (${r.runs.failed} failed)` : ''}, ${Math.round(r.runs.minutes)} min, $${r.runs.costUsd.toFixed(2)}`,
    '',
    'An escape is a PR the reviewer passed that QA or the owner sent back later. Mistakes nobody has found yet do not show here.',
  ];
  return lines.join('\n');
}

export function loadLogs(dir: string): { events: FactoryEvent[]; runs: RunLine[] } {
  return { events: readJsonl<FactoryEvent>(join(dir, 'events.jsonl')), runs: readJsonl<RunLine>(join(dir, 'runs.jsonl')) };
}
