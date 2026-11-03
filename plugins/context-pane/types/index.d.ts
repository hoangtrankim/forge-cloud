// The cache side of one response, or of many summed.
export type CacheCounts = {
  read: number
  written: number
  uncached: number
  output: number
}

// What the pane draws: the window, the last response and the session so far.
export type Snapshot = {
  window: number
  used?: number
  percent?: number
  last?: CacheCounts
  checkedAt: number
}

export type Totals = CacheCounts & { turns: number }

declare module 'claude-code' {
  interface PluginState {
    'context-pane': {
      snapshot: Shaped<Snapshot>
      totals: Shaped<Totals>
    }
  }
}
