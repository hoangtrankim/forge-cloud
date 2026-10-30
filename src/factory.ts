// Applies the lifecycle rules against a tracker. Every accepted change is written to the
// ticket, explained in a comment, and reported as an event for the logs.

import {
  DEFAULT_MAX_ROUNDS,
  applyMove,
  canCloseSpec,
  canCreate,
  canEdit,
  canOpenPr,
  canUploadEvidence,
  canMarkTestsReady,
  canMerge,
  canMove,
  canRecordGate,
  pickReady,
  publicInterface,
  specStatus,
  type Check,
  type Gate,
  type GateResult,
  type Priority,
  type Role,
  type SpecStatus,
  type State,
  type Ticket,
  type TicketType,
} from './lifecycle.js';
import type { CodeHost, MergeMethod, PullRequest } from './codehost.js';
import type { Comment, Tracker } from './tracker/tracker.js';

export class RuleError extends Error {}

export interface FactoryEvent {
  at: string;
  kind: 'create' | 'edit' | 'move' | 'mark' | 'gate' | 'close-spec' | 'note' | 'evidence' | 'pr' | 'merge';
  file?: string;
  ticket: number;
  role: Role;
  from?: State;
  to?: State;
  reason?: string;
  round?: number;
  escalated?: boolean;
  gate?: Gate;
  result?: GateResult;
}

export interface FactoryOptions {
  maxRounds?: number;
  onEvent?: (e: FactoryEvent) => void;
  now?: () => Date;
  codeHost?: CodeHost;
  baseBranch?: string;
  mergeMethod?: MergeMethod;
}

export interface CreateInput {
  title: string;
  body?: string;
  type?: TicketType;
  priority?: Priority;
  risky?: boolean;
  components?: string[];
  blockedBy?: number[];
  covers?: string[];
  spec?: number;
}

export type EditInput = Partial<Pick<Ticket, 'title' | 'body' | 'priority' | 'risky' | 'components' | 'blockedBy' | 'covers'>>;

export interface MoveInput {
  to: State;
  role: Role;
  reason?: string;
  note?: string;
  pr?: number;
  sha?: string;
}

// The required commit status that says "the reviewer passed this exact commit".
export const REVIEW_STATUS = 'factory/review';

function check(c: Check): void {
  if (!c.ok) throw new RuleError(c.error);
}

export class Factory {
  private readonly maxRounds: number;

  constructor(
    private readonly tracker: Tracker,
    private readonly opts: FactoryOptions = {},
  ) {
    this.maxRounds = opts.maxRounds ?? DEFAULT_MAX_ROUNDS;
  }

  private emit(e: Omit<FactoryEvent, 'at'>): void {
    this.opts.onEvent?.({ at: (this.opts.now?.() ?? new Date()).toISOString(), ...e });
  }

  async create(input: CreateInput, role: Role): Promise<Ticket> {
    const type = input.type ?? 'build';
    check(canCreate(type, role));
    if (type === 'build') {
      if (!input.spec) throw new RuleError('a ticket needs --spec <issue>');
      const spec = await this.tracker.get(input.spec);
      if (spec.type !== 'spec') throw new RuleError(`#${input.spec} is not a spec`);
      if (!input.covers?.length) throw new RuleError('a ticket needs --covers AC-n[,AC-m]');
    }
    const t = await this.tracker.create({
      title: input.title,
      body: input.body ?? '',
      type,
      state: type === 'spec' ? 'spec' : 'planned',
      priority: input.priority ?? 2,
      risky: input.risky ?? false,
      components: input.components ?? [],
      blockedBy: input.blockedBy ?? [],
      covers: input.covers ?? [],
      spec: input.spec,
    });
    this.emit({ kind: 'create', ticket: t.id, role, to: t.state });
    return t;
  }

  // Planner or owner fixes a ticket's plan (blockers, components, risk) before building starts.
  async edit(id: number, input: EditInput, role: Role, note?: string): Promise<Ticket> {
    const ticket = await this.tracker.get(id);
    check(canEdit(ticket, role));
    const changed = (Object.keys(input) as (keyof EditInput)[]).filter((k) => input[k] !== undefined);
    if (!changed.length) throw new RuleError('edit needs at least one field to change');
    const saved = await this.tracker.update({ ...ticket, ...Object.fromEntries(changed.map((k) => [k, input[k]])) });
    await this.tracker.comment(id, `**${role}** edited ${changed.map((k) => `\`${k}\``).join(', ')}.${note ? `\n\n${note}` : ''}`);
    this.emit({ kind: 'edit', ticket: id, role });
    return saved;
  }

  async move(id: number, input: MoveInput): Promise<Ticket> {
    const ticket = await this.tracker.get(id);
    const openBlockers = await this.openBlockers(ticket);
    check(canMove(ticket, input, { openBlockers }));
    if (input.to === 'in-qa') await this.checkReviewedHead(ticket, input.sha!);

    const { ticket: next, escalated } = applyMove(ticket, input, this.maxRounds);
    const saved = await this.tracker.update(next);

    let text = escalated
      ? `**${input.role}** sent this back, and it reached round ${next.round} of ${this.maxRounds}, so it goes to \`needs-human\``
      : `**${input.role}** moved this from \`${ticket.state}\` to \`${input.to}\``;
    if (input.reason) text += `\n\nReason: \`${input.reason}\``;
    if (!escalated && next.round !== ticket.round) text += ` (round ${next.round} of ${this.maxRounds})`;
    if (input.note) text += `\n\n${input.note}`;
    await this.tracker.comment(id, text);
    if (saved.state === 'in-qa' && saved.reviewedSha && this.opts.codeHost) {
      await this.opts.codeHost.setStatus(saved.reviewedSha, REVIEW_STATUS, 'success', `Reviewed as ticket #${id}`);
    }

    this.emit({
      kind: 'move',
      ticket: id,
      role: input.role,
      from: ticket.state,
      to: saved.state,
      reason: input.reason,
      round: saved.round,
      escalated,
    });
    return saved;
  }

  // The reviewer must have read the commit the PR points at now, or the pass would cover
  // code nobody reviewed.
  private async checkReviewedHead(ticket: Ticket, sha: string): Promise<void> {
    if (!this.opts.codeHost || !ticket.pr) return;
    const pr = await this.opts.codeHost.getPr(ticket.pr);
    if (pr.headSha !== sha) {
      throw new RuleError(`PR #${pr.number} is at ${pr.headSha}, not the reviewed ${sha}; review the new head`);
    }
  }

  async markTestsReady(id: number, role: Role, note?: string): Promise<Ticket> {
    const ticket = await this.tracker.get(id);
    check(canMarkTestsReady(ticket, role));
    const saved = await this.tracker.update({ ...ticket, testsReady: true });
    await this.tracker.comment(id, `**${role}** marked the blind QA tests ready.${note ? `\n\n${note}` : ''}`);
    this.emit({ kind: 'mark', ticket: id, role });
    return saved;
  }

  // A passed gate is recorded on the ticket. A failed blocking gate sends the ticket back.
  async recordGate(id: number, gate: Gate, result: GateResult, role: Role, reason?: string, note?: string): Promise<Ticket> {
    const ticket = await this.tracker.get(id);
    check(canRecordGate(ticket, gate, result, role, reason));
    this.emit({ kind: 'gate', ticket: id, role, gate, result, reason });
    if (result === 'fail') {
      return this.move(id, { to: 'building', role, reason, note: `The ${gate} gate failed.${note ? `\n\n${note}` : ''}` });
    }
    const saved = await this.tracker.update({ ...ticket, gates: { ...ticket.gates, [gate]: 'pass' } });
    await this.tracker.comment(id, `**${role}** passed the \`${gate}\` gate.${note ? `\n\n${note}` : ''}`);
    return saved;
  }

  async specStatus(id: number): Promise<SpecStatus> {
    const spec = await this.tracker.get(id);
    if (spec.type !== 'spec') throw new RuleError(`#${id} is not a spec`);
    return specStatus(spec, await this.tracker.list({ includeClosed: true }));
  }

  async closeSpec(id: number, role: Role): Promise<Ticket> {
    const spec = await this.tracker.get(id);
    check(canCloseSpec(spec, await this.tracker.list({ includeClosed: true }), role));
    const saved = await this.tracker.update({ ...spec, state: 'done', closed: true });
    await this.tracker.comment(id, `**${role}** closed this spec: every criterion is covered and every ticket is done.`);
    this.emit({ kind: 'close-spec', ticket: id, role, from: spec.state, to: 'done' });
    return saved;
  }

  async note(id: number, role: Role, text: string): Promise<void> {
    if (!text.trim()) throw new RuleError('a note needs text');
    await this.tracker.get(id);
    await this.tracker.comment(id, `**${role}** noted:\n\n${text}`);
    this.emit({ kind: 'note', ticket: id, role });
  }

  async evidence(id: number, role: Role, name: string, content: Buffer): Promise<string> {
    check(canUploadEvidence(role));
    await this.tracker.get(id);
    const url = await this.tracker.upload(id, name, content);
    this.emit({ kind: 'evidence', ticket: id, role, file: name });
    return url;
  }

  async comments(id: number): Promise<Comment[]> {
    return this.tracker.comments(id);
  }

  async publicInterface(id: number): Promise<string> {
    const found = publicInterface((await this.tracker.comments(id)).map((c) => c.body));
    if (!found) throw new RuleError(`#${id} has no design note with a "Public interface" section yet`);
    return found;
  }

  // One ticket, one branch (ticket-N), one PR. Returns the open PR if there is one already.
  async openPr(id: number, role: Role, title?: string, body?: string): Promise<PullRequest> {
    const host = this.host();
    const ticket = await this.tracker.get(id);
    check(canOpenPr(ticket, role));
    const branch = `ticket-${id}`;
    const existing = await host.findPr(branch);
    // "Ticket", not "Closes": the ticket is closed by its move to done, not by GitHub.
    const pr =
      existing?.state === 'open'
        ? existing
        : await host.openPr(branch, this.opts.baseBranch ?? 'main', title ?? ticket.title, `${body ? `${body.trim()}\n\n` : ''}Ticket: #${id}`);
    if (ticket.pr === pr.number) return pr;
    await this.tracker.update({ ...ticket, pr: pr.number });
    await this.tracker.comment(id, `**${role}** opened PR #${pr.number}.`);
    this.emit({ kind: 'pr', ticket: id, role });
    return pr;
  }

  // Merges the reviewed commit once CI is green, then marks the ticket done. A risky ticket
  // merges too, with a note asking the owner to look at it afterwards.
  async merge(id: number, role: Role): Promise<Ticket> {
    const host = this.host();
    const ticket = await this.tracker.get(id);
    if (!ticket.pr) throw new RuleError(`#${id} has no PR`);
    const pr = await host.getPr(ticket.pr);
    const checks = pr.merged ? [] : await host.checks(pr.number);
    check(canMerge(ticket, role, { headSha: pr.headSha, open: pr.state === 'open' && !pr.merged, checks }));
    const method = this.opts.mergeMethod ?? 'merge';
    try {
      await host.merge(pr.number, pr.headSha, method);
    } catch (e) {
      throw new RuleError(`GitHub refused to merge PR #${pr.number}: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.emit({ kind: 'merge', ticket: id, role });
    const who = role === 'owner' ? 'the owner' : 'the factory';
    let note = `PR #${pr.number} merged by ${who} (${method}) at the reviewed commit ${pr.headSha}, with every check green.`;
    if (ticket.risky) note += `\n\nThis ticket is marked risky. It merged automatically; the owner should look at it afterwards.`;
    return this.move(id, { to: 'done', role: 'system', note });
  }

  async prOf(id: number): Promise<number> {
    const ticket = await this.tracker.get(id);
    if (!ticket.pr) throw new RuleError(`#${id} has no PR yet`);
    return ticket.pr;
  }

  async diff(id: number): Promise<string> {
    return this.host().diff(await this.prOf(id));
  }

  async checks(id: number) {
    const host = this.host();
    const pr = await host.getPr(await this.prOf(id));
    return { pr: pr.number, headSha: pr.headSha, merged: pr.merged, state: pr.state, checks: await host.checks(pr.number) };
  }

  private host(): CodeHost {
    if (!this.opts.codeHost) throw new Error('no code host configured');
    return this.opts.codeHost;
  }

  async next(limit?: number): Promise<Ticket[]> {
    return pickReady(await this.tracker.list({ includeClosed: true }), limit);
  }

  private async openBlockers(ticket: Ticket): Promise<number[]> {
    const open: number[] = [];
    for (const b of ticket.blockedBy) {
      const t = await this.tracker.get(b).catch(() => undefined);
      if (!t || !(t.closed || t.state === 'done')) open.push(b);
    }
    return open;
  }
}
