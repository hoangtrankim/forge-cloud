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

// Open factory tickets per state, from `forge list --json`.
export type Board = {
  counts: Record<string, number>
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
