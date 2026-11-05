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
  canHandToReview,
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
import {
  DEFAULT_HOLD_HOURS,
  DEFAULT_RISK_RULES,
  HELD_LABEL,
  HOLD_LABEL,
  APPROVE_LABEL,
  RISK_FILE,
  assessDiff,
  holdDecision,
  holdMarker,
  needsSecurity,
  parseRiskRules,
  stricter,
  type Assessment,
  type RiskRules,
  type RiskTier,
} from './risk.js';
import type { ReviewStatusBy } from './config.js';
import type { Comment, Tracker } from './tracker/tracker.js';

export class RuleError extends Error {}

export interface FactoryEvent {
  at: string;
  kind: 'create' | 'edit' | 'move' | 'mark' | 'gate' | 'close-spec' | 'note' | 'evidence' | 'pr' | 'merge' | 'risk' | 'hold';
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
  risk?: RiskTier;
}

export interface FactoryOptions {
  maxRounds?: number;
  onEvent?: (e: FactoryEvent) => void;
  now?: () => Date;
  codeHost?: CodeHost;
  baseBranch?: string;
  mergeMethod?: MergeMethod;
  // 'gate': the reviewer's pass only records the reviewed commit, and merge() posts the
  // factory/review status just before it merges (see Config.reviewStatus).
  reviewStatus?: ReviewStatusBy;
  // The login whose hand-added `approve` label merges a held PR early.
  owner?: string;
  holdHours?: number;
  // The risk rules; by default risk.yml on the base branch, read through the code host.
  riskRules?: () => Promise<RiskRules>;
}

// What the merge gate did with a reviewed, green, QA-reported PR.
export type GateOutcome =
  | { kind: 'merged'; ticket: Ticket }
  | { kind: 'back-to-review'; risk: RiskTier }
  | { kind: 'held'; until: Date }
  | { kind: 'waiting'; until: Date }
  | { kind: 'on-hold'; by: string };

export interface CreateInput {
  title: string;
  body?: string;
  type?: TicketType;
  priority?: Priority;
  risk?: RiskTier;
  components?: string[];
  blockedBy?: number[];
  covers?: string[];
  spec?: number;
}

export type EditInput = Partial<Pick<Ticket, 'title' | 'body' | 'priority' | 'risk' | 'components' | 'blockedBy' | 'covers'>>;

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
      risk: input.risk ?? 'low',
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
    let ticket = await this.tracker.get(id);
    // Handing a PR to review, and passing it, both look at what it changes: the tier only
    // goes up, and a raised tier can refuse the pass below until security has run.
    const handIn = input.to === 'in-review' && input.role === 'builder';
    const pass = input.to === 'in-qa' && input.role === 'reviewer';
    if ((handIn || pass) && ticket.type === 'build' && this.opts.codeHost && (input.pr ?? ticket.pr)) {
      ticket = await this.raiseRisk(ticket, await this.assess(input.pr ?? ticket.pr!));
    }
    const openBlockers = await this.openBlockers(ticket);
    check(canMove(ticket, input, { openBlockers }));
    if (input.to === 'in-qa') await this.checkReviewedHead(ticket, input.sha!);
    if (input.to === 'in-review' && input.role === 'builder') await this.checkGreenForReview(input.pr ?? ticket.pr!);

    const { ticket: next, escalated } = applyMove(ticket, input, this.maxRounds);
    const saved = await this.tracker.update(next);

    let text = escalated
      ? `**${input.role}** sent this back, and it reached round ${next.round} of ${this.maxRounds}, so it goes to \`needs-human\``
      : `**${input.role}** moved this from \`${ticket.state}\` to \`${input.to}\``;
    if (input.reason) text += `\n\nReason: \`${input.reason}\``;
    if (!escalated && next.round !== ticket.round) text += ` (round ${next.round} of ${this.maxRounds})`;
    if (input.note) text += `\n\n${input.note}`;
    await this.tracker.comment(id, text);
    if (saved.state === 'in-qa' && saved.reviewedSha && this.opts.codeHost && this.opts.reviewStatus !== 'gate') {
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

  private rulesCache?: Promise<RiskRules>;

  // risk.yml from the base branch, never the PR's own copy, so a PR cannot loosen its own path.
  riskRules(): Promise<RiskRules> {
    this.rulesCache ??= this.opts.riskRules
      ? this.opts.riskRules()
      : (async () => {
          const text = await this.host().readFile(RISK_FILE, this.opts.baseBranch ?? 'main');
          return text === undefined ? DEFAULT_RISK_RULES : parseRiskRules(text);
        })();
    return this.rulesCache;
  }

  // The tier the PR's changes call for, from risk.yml.
  async assess(prNumber: number): Promise<Assessment> {
    return assessDiff(await this.host().files(prNumber), await this.riskRules());
  }

  async assessTicket(id: number): Promise<{ ticket: Ticket; assessment: Assessment; tier: RiskTier }> {
    const ticket = await this.tracker.get(id);
    const assessment = await this.assess(await this.prOf(id));
    return { ticket, assessment, tier: stricter(ticket.risk, assessment.tier) };
  }

  // Raises the ticket's tier to what its PR calls for, if that is stricter, and says why.
  private async raiseRisk(ticket: Ticket, a: Assessment): Promise<Ticket> {
    const tier = stricter(ticket.risk, a.tier);
    if (tier === ticket.risk) return ticket;
    const saved = await this.tracker.update({ ...ticket, risk: tier });
    const why = a.reasons.length ? `\n\n${a.reasons.map((r) => `- ${r}`).join('\n')}` : '';
    const then = needsSecurity(tier) && ticket.gates.security !== 'pass' ? ' It needs the security gate before its review can pass.' : '';
    await this.tracker.comment(ticket.id, `**system** raised the risk from \`${ticket.risk}\` to \`${tier}\`: PR #${ticket.pr} changes what \`${RISK_FILE}\` rates ${tier}.${then}${why}`);
    this.emit({ kind: 'risk', ticket: ticket.id, role: 'system', risk: tier });
    return saved;
  }

  // The merge gate's step for a reviewed, green, QA-reported PR. The tier is checked again
  // from the diff (a prompt cannot skip this), then low and medium merge, and high is held
  // for the owner: it merges once the hold has run out, or at once when the owner approves.
  async gateMerge(id: number, now = this.opts.now?.() ?? new Date()): Promise<GateOutcome> {
    const host = this.host();
    let ticket = await this.tracker.get(id);
    const prNumber = ticket.pr;
    if (!prNumber) throw new RuleError(`#${id} has no PR`);
    ticket = await this.raiseRisk(ticket, await this.assess(prNumber));
    if (needsSecurity(ticket.risk) && ticket.gates.security !== 'pass') {
      await this.move(id, {
        to: 'in-review',
        role: 'system',
        note: `PR #${prNumber} is \`${ticket.risk}\` risk and has not passed the security gate, so it goes back to review for it.`,
      });
      return { kind: 'back-to-review', risk: ticket.risk };
    }
    if (ticket.risk !== 'high') return { kind: 'merged', ticket: await this.merge(id, 'system') };

    const pr = await host.getPr(prNumber);
    const marker = holdMarker(pr.headSha);
    const comments = await this.tracker.comments(id);
    const heldAt = comments.filter((c) => c.body.startsWith('**system**') && c.body.includes(marker)).at(-1)?.createdAt;
    const hours = this.opts.holdHours ?? DEFAULT_HOLD_HOURS;
    const owner = this.opts.owner;
    const { decision, remove } = holdDecision({
      labels: await host.labels(pr.number),
      events: await host.labelEvents(pr.number),
      owner: owner ?? '',
      heldAt,
      hours,
      now,
    });
    for (const label of remove) {
      await host.removeLabel(pr.number, label);
      await this.tracker.comment(id, `**system** took \`${label}\` off PR #${pr.number}: only ${owner ? `@${owner}` : 'the owner'}, adding it by hand after the hold started, can approve a held PR.`);
    }
    const mention = owner ? `@${owner}` : 'Owner';
    switch (decision.kind) {
      case 'start': {
        const until = new Date(now.getTime() + hours * 3600 * 1000);
        await host.addLabel(pr.number, HELD_LABEL);
        await this.tracker.comment(
          id,
          `**system** ${marker}. ${mention}: PR #${pr.number} is \`high\` risk. It passed review, security and QA, and it merges at ${stamp(until)} unless you add the \`${HOLD_LABEL}\` label to PR #${pr.number}. Add \`${APPROVE_LABEL}\` to merge it now.`,
        );
        this.emit({ kind: 'hold', ticket: id, role: 'system', risk: 'high' });
        return { kind: 'held', until };
      }
      case 'wait':
        return { kind: 'waiting', until: decision.until };
      case 'on-hold': {
        const said = `On hold at ${pr.headSha}`;
        if (!comments.some((c) => c.body.startsWith('**system**') && c.body.includes(said))) {
          await this.tracker.comment(
            id,
            `**system** ${said}: @${decision.by} added \`${HOLD_LABEL}\` to PR #${pr.number}, so it will not merge. Take the label off to restart the ${hours}-hour clock, or send it back: \`forge move ${id} building --as owner --reason <reason> --note "<what to change>"\`.`,
          );
        }
        return { kind: 'on-hold', by: decision.by };
      }
      case 'approved':
        return { kind: 'merged', ticket: await this.merge(id, 'system', `High risk: merged early, approved by @${decision.by}.`) };
      case 'due':
        return { kind: 'merged', ticket: await this.merge(id, 'system', `High risk: merged after the ${hours}-hour hold with no \`${HOLD_LABEL}\`.`) };
    }
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

  private async checkGreenForReview(prNumber: number): Promise<void> {
    if (!this.opts.codeHost) return;
    const pr = await this.opts.codeHost.getPr(prNumber);
    check(canHandToReview({ number: pr.number, headSha: pr.headSha, checks: await this.opts.codeHost.checks(pr.number) }));
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

  // Merges the reviewed commit once CI is green, then marks the ticket done. The gate calls
  // this through gateMerge, which holds high-risk PRs first; the owner may call it directly.
  async merge(id: number, role: Role, extra?: string): Promise<Ticket> {
    const host = this.host();
    const ticket = await this.tracker.get(id);
    if (!ticket.pr) throw new RuleError(`#${id} has no PR`);
    const pr = await host.getPr(ticket.pr);
    const checks = pr.merged ? [] : await host.checks(pr.number);
    check(canMerge(ticket, role, { headSha: pr.headSha, open: pr.state === 'open' && !pr.merged, checks }));
    const method = this.opts.mergeMethod ?? 'merge';
    // canMerge has checked that the head is the reviewed commit, so the status is true of it.
    if (this.opts.reviewStatus === 'gate') {
      await host.setStatus(pr.headSha, REVIEW_STATUS, 'success', `Reviewed as ticket #${id}`);
    }
    try {
      await host.merge(pr.number, pr.headSha, method);
    } catch (e) {
      throw new RuleError(`GitHub refused to merge PR #${pr.number}: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.emit({ kind: 'merge', ticket: id, role });
    const dropped = await this.dropBranch(id, pr.head);
    const who = role === 'owner' ? 'the owner' : 'the factory';
    let note = `PR #${pr.number} merged by ${who} (${method}) at the reviewed commit ${pr.headSha}, with every check green.`;
    if (dropped) note += ` Branch \`${pr.head}\` deleted.`;
    if (extra) note += `\n\n${extra}`;
    return this.move(id, { to: 'done', role: 'system', note });
  }

  // Deletes the merged ticket branch on the host. Only a factory branch (ticket-N for this
  // ticket), and never fatal: the merge has happened, and a branch someone already deleted is fine.
  async dropBranch(id: number, branch: string): Promise<boolean> {
    if (branch !== `ticket-${id}`) return false;
    try {
      await this.host().deleteBranch(branch);
      return true;
    } catch {
      return false;
    }
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

const stamp = (d: Date) => `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
