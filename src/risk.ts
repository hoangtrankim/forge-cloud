// Risk tiers. Pure functions only, so every rule is unit tested.
//
// A ticket's tier is the strictest of the planner's label and what its PR actually changes:
// each changed file is matched against risk.yml (the strictest matching rule wins, a file no
// rule matches gets the default), and a big PR is at least medium. Nothing lowers a tier.
// Medium and high need the security gate; high is then held for the owner before it merges.

import { parse } from 'yaml';

export const RISK_TIERS = ['low', 'medium', 'high'] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

export const RISK_FILE = 'risk.yml';

export function isRiskTier(s: string): s is RiskTier {
  return (RISK_TIERS as readonly string[]).includes(s);
}

const rank = (t: RiskTier) => RISK_TIERS.indexOf(t);

export function stricter(a: RiskTier, b: RiskTier): RiskTier {
  return rank(a) >= rank(b) ? a : b;
}

export function atLeast(t: RiskTier, min: RiskTier): boolean {
  return rank(t) >= rank(min);
}

// Tiers that must pass the security gate before review can pass.
export const needsSecurity = (t: RiskTier) => atLeast(t, 'medium');

export interface RiskRules {
  // The tier of a file no rule matches.
  default: RiskTier;
  // More changed lines than this (outside sizeIgnore) makes a PR at least medium.
  maxLowLines: number;
  sizeIgnore: string[];
  high: string[];
  medium: string[];
  low: string[];
}

// Used when the repo has no risk.yml. The factory's own files are always high: a PR that
// changes the gate, the guard, the agents or these rules must not loosen its own path.
export const DEFAULT_RISK_RULES: RiskRules = {
  default: 'medium',
  maxLowLines: 300,
  sizeIgnore: ['tests/**'],
  high: ['.github/**', '.claude/**', 'factory.config.yml', RISK_FILE, 'package.json', 'package-lock.json'],
  medium: [],
  low: ['docs/**', '*.md'],
};

// Paths that are high whatever risk.yml says, so an edit to risk.yml cannot take them out.
export const ALWAYS_HIGH = ['.github/workflows/**', '.claude/**', 'factory.config.yml', RISK_FILE];

export function parseRiskRules(text: string): RiskRules {
  const raw = (parse(text) ?? {}) as Record<string, unknown>;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${RISK_FILE}: expected a map`);
  const list = (key: 'high' | 'medium' | 'low' | 'sizeIgnore', fallback: string[]): string[] => {
    const v = raw[key];
    if (v === undefined || v === null) return fallback;
    const l = typeof v === 'string' ? [v] : v;
    if (!Array.isArray(l) || !l.every((p) => typeof p === 'string')) throw new Error(`${RISK_FILE}: ${key} must be a list of paths`);
    return l;
  };
  const def = raw.default ?? DEFAULT_RISK_RULES.default;
  if (typeof def !== 'string' || !isRiskTier(def)) throw new Error(`${RISK_FILE}: default must be one of ${RISK_TIERS.join(', ')}`);
  const max = Number(raw.maxLowLines ?? DEFAULT_RISK_RULES.maxLowLines);
  if (!Number.isInteger(max) || max < 0) throw new Error(`${RISK_FILE}: maxLowLines must be a whole number`);
  return {
    default: def,
    maxLowLines: max,
    sizeIgnore: list('sizeIgnore', DEFAULT_RISK_RULES.sizeIgnore),
    high: list('high', []),
    medium: list('medium', []),
    low: list('low', []),
  };
}

// Glob to regex: `**` crosses folders, `*` and `?` stay inside one. A pattern with no `/`
// matches a file name in any folder (`*.md`, `*auth*`); `dir/` and `dir/**` match below dir.
export function globToRegExp(glob: string): RegExp {
  let g = glob.trim().replace(/^\.\//, '');
  if (g.endsWith('/')) g += '**';
  const anywhere = !g.includes('/');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === '*' && g[i + 1] === '*') {
      i++;
      if (g[i + 1] === '/') {
        i++;
        re += '(?:.*/)?';
      } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${anywhere ? '(?:.*/)?' : ''}${re}$`, 'i');
}

export const matches = (path: string, globs: string[]) => globs.some((g) => globToRegExp(g).test(path));

export interface ChangedFile {
  path: string;
  // The old path of a renamed file: moving a file out of a high area is still a high change.
  previousPath?: string;
  additions: number;
  deletions: number;
}

export interface Assessment {
  tier: RiskTier;
  // Why, one line each, strictest first. Low files are summed up, not listed.
  reasons: string[];
  lines: number;
}

export function fileTier(path: string, rules: RiskRules): { tier: RiskTier; rule?: string } {
  const hit = (globs: string[]) => globs.find((g) => globToRegExp(g).test(path));
  const high = hit([...ALWAYS_HIGH, ...rules.high]);
  if (high) return { tier: 'high', rule: high };
  const medium = hit(rules.medium);
  if (medium) return { tier: 'medium', rule: medium };
  const low = hit(rules.low);
  if (low) return { tier: 'low', rule: low };
  return { tier: rules.default };
}

export function assessDiff(files: ChangedFile[], rules: RiskRules): Assessment {
  let tier: RiskTier = 'low';
  const found: Array<{ tier: RiskTier; text: string }> = [];
  for (const f of files) {
    for (const p of [f.path, f.previousPath].filter((x): x is string => !!x)) {
      const t = fileTier(p, rules);
      tier = stricter(tier, t.tier);
      if (t.tier !== 'low') found.push({ tier: t.tier, text: `${p}: ${t.tier} (${t.rule ? `matches \`${t.rule}\`` : 'no rule matches it'})` });
    }
  }
  const lines = files.filter((f) => !matches(f.path, rules.sizeIgnore)).reduce((n, f) => n + f.additions + f.deletions, 0);
  if (lines > rules.maxLowLines) {
    tier = stricter(tier, 'medium');
    found.push({ tier: 'medium', text: `${lines} changed lines, over the ${rules.maxLowLines} a low-risk PR may have` });
  }
  const reasons = found.sort((a, b) => rank(b.tier) - rank(a.tier)).map((r) => r.text);
  const MAX = 8;
  if (reasons.length > MAX) reasons.splice(MAX, reasons.length - MAX, `and ${reasons.length - MAX} more`);
  return { tier, reasons, lines };
}

// --- The hold on a high-risk PR ---------------------------------------------------------

// PR labels. The gate puts `held` on a high PR it is holding; the owner adds `approve` to
// merge it now or `hold` to stop the clock.
export const HELD_LABEL = 'held';
export const APPROVE_LABEL = 'approve';
export const HOLD_LABEL = 'hold';
export const DEFAULT_HOLD_HOURS = 24;

// The gate's comment that starts a hold names the commit it holds, so a new commit starts a new hold.
export const holdMarker = (sha: string) => `Held at ${sha}`;

export interface LabelEvent {
  event: 'labeled' | 'unlabeled';
  label: string;
  actor: string;
  // Set when an app made the change: the gate (forge-bot), or a Claude session acting for the
  // owner. Only a change the owner made by hand counts as the owner's.
  viaApp?: string;
  at: string;
}

export interface HoldFacts {
  // Labels on the PR now.
  labels: string[];
  events: LabelEvent[];
  owner: string;
  // When the gate started holding the current head, if it has.
  heldAt?: string;
  hours: number;
  now: Date;
}

export type HoldDecision =
  | { kind: 'start' }
  | { kind: 'approved'; by: string }
  | { kind: 'on-hold'; by: string }
  | { kind: 'wait'; until: Date }
  | { kind: 'due' };

const lastEvent = (events: LabelEvent[], label: string, event: LabelEvent['event']) =>
  [...events].filter((e) => e.label === label && e.event === event).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).at(-1);

const byOwner = (e: LabelEvent | undefined, owner: string) =>
  !!e && e.actor.toLowerCase() === owner.toLowerCase() && !e.viaApp;

// What the gate does with a reviewed, green, QA-reported high-risk PR. `remove` lists labels
// the gate takes off because they do not count: an `approve` that is not the owner's own, by
// hand, for the commit held now.
export function holdDecision(f: HoldFacts): { decision: HoldDecision; remove: string[] } {
  const has = (l: string) => f.labels.includes(l);
  const remove: string[] = [];
  let approvedBy: string | undefined;
  if (has(APPROVE_LABEL)) {
    const e = lastEvent(f.events, APPROVE_LABEL, 'labeled');
    if (byOwner(e, f.owner) && f.heldAt && Date.parse(e!.at) >= Date.parse(f.heldAt)) approvedBy = e!.actor;
    else remove.push(APPROVE_LABEL);
  }
  // Anyone may stop the clock: a hold only delays a merge. It also wins over an approve.
  if (has(HOLD_LABEL)) return { decision: { kind: 'on-hold', by: lastEvent(f.events, HOLD_LABEL, 'labeled')?.actor ?? 'someone' }, remove };
  if (approvedBy) return { decision: { kind: 'approved', by: approvedBy }, remove };
  if (!f.heldAt) return { decision: { kind: 'start' }, remove };
  // The clock runs from the start of the hold, or from when a `hold` was last taken off.
  const released = lastEvent(f.events, HOLD_LABEL, 'unlabeled')?.at;
  const from = Math.max(Date.parse(f.heldAt), released ? Date.parse(released) : 0);
  const until = new Date(from + f.hours * 3600 * 1000);
  return { decision: f.now >= until ? { kind: 'due' } : { kind: 'wait', until }, remove };
}
