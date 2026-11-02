// One factory agent this session started: a factory-<role> subagent, or a
// general-purpose one told to follow .claude/agents/factory-<role>.md.
export type Run = {
  agentId: string
  role: string
  ticket?: number
  model: string
  startedAt: number
  endedAt?: number
  status: string
}

// One ticket as the pane draws it, from `forge list --all --json`.
export type TicketRow = {
  id: number
  title: string
  state: string
  priority: number
  round: number
  risky: boolean
  closed: boolean
  pr?: number
}

// Open tickets plus the last few done, and the repo they live in (for links).
export type Board = {
  tickets: TicketRow[]
  repo?: string
  checkedAt: number
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'forge-panel': {
      runs: Shaped<Run[]>
      board: Shaped<Board>
      now: number
    }
  }
}
