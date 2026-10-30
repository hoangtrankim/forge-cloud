// Pure helpers: which factory role and ticket an Agent call is, and how the
// pane spells counts and durations.

export const STATES = [
  'spec',
  'planned',
  'designed',
  'building',
  'in-review',
  'in-qa',
  'blocked',
  'needs-human',
] as const

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

export function countStates(tickets: ReadonlyArray<{ state?: unknown }>): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const t of tickets) {
    if (typeof t.state !== 'string') continue
    counts[t.state] = (counts[t.state] ?? 0) + 1
  }
  return counts
}

export function minutes(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`
}

export function shortModel(model: string): string {
  const m = /(opus|sonnet|haiku|fable)/i.exec(model)
  return m?.[1] ? m[1].toLowerCase() : model
}

export const ENDED = new Set(['completed', 'failed', 'killed'])
