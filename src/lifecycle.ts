// The ticket state machine. Pure functions only: no I/O, so every rule is unit tested.
//
// Judgement lives in agent prompts, rules live here, state lives in the tracker.
// Agents never set labels themselves; they ask the CLI, and the CLI asks this file.

export const BUILD_STATES = [
  'planned',
  'designed',
  'building',
  'in-review',
  'in-qa',
  'done',
  'blocked',
  'needs-human',
] as const;

// A spec issue is either open ("spec") or closed once every ticket covering it is done.
export const STATES = ['spec', ...BUILD_STATES] as const;
export type State = (typeof STATES)[number];

export const ROLES = [
  'grill',
  'planner',
  'designer',
  'qa-writer',
  'builder',
  'reviewer',
  'qa-reporter',
  'security',
  'owner',
  'system',
] as const;
export type Role = (typeof ROLES)[number];

// Every send-back names one of these, so the retro can count them.
export const SEND_BACK_REASONS = [
  'spec-gap',
  'wrong-behavior',
  'missing-test',
  'failing-check',
  'scope-creep',
  'design',
  'quality',
  'unmarked-risk',
  'flawed-test',
] as const;
export type SendBackReason = (typeof SEND_BACK_REASONS)[number];

export const GATES = ['security'] as const;
export type Gate = (typeof GATES)[number];
export type GateResult = 'pass' | 'fail';

export type TicketType = 'spec' | 'build';
export type Priority = 0 | 1 | 2 | 3;

export interface Ticket {
  id: number;
  title: string;
  body: string;
  type: TicketType;
  state: State;
  priority: Priority;
  round: number;
  risky: boolean;
  testsReady: boolean;
  gates: Partial<Record<Gate, GateResult>>;
  components: string[];
  blockedBy: number[];
  covers: string[];
  spec?: number;
  pr?: number;
  // The PR commit the reviewer passed. Only that commit may merge.
  reviewedSha?: string;
  closed: boolean;
}

export const DEFAULT_MAX_ROUNDS = 3;

const AGENT_ROLES: readonly Role[] = [
  'planner',
  'designer',
  'qa-writer',
  'builder',
  'reviewer',
  'qa-reporter',
  'security',
];

type MoveKind = 'forward' | 'send-back' | 'side';

interface Rule {
  from: State | '*';
  to: State;
  roles: readonly Role[];
  kind: MoveKind;
}

// The only legal moves for build tickets. Anything not listed is refused.
export const RULES: readonly Rule[] = [
  { from: 'planned', to: 'designed', roles: ['designer'], kind: 'forward' },
  { from: 'designed', to: 'building', roles: ['builder'], kind: 'forward' },
  { from: 'building', to: 'in-review', roles: ['builder'], kind: 'forward' },
  { from: 'in-review', to: 'in-qa', roles: ['reviewer'], kind: 'forward' },
  { from: 'in-qa', to: 'done', roles: ['system'], kind: 'forward' },
  // The PR got new commits after the review passed, so it needs a new review. Not a round.
  { from: 'in-qa', to: 'in-review', roles: ['system'], kind: 'side' },
  { from: 'in-review', to: 'building', roles: ['reviewer', 'security'], kind: 'send-back' },
  { from: 'in-qa', to: 'building', roles: ['qa-reporter', 'system'], kind: 'send-back' },
  // An acceptance test that does not test what its criterion says goes back to the qa-writer.
  { from: 'building', to: 'designed', roles: ['builder'], kind: 'send-back' },
  { from: 'in-review', to: 'designed', roles: ['reviewer'], kind: 'send-back' },
  { from: '*', to: 'blocked', roles: [...AGENT_ROLES, 'owner'], kind: 'side' },
  { from: '*', to: 'needs-human', roles: [...AGENT_ROLES, 'owner', 'system'], kind: 'side' },
  { from: 'blocked', to: 'planned', roles: ['planner', 'owner'], kind: 'side' },
  { from: 'needs-human', to: 'planned', roles: ['planner', 'owner'], kind: 'side' },
];

export type Check = { ok: true } | { ok: false; error: string };

const ok: Check = { ok: true };
const refuse = (error: string): Check => ({ ok: false, error });

export interface MoveRequest {
  to: State;
  role: Role;
  reason?: string;
  pr?: number;
  // The PR head commit the reviewer read; required to pass a review.
  sha?: string;
}

// Facts about other tickets that a rule needs; the caller looks them up in the tracker.
export interface MoveContext {
  openBlockers: number[];
}

export function findRule(from: State, to: State, role: Role): Rule | undefined {
  return RULES.find((r) => (r.from === from || r.from === '*') && r.to === to && r.roles.includes(role));
}

export function canMove(ticket: Ticket, req: MoveRequest, ctx: MoveContext = { openBlockers: [] }): Check {
  if (ticket.type === 'spec') return refuse(`#${ticket.id} is a spec; specs close with "forge close-spec"`);
  if (ticket.closed || ticket.state === 'done') return refuse(`#${ticket.id} is done`);
  if (ticket.state === req.to) return refuse(`#${ticket.id} is already ${req.to}`);

  const rule = findRule(ticket.state, req.to, req.role);
  if (!rule) {
    const allowed = RULES.filter((r) => (r.from === ticket.state || r.from === '*') && r.to === req.to)
      .flatMap((r) => r.roles)
      .join(', ');
    return refuse(
      allowed
        ? `${req.role} may not move #${ticket.id} from ${ticket.state} to ${req.to} (allowed: ${allowed})`
        : `no move from ${ticket.state} to ${req.to}`,
    );
  }

  if (rule.kind === 'send-back') {
    if (!req.reason) return refuse(`a send-back needs --reason (${SEND_BACK_REASONS.join(', ')})`);
    if (!isSendBackReason(req.reason)) return refuse(`unknown send-back reason "${req.reason}"`);
    if ((req.to === 'designed') !== (req.reason === 'flawed-test')) {
      return refuse(`only a flawed-test send-back goes to designed, and it always goes there`);
    }
  }
  if ((req.to === 'blocked' || req.to === 'needs-human') && !req.reason) {
    return refuse(`moving to ${req.to} needs --reason`);
  }

  if (req.to === 'building' && rule.kind === 'forward') {
    if (!ticket.testsReady) return refuse(`#${ticket.id} has no blind QA tests yet (qa-writer must mark tests-ready)`);
    if (ctx.openBlockers.length > 0) {
      return refuse(`#${ticket.id} is blocked by ${ctx.openBlockers.map((n) => `#${n}`).join(', ')}`);
    }
  }
  if (req.to === 'in-review' && !(req.pr ?? ticket.pr)) return refuse(`moving to in-review needs --pr`);
  if (req.to === 'in-qa' && ticket.risky && ticket.gates.security !== 'pass') {
    return refuse(`#${ticket.id} is risky and has not passed the security gate`);
  }
  if (req.to === 'in-qa' && !/^[0-9a-f]{40}$/.test(req.sha ?? '')) {
    return refuse(`passing a review needs --sha <the full commit you reviewed>`);
  }
  if (req.to === 'done' && !ticket.pr) return refuse(`#${ticket.id} has no PR`);

  return ok;
}

export function isSendBack(from: State, to: State, role: Role): boolean {
  return findRule(from, to, role)?.kind === 'send-back';
}

export function isSendBackReason(s: string): s is SendBackReason {
  return (SEND_BACK_REASONS as readonly string[]).includes(s);
}

export function isState(s: string): s is State {
  return (STATES as readonly string[]).includes(s);
}

export function isRole(s: string): s is Role {
  return (ROLES as readonly string[]).includes(s);
}

export interface Applied {
  ticket: Ticket;
  escalated: boolean;
}

// Applies a move that canMove already accepted. A send-back costs a round and clears gate
// results so they run again; the round that reaches maxRounds goes to needs-human instead.
export function applyMove(ticket: Ticket, req: MoveRequest, maxRounds = DEFAULT_MAX_ROUNDS): Applied {
  const next: Ticket = { ...ticket, gates: { ...ticket.gates } };
  if (req.pr) next.pr = req.pr;
  // A review covers one commit: passing records it, any other move forgets it.
  next.reviewedSha = req.to === 'in-qa' ? req.sha : undefined;

  if (isSendBack(ticket.state, req.to, req.role)) {
    next.round = ticket.round + 1;
    next.gates = {};
    if (req.to === 'designed') next.testsReady = false;
    if (next.round >= maxRounds) {
      next.state = 'needs-human';
      return { ticket: next, escalated: true };
    }
  }
  next.state = req.to;
  if (req.to === 'done') next.closed = true;
  return { ticket: next, escalated: false };
}

export function canMarkTestsReady(ticket: Ticket, role: Role): Check {
  if (role !== 'qa-writer') return refuse(`only qa-writer may mark tests-ready`);
  if (ticket.type !== 'build') return refuse(`#${ticket.id} is a spec`);
  if (ticket.state !== 'planned' && ticket.state !== 'designed') {
    return refuse(`tests can only be marked ready before building (#${ticket.id} is ${ticket.state})`);
  }
  return ok;
}

export function canRecordGate(ticket: Ticket, gate: Gate, result: GateResult, role: Role, reason?: string): Check {
  if (gate === 'security' && role !== 'security') return refuse(`only security may record the security gate`);
  if (ticket.state !== 'in-review') return refuse(`gates run while in-review (#${ticket.id} is ${ticket.state})`);
  if (result === 'fail') {
    if (!reason || !isSendBackReason(reason)) return refuse(`a failed gate needs a send-back --reason`);
  }
  return ok;
}

export function canCreate(type: TicketType, role: Role): Check {
  if (type === 'spec' && role !== 'grill' && role !== 'owner') return refuse(`only grill or owner may file a spec`);
  if (type === 'build' && role !== 'planner' && role !== 'owner') return refuse(`only planner or owner may file a ticket`);
  return ok;
}

// Planner and owner may correct a ticket's plan until building starts.
export function canEdit(ticket: Ticket, role: Role): Check {
  if (role !== 'planner' && role !== 'owner') return refuse(`only planner or owner may edit a ticket`);
  if (ticket.type !== 'build') return refuse(`#${ticket.id} is a spec`);
  const editable: State[] = ['planned', 'designed', 'blocked', 'needs-human'];
  if (!editable.includes(ticket.state)) return refuse(`#${ticket.id} is ${ticket.state}; tickets can be edited before building`);
  return ok;
}

export function canOpenPr(ticket: Ticket, role: Role): Check {
  if (role !== 'builder' && role !== 'owner') return refuse(`only builder may open a PR`);
  if (ticket.type !== 'build') return refuse(`#${ticket.id} is a spec`);
  if (ticket.state !== 'building') return refuse(`open the PR while building (#${ticket.id} is ${ticket.state})`);
  return ok;
}

// The designer's note is a comment with a "Public interface" section; the qa-writer reads
// only that section, so the tests stay blind to how the ticket gets built.
export function publicInterface(comments: string[]): string | undefined {
  for (const body of [...comments].reverse()) {
    const m = /^(#{2,4})\s+Public interface\b.*$/im.exec(body);
    if (!m) continue;
    const level = m[1]!.length;
    const rest = body.slice(m.index);
    const lines = rest.split('\n');
    const end = lines.findIndex((l, i) => i > 0 && new RegExp(`^#{1,${level}}\\s`).test(l));
    return (end === -1 ? lines : lines.slice(0, end)).join('\n').trim();
  }
  return undefined;
}

// What the code host says about a PR right before a merge.
export interface MergeFacts {
  headSha: string;
  open: boolean;
  checks: Array<{ name: string; status: string; conclusion: string | null }>;
}

export const PASSED_CONCLUSIONS = ['success', 'neutral', 'skipped'];

// Only the commit the reviewer passed may merge, and only once every check on it is green.
// The host's branch protection checks again; this refuses early with a reason.
export function canMerge(ticket: Ticket, role: Role, pr: MergeFacts): Check {
  if (role !== 'system' && role !== 'owner') return refuse(`only the dispatcher or the owner may merge`);
  if (ticket.type !== 'build') return refuse(`#${ticket.id} is a spec`);
  if (ticket.state !== 'in-qa') return refuse(`merge from in-qa (#${ticket.id} is ${ticket.state})`);
  if (!ticket.pr) return refuse(`#${ticket.id} has no PR`);
  if (!pr.open) return refuse(`PR #${ticket.pr} is not open`);
  if (!ticket.reviewedSha) return refuse(`#${ticket.id} has no reviewed commit`);
  if (pr.headSha !== ticket.reviewedSha) return refuse(`PR #${ticket.pr} is at ${pr.headSha}, not the reviewed ${ticket.reviewedSha}`);
  if (!pr.checks.length) return refuse(`PR #${ticket.pr} has no checks yet`);
  const waiting = pr.checks.filter((c) => c.status !== 'completed');
  if (waiting.length) return refuse(`checks still running: ${waiting.map((c) => c.name).join(', ')}`);
  const red = pr.checks.filter((c) => !PASSED_CONCLUSIONS.includes(c.conclusion ?? ''));
  if (red.length) return refuse(`checks failed: ${red.map((c) => c.name).join(', ')}`);
  return ok;
}

export function canUploadEvidence(role: Role): Check {
  if (role !== 'qa-reporter' && role !== 'system' && role !== 'owner') return refuse(`only qa-reporter may upload evidence`);
  return ok;
}

// Acceptance criteria are lines in the spec body that start with "AC-<n>".
export function acceptanceCriteria(specBody: string): string[] {
  const found = new Set<string>();
  for (const line of specBody.split('\n')) {
    const m = /^\s*(?:[-*]\s+)?(?:\[[ x]\]\s+)?\**(AC-\d+)\b/.exec(line);
    if (m?.[1]) found.add(m[1]);
  }
  return [...found];
}

export interface SpecStatus {
  criteria: string[];
  uncovered: string[];
  openTickets: number[];
}

export function specStatus(spec: Ticket, tickets: Ticket[]): SpecStatus {
  const criteria = acceptanceCriteria(spec.body);
  const mine = tickets.filter((t) => t.type === 'build' && t.spec === spec.id);
  const covered = new Set(mine.flatMap((t) => t.covers));
  return {
    criteria,
    uncovered: criteria.filter((c) => !covered.has(c)),
    openTickets: mine.filter((t) => !(t.closed || t.state === 'done')).map((t) => t.id),
  };
}

export function canCloseSpec(spec: Ticket, tickets: Ticket[], role: Role): Check {
  if (spec.type !== 'spec') return refuse(`#${spec.id} is not a spec`);
  if (role !== 'planner' && role !== 'owner') return refuse(`only planner or owner may close a spec`);
  const s = specStatus(spec, tickets);
  if (s.criteria.length === 0) return refuse(`spec #${spec.id} has no AC-n criteria`);
  if (s.uncovered.length) return refuse(`criteria not covered by any ticket: ${s.uncovered.join(', ')}`);
  if (s.openTickets.length) return refuse(`tickets still open: ${s.openTickets.map((n) => `#${n}`).join(', ')}`);
  return ok;
}

// Tickets a builder may start now: designed, tests ready, blockers done; by priority, then id.
export function pickReady(tickets: Ticket[], limit = Infinity): Ticket[] {
  const done = new Set(tickets.filter((t) => t.closed || t.state === 'done').map((t) => t.id));
  return tickets
    .filter((t) => t.type === 'build' && t.state === 'designed' && t.testsReady && !t.closed)
    .filter((t) => t.blockedBy.every((b) => done.has(b)))
    .sort((a, b) => a.priority - b.priority || a.id - b.id)
    .slice(0, limit);
}
