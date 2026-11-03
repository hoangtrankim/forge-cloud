import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register } from 'claude-code'

import type { CacheCounts, Snapshot, Totals } from '../types'
import { add, countsOf, hitRate, inputOf, share, split, tokens, verdict } from './cache'

const PANE = 'context'
const TITLE = 'Context'
const BAR = 28
const snapshot = atom({ plugin: 'context-pane', key: 'snapshot' } as const, { window: 0, checkedAt: 0 }, { shape: 'snapshot-1' })
const totals = atom(
  { plugin: 'context-pane', key: 'totals' } as const,
  { read: 0, written: 0, uncached: 0, output: 0, turns: 0 },
  { shape: 'totals-1' },
)

// Read from cache is cheap, written costs a little more than plain input, uncached is full price.
const ROWS: Array<{ key: keyof CacheCounts; label: string; color: Color }> = [
  { key: 'read', label: 'Read from cache', color: 'success' },
  { key: 'written', label: 'Written to cache', color: 'warning' },
  { key: 'uncached', label: 'Not cached', color: 'error' },
]

async function refresh($: EngineInterface): Promise<void> {
  let next: Snapshot
  try {
    // `summary` estimates locally: no token-count requests.
    const u = await $.session.usage({ breakdown: 'summary' })
    const api = u.context.breakdown?.apiUsage
    next = { window: u.context.window, checkedAt: await $.clock.now() }
    if (u.context.tokens !== undefined) next.used = u.context.tokens
    if (u.context.percent !== undefined) next.percent = u.context.percent
    if (api) next.last = countsOf(api)
  } catch {
    next = { window: 0, checkedAt: await $.clock.now() }
  }
  await update($, snapshot, () => next)
}

function summary(s: Snapshot, t: Totals): string {
  const lines = [`Context: ${s.percent ?? 0}% used · ${tokens(s.used ?? 0)} / ${tokens(s.window)}`]
  const block = (title: string, c: CacheCounts | undefined) => {
    if (!c || !inputOf(c)) return [`${title}: none yet`]
    return [
      `${title}: cache hit ${hitRate(c)}%`,
      ...ROWS.map(r => `  ${r.label.padEnd(17)} ${tokens(c[r.key]).padStart(6)}  ${share(c[r.key], c)}%`),
      `  Output            ${tokens(c.output).padStart(6)}`,
    ]
  }
  lines.push('', ...block('Last response', s.last), '', ...block(`This session (${t.turns} turns)`, t))
  lines.push('', verdict(s.last))
  return lines.join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'context-cache', description: 'Show the Context pane: window use and prompt cache' })
    void $.ui.open({ id: PANE, title: TITLE })
    void refresh($)
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    try {
      const u = e.usage
      if (u) await update($, totals, t => ({ ...add(t, countsOf(u)), turns: t.turns + 1 }))
      await refresh($)
    } catch {
      // The pane is a view: never let it fail a turn.
    }
    return done
  })

  on('command.run', { command: 'context-cache' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    await refresh($)
    const text = summary(await read($, snapshot), await read($, totals))
    return { text: opened.isPlaced ? text : `${text}\n\n(No pane here: ${opened.reason})` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const s = await read($, snapshot)
    const t = await read($, totals)

    const heading = (text: string, right?: string, color?: Color) => (
      <Box flexDirection="row" justifyContent="space-between">
        <Text weight="bold" size="footnote" color="subtle">
          {text}
        </Text>
        {right && (
          <Text size="footnote" weight="semibold" color={color ?? 'text'}>
            {right}
          </Text>
        )}
      </Box>
    )

    // One bar split read / written / uncached, then a row per part.
    const cache = (title: string, c: CacheCounts | undefined) => {
      if (!c || !inputOf(c)) {
        return (
          <Box flexDirection="column">
            {heading(title)}
            <Text dimColor>No response yet.</Text>
          </Box>
        )
      }
      const rate = hitRate(c) ?? 0
      const cells = split(
        ROWS.map(r => c[r.key]),
        BAR,
      )
      return (
        <Box flexDirection="column">
          {heading(title, `cache hit ${rate}%`, rate >= 80 ? 'success' : rate >= 40 ? 'warning' : 'error')}
          <Text>
            {ROWS.map((r, i) => (
              <Text color={r.color}>{'█'.repeat(cells[i] ?? 0)}</Text>
            ))}
          </Text>
          {ROWS.map(r => (
            <Box flexDirection="row" justifyContent="space-between">
              <Text>
                <Text color={r.color}>■ </Text>
                {r.label}
              </Text>
              <Text tabular>
                {tokens(c[r.key])} <Text dimColor>· {share(c[r.key], c)}%</Text>
              </Text>
            </Box>
          ))}
          <Box flexDirection="row" justifyContent="space-between">
            <Text dimColor>Output</Text>
            <Text tabular dimColor>
              {tokens(c.output)}
            </Text>
          </Box>
        </Box>
      )
    }

    const pct = s.percent ?? 0
    const used = Math.max(0, Math.min(BAR, Math.round((pct / 100) * BAR)))
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          {heading('CONTEXT WINDOW', s.window ? `${pct}% · ${tokens(s.used ?? 0)} / ${tokens(s.window)}` : 'loading…')}
          <Text>
            <Text color={pct >= 80 ? 'error' : pct >= 50 ? 'warning' : 'suggestion'}>{'█'.repeat(used)}</Text>
            <Text dimColor>{'░'.repeat(BAR - used)}</Text>
          </Text>
        </Box>
        {cache('CACHE · LAST RESPONSE', s.last)}
        {cache(`CACHE · THIS SESSION (${t.turns} ${t.turns === 1 ? 'turn' : 'turns'})`, t.turns ? t : undefined)}
        <Text color="suggestion">→ {verdict(s.last)}</Text>
      </Box>
    )
  })
}
