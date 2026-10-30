// How a Ticket is stored on an issue: labels for state and flags, body lines for links.
// Kept tracker-neutral so a Jira adapter can reuse the body-line format.

import { GATES, STATES, type Gate, type GateResult, type Priority, type State, type Ticket } from './lifecycle.js';

export const STATE_PREFIX = 'factory:';
export const SPEC_LABEL = 'type:spec';
export const RISKY_LABEL = 'risky';
export const TESTS_READY_LABEL = 'qa:tests-ready';
export const ROUND_PREFIX = 'round:';
export const COMPONENT_PREFIX = 'component:';
export const PRIORITY_PREFIX = 'priority:p';
export const GATE_PREFIX = 'gate:';

export interface LabelSpec {
  name: string;
  color: string;
  description: string;
}

// Labels "forge setup" creates. Round, component and gate labels are created on demand.
export const FIXED_LABELS: LabelSpec[] = [
  ...STATES.map((s) => ({ name: STATE_PREFIX + s, color: stateColor(s), description: `Factory state: ${s}` })),
  { name: SPEC_LABEL, color: '5319e7', description: 'A spec that is split into tickets' },
  { name: RISKY_LABEL, color: 'b60205', description: 'Touches auth, payments or security; needs the security gate' },
  { name: TESTS_READY_LABEL, color: '0e8a16', description: 'Blind QA tests are written from the spec' },
  ...[0, 1, 2, 3].map((p) => ({ name: `${PRIORITY_PREFIX}${p}`, color: 'fbca04', description: `Priority p${p}` })),
];

function stateColor(s: State): string {
  if (s === 'done') return '0e8a16';
  if (s === 'needs-human') return 'd93f0b';
  if (s === 'blocked') return 'e4e669';
  return 'c5def5';
}

// True for labels this tool owns; everything else on an issue is left alone.
export function isFactoryLabel(name: string): boolean {
  return (
    name.startsWith(STATE_PREFIX) ||
    name === SPEC_LABEL ||
    name === RISKY_LABEL ||
    name === TESTS_READY_LABEL ||
    name.startsWith(ROUND_PREFIX) ||
    name.startsWith(COMPONENT_PREFIX) ||
    name.startsWith(PRIORITY_PREFIX) ||
    name.startsWith(GATE_PREFIX)
  );
}

export function toLabels(t: Ticket): string[] {
  const labels = [STATE_PREFIX + t.state, `${PRIORITY_PREFIX}${t.priority}`];
  if (t.type === 'spec') labels.push(SPEC_LABEL);
  if (t.risky) labels.push(RISKY_LABEL);
  if (t.testsReady) labels.push(TESTS_READY_LABEL);
  if (t.round > 0) labels.push(`${ROUND_PREFIX}${t.round}`);
  for (const c of t.components) labels.push(COMPONENT_PREFIX + c);
  for (const g of GATES) {
    const r = t.gates[g];
    if (r) labels.push(`${GATE_PREFIX}${g}:${r}`);
  }
  return labels;
}

export interface LabelFields {
  state?: State;
  type: Ticket['type'];
  priority: Priority;
  round: number;
  risky: boolean;
  testsReady: boolean;
  components: string[];
  gates: Ticket['gates'];
}

export function fromLabels(labels: string[]): LabelFields {
  const f: LabelFields = {
    type: 'build',
    priority: 2,
    round: 0,
    risky: false,
    testsReady: false,
    components: [],
    gates: {},
  };
  for (const l of labels) {
    if (l.startsWith(STATE_PREFIX)) {
      const s = l.slice(STATE_PREFIX.length);
      if ((STATES as readonly string[]).includes(s)) f.state = s as State;
    } else if (l === SPEC_LABEL) f.type = 'spec';
    else if (l === RISKY_LABEL) f.risky = true;
    else if (l === TESTS_READY_LABEL) f.testsReady = true;
    else if (l.startsWith(ROUND_PREFIX)) f.round = Number(l.slice(ROUND_PREFIX.length)) || 0;
    else if (l.startsWith(COMPONENT_PREFIX)) f.components.push(l.slice(COMPONENT_PREFIX.length));
    else if (l.startsWith(PRIORITY_PREFIX)) {
      const p = Number(l.slice(PRIORITY_PREFIX.length));
      if (p >= 0 && p <= 3) f.priority = p as Priority;
    } else if (l.startsWith(GATE_PREFIX)) {
      const [g, r] = l.slice(GATE_PREFIX.length).split(':');
      if ((GATES as readonly string[]).includes(g ?? '') && (r === 'pass' || r === 'fail')) {
        f.gates[g as Gate] = r as GateResult;
      }
    }
  }
  return f;
}

// Body lines: "Spec: #3", "Blocked by: #1, #2", "Covers: AC-1, AC-2", "PR: #12".
// "Reviewed: <sha>" is the PR commit the reviewer passed.
const LINE_KEYS = { spec: 'Spec', blockedBy: 'Blocked by', covers: 'Covers', pr: 'PR', reviewedSha: 'Reviewed' } as const;

export interface BodyFields {
  spec?: number;
  pr?: number;
  reviewedSha?: string;
  blockedBy: number[];
  covers: string[];
}

function lineValue(body: string, key: string): string | undefined {
  const m = new RegExp(`^${key}:[ \\t]*(.*)$`, 'mi').exec(body);
  return m?.[1]?.trim();
}

const issueNumbers = (v: string | undefined) => [...(v ?? '').matchAll(/#(\d+)/g)].map((m) => Number(m[1]));

export function fromBody(body: string): BodyFields {
  return {
    spec: issueNumbers(lineValue(body, LINE_KEYS.spec))[0],
    pr: issueNumbers(lineValue(body, LINE_KEYS.pr))[0],
    reviewedSha: /^[0-9a-f]{40}$/.exec(lineValue(body, LINE_KEYS.reviewedSha) ?? '')?.[0],
    blockedBy: issueNumbers(lineValue(body, LINE_KEYS.blockedBy)),
    covers: [...(lineValue(body, LINE_KEYS.covers) ?? '').matchAll(/AC-\d+/g)].map((m) => m[0]),
  };
}

function setLine(body: string, key: string, value: string | undefined): string {
  const re = new RegExp(`^${key}:.*$\\n?`, 'mi');
  if (!value) return body.replace(re, '');
  const line = `${key}: ${value}`;
  if (re.test(body)) return body.replace(new RegExp(`^${key}:.*$`, 'mi'), line);
  return body.trimEnd() + (body.trim() ? '\n' : '') + line + '\n';
}

// Rewrites the link lines in place and leaves the rest of the body untouched.
export function withBodyFields(body: string, f: BodyFields): string {
  let out = body;
  out = setLine(out, LINE_KEYS.spec, f.spec ? `#${f.spec}` : undefined);
  out = setLine(out, LINE_KEYS.covers, f.covers.length ? f.covers.join(', ') : undefined);
  out = setLine(out, LINE_KEYS.blockedBy, f.blockedBy.length ? f.blockedBy.map((n) => `#${n}`).join(', ') : undefined);
  out = setLine(out, LINE_KEYS.pr, f.pr ? `#${f.pr}` : undefined);
  out = setLine(out, LINE_KEYS.reviewedSha, f.reviewedSha);
  return out;
}
