// Pure helpers: which factory role and ticket an Agent call is, and how the
// pane sorts, colours and spells tickets, counts and durations.

import type { Color } from 'claude-code'

import type { TicketRow } from '../types'

// The pipeline, in the order a ticket moves through it.
export const PIPELINE = ['spec', 'planned', 'designed', 'building', 'in-review', 'in-qa', 'done'] as const
// States that wait on the owner, not on an agent.
export const NEEDS_YOU = ['needs-human', 'blocked'] as const
export const STATES = [...PIPELINE, ...NEEDS_YOU] as const

// Short names for the pipeline row, so it fits a narrow pane.
export const SHORT: Record<string, string> = { 'in-review': 'review', 'in-qa': 'qa' }

// Theme keys, so each colour follows the app's light or dark theme.
export const STATE_COLOR: Record<string, Color> = {
  spec: 'suggestion',
  planned: 'remember',
  designed: 'merged',
  building: 'warning',
  'in-review': 'autoAccept',
  'in-qa': 'planMode',
  done: 'success',
  'needs-human': 'error',
  blocked: 'error',
}

// The agent flow for one ticket, for "step N of 6".
export const FLOW = ['planner', 'designer', 'qa-writer', 'builder', 'reviewer', 'qa-reporter'] as const

export function stepOf(role: string): string {
  const i = (FLOW as readonly string[]).indexOf(role)
  return i < 0 ? '' : `step ${i + 1} of ${FLOW.length}`
}

export function roleOf(subagentType: string, prompt: string): string | undefined {
  const typed = /^factory-([a-z-]+)$/.exec(subagentType)
  if (typed) return typed[1]
  const told = /\.claude\/agents\/factory-([a-z-]+)\.md/.exec(prompt)
  return told?.[1]
}

export function ticketOf(prompt: string): number | undefined {
  const m = /\b(?:Ticket|spec)\s+#?(\d+)/i.exec(prompt)
  return m ? Number(m[1]) : undefined
}

// `forge list --all --json` rows, kept to what the pane draws: every open
// ticket, and the last few done ones.
export function toRows(tickets: ReadonlyArray<Record<string, unknown>>, doneKept = 3): TicketRow[] {
  const rows: TicketRow[] = []
  for (const t of tickets) {
    if (typeof t.id !== 'number' || typeof t.state !== 'string') continue
    const row: TicketRow = {
      id: t.id,
      title: typeof t.title === 'string' ? t.title : '',
      state: t.state,
      priority: typeof t.priority === 'number' ? t.priority : 2,
      round: typeof t.round === 'number' ? t.round : 0,
      risky: t.risky === true,
      closed: t.closed === true,
    }
    if (typeof t.pr === 'number') row.pr = t.pr
    rows.push(row)
  }
  const open = rows.filter(r => !r.closed && r.state !== 'done')
  const done = rows.filter(r => r.state === 'done').sort((a, b) => b.id - a.id).slice(0, doneKept)
  return [...open.sort((a, b) => a.priority - b.priority || a.id - b.id), ...done]
}

export function countStates(tickets: ReadonlyArray<{ state?: unknown; closed?: unknown }>): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const t of tickets) {
    if (typeof t.state !== 'string' || (t.closed === true && t.state !== 'done')) continue
    counts[t.state] = (counts[t.state] ?? 0) + 1
  }
  return counts
}

// owner/name from a git remote, for issue links; undefined for anything not on github.com.
export function repoOf(remote: string): string | undefined {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remote.trim())
  return m ? `${m[1]}/${m[2]}` : undefined
}

export function minutes(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

export function shortModel(model: string): string {
  const m = /(opus|sonnet|haiku|fable)/i.exec(model)
  return m?.[1] ? m[1].toLowerCase() : model
}

export const ENDED = new Set(['completed', 'failed', 'killed'])
