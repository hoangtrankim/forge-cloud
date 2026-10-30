// The routing table: which agent works on which ticket next. Pure, so every route is unit
// tested. The dispatcher gathers the facts (tickets, spec coverage, PR state) and asks here.

import type { Role, SpecStatus, Ticket } from './lifecycle.js';

export type AgentRole = Exclude<Role, 'grill' | 'owner' | 'system'>;

export interface PrFacts {
  headSha: string;
  merged: boolean;
  // Every check has finished (passed or failed). No checks yet counts as not finished.
  checksDone: boolean;
  // Every check finished and passed.
  checksGreen: boolean;
  // Main moved on since the branch was made; branch protection refuses to merge it as it is.
  behind?: boolean;
}

export interface Snapshot {
  tickets: Ticket[];
  specs: Array<{ spec: Ticket; status: SpecStatus }>;
  // Only for tickets in in-qa.
  prs: Map<number, PrFacts>;
  // Head SHAs the qa-reporter has already reported on, per ticket.
  reported: Map<number, Set<string>>;
}

export type Step =
  | { kind: 'agent'; agent: AgentRole; ticket: number; prompt: string; rule: string }
  | { kind: 'mark-done'; ticket: number; rule: string }
  | { kind: 'merge'; ticket: number; rule: string }
  | { kind: 're-review'; ticket: number; rule: string }
  | { kind: 'update-branch'; ticket: number; rule: string };

interface Rule {
  name: string;
  match: (t: Ticket, s: Snapshot, done: Set<number>) => boolean;
  step: (t: Ticket) => Step;
}

const agent = (role: AgentRole, prompt: (t: Ticket) => string, rule: string) => (t: Ticket): Step => ({
  kind: 'agent',
  agent: role,
  ticket: t.id,
  prompt: prompt(t),
  rule,
});

const ticketPrompt = (t: Ticket) => `Ticket ${t.id}${t.spec ? ` (spec ${t.spec})` : ''}. Follow your prompt.`;
const build = (t: Ticket) => t.type === 'build' && !t.closed;
const reviewedHead = (t: Ticket, s: Snapshot) => !!t.reviewedSha && s.prs.get(t.id)?.headSha === t.reviewedSha;
const reportedHead = (t: Ticket, s: Snapshot) => {
  const pr = s.prs.get(t.id);
  return !!pr && !pr.merged && reviewedHead(t, s) && pr.checksDone && !!s.reported.get(t.id)?.has(pr.headSha);
};

// Checked in order; the first rule with a matching ticket wins. Finishing work comes before
// starting new work, so a ticket in review is never starved by fresh designs.
export const ROUTES: readonly Rule[] = [
  {
    name: 'merged-pr',
    match: (t, s) => build(t) && t.state === 'in-qa' && !!s.prs.get(t.id)?.merged,
    step: (t) => ({ kind: 'mark-done', ticket: t.id, rule: 'merged-pr' }),
  },
  {
    // New commits after the review: they are unreviewed, so the ticket goes back to review.
    name: 'pushed-after-review',
    match: (t, s) => build(t) && t.state === 'in-qa' && !reviewedHead(t, s) && !s.prs.get(t.id)?.merged && s.prs.has(t.id),
    step: (t) => ({ kind: 're-review', ticket: t.id, rule: 'pushed-after-review' }),
  },
  {
    // Reviewed, but main moved on: bring main in first. That is a new head, so it is reviewed
    // and tested again before it can merge, without costing a round.
    name: 'behind-main',
    match: (t, s) => build(t) && t.state === 'in-qa' && reviewedHead(t, s) && !s.prs.get(t.id)?.merged && !!s.prs.get(t.id)?.behind,
    step: (t) => ({ kind: 'update-branch', ticket: t.id, rule: 'behind-main' }),
  },
  {
    // Reviewed, green, and the qa-reporter posted its evidence for this commit: merge it.
    // A red PR the qa-reporter left in in-qa is not merged; it waits for the owner.
    name: 'merge-green',
    match: (t, s) => build(t) && t.state === 'in-qa' && reportedHead(t, s) && !!s.prs.get(t.id)?.checksGreen,
    step: (t) => ({ kind: 'merge', ticket: t.id, rule: 'merge-green' }),
  },
  {
    name: 'qa-report',
    match: (t, s) => {
      const pr = s.prs.get(t.id);
      return build(t) && t.state === 'in-qa' && !!pr && reviewedHead(t, s) && pr.checksDone && !s.reported.get(t.id)?.has(pr.headSha);
    },
    step: agent('qa-reporter', ticketPrompt, 'qa-report'),
  },
  {
    name: 'security-gate',
    match: (t) => build(t) && t.state === 'in-review' && t.risky && t.gates.security !== 'pass',
    step: agent('security', ticketPrompt, 'security-gate'),
  },
  {
    name: 'review',
    match: (t) => build(t) && t.state === 'in-review',
    step: agent('reviewer', ticketPrompt, 'review'),
  },
  {
    name: 'continue-build',
    match: (t) => build(t) && t.state === 'building',
    step: agent('builder', ticketPrompt, 'continue-build'),
  },
  {
    name: 'start-build',
    match: (t, _s, done) => build(t) && t.state === 'designed' && t.testsReady && t.blockedBy.every((b) => done.has(b)),
    step: agent('builder', ticketPrompt, 'start-build'),
  },
  {
    name: 'write-tests',
    match: (t) => build(t) && t.state === 'designed' && !t.testsReady,
    step: agent('qa-writer', ticketPrompt, 'write-tests'),
  },
  {
    name: 'design',
    match: (t) => build(t) && t.state === 'planned',
    step: agent('designer', ticketPrompt, 'design'),
  },
];

const byPriority = (a: Ticket, b: Ticket) => a.priority - b.priority || a.id - b.id;

// `skip` holds "agent:ticket" keys the dispatcher has given up on (an agent run changed nothing).
export function route(s: Snapshot, skip: ReadonlySet<string> = new Set()): Step | undefined {
  const allowed = (step: Step) => step.kind !== 'agent' || !skip.has(`${step.agent}:${step.ticket}`);

  // A new spec is split before anything else, so its tickets join the queue.
  for (const { spec, status } of [...s.specs].sort((a, b) => byPriority(a.spec, b.spec))) {
    if (spec.closed || status.uncovered.length === 0) continue;
    const step: Step = { kind: 'agent', agent: 'planner', ticket: spec.id, prompt: `Split spec ${spec.id}.`, rule: 'split-spec' };
    if (allowed(step)) return step;
  }

  const done = new Set(s.tickets.filter((t) => t.closed || t.state === 'done').map((t) => t.id));
  const tickets = [...s.tickets].sort(byPriority);
  for (const rule of ROUTES) {
    for (const t of tickets) {
      if (!rule.match(t, s, done)) continue;
      const step = rule.step(t);
      if (allowed(step)) return step;
    }
  }

  for (const { spec, status } of s.specs) {
    if (spec.closed || status.criteria.length === 0 || status.uncovered.length || status.openTickets.length) continue;
    const step: Step = { kind: 'agent', agent: 'planner', ticket: spec.id, prompt: `Close spec ${spec.id}.`, rule: 'close-spec' };
    if (allowed(step)) return step;
  }
  return undefined;
}

// Tickets that wait on the owner rather than an agent, for the dispatcher's report.
export function waitingOnOwner(s: Snapshot): { needsHuman: number[] } {
  const open = s.tickets.filter(build);
  return {
    // A red PR the qa-reporter reported on but did not send back also waits on the owner.
    needsHuman: open
      .filter((t) => t.state === 'needs-human' || t.state === 'blocked' || (t.state === 'in-qa' && reportedHead(t, s) && !s.prs.get(t.id)?.checksGreen))
      .map((t) => t.id),
  };
}
