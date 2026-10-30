import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Board, Run } from '../types'
import { ENDED, STATES, countStates, minutes, roleOf, shortModel, ticketOf } from './factory'

const PANE = 'forge'
const TITLE = 'Forge'
const runs = atom({ plugin: 'forge-panel', key: 'runs' } as const, [], { shape: 'runs-1' })
const board = atom({ plugin: 'forge-panel', key: 'board' } as const, { counts: {}, checkedAt: 0 }, {
  shape: 'board-1',
})
const now = atom({ plugin: 'forge-panel', key: 'now' } as const, 0)

async function refreshBoard($: EngineInterface): Promise<void> {
  let next: Board
  try {
    // The session's folder, not the host's: a desktop app's process starts elsewhere.
    const cwd = await $.session.cwd()
    const out = await $.process.run(['forge', 'list', '--json'], { cwd, timeoutMs: 60_000 })
    if (out.exitCode !== 0) {
      next = { counts: {}, checkedAt: await $.clock.now(), error: /cannot tell which repo|not a git repository/.test(out.stderr) ? 'Not a factory repo: open the session in one' : out.stderr.trim().split('\n').pop() || 'forge list failed' }
    } else {
      next = { counts: countStates(JSON.parse(out.stdout)), checkedAt: await $.clock.now() }
    }
  } catch {
    next = { counts: {}, checkedAt: await $.clock.now(), error: 'forge is not installed here' }
  }
  await update($, board, () => next)
}

async function refreshRuns($: EngineInterface): Promise<boolean> {
  const list = await read($, runs)
  if (!list.some(r => r.endedAt === undefined)) return false
  const agents = await $.agent.list()
  const at = await $.clock.now()
  let ended = false
  await update($, runs, all =>
    all.map(r => {
      if (r.endedAt !== undefined) return r
      const status = agents.find(a => a.id === r.agentId)?.status ?? 'completed'
      if (!ENDED.has(status)) return { ...r, status }
      ended = true
      return { ...r, status, endedAt: at }
    }),
  )
  return ended
}

const label = (r: Run) => `${r.role}${r.ticket ? ` #${r.ticket}` : ''}${r.model ? ` · ${r.model}` : ''}`
const shownStates = (b: Board) => STATES.filter(st => (b.counts[st] ?? 0) > 0 || st === 'building' || st === 'in-qa')

function summary(b: Board, list: readonly Run[], at: number): string {
  const running = list.filter(r => r.endedAt === undefined)
  const done = list.filter(r => r.endedAt !== undefined).slice(-6).reverse()
  const lines = ['Tickets: ' + (b.error ?? shownStates(b).map(st => `${st} ${b.counts[st] ?? 0}`).join(' · '))]
  lines.push(`Running (${running.length}): ` + (running.map(r => `${label(r)} · ${minutes(at - r.startedAt)}`).join(', ') || 'none'))
  if (done.length > 0) lines.push('Finished: ' + done.map(r => `${r.status === 'completed' ? '✓' : '✗'} ${label(r)}`).join(', '))
  return lines.join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'forge', description: 'Show the Forge pane: factory tickets and running agents' })
    void $.ui.open({ id: PANE, title: TITLE })
    void refreshBoard($)
    let ticks = 0
    $.clock.every(5_000, async () => {
      { const t = await $.clock.now(); await update($, now, () => t) }
      if (await refreshRuns($)) void refreshBoard($)
      if (++ticks % 12 === 0) void refreshBoard($)
    })
    return started
  })

  on('command.run', { command: 'forge' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    await refreshBoard($)
    // Answer with the view as text too: some surfaces place no panes, or place them out of sight.
    const text = summary(await read($, board), await read($, runs), await $.clock.now())
    return { text: opened.isPlaced ? text : `${text}\n\n(No pane here: ${opened.reason})` }
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    try {
      const role = roleOf(e.subagentType, e.prompt)
      if (role && 'agentId' in spawned && spawned.agentId) {
        const run: Run = {
          agentId: spawned.agentId,
          role,
          ticket: ticketOf(e.prompt),
          model: shortModel(spawned.model ?? e.model ?? ''),
          startedAt: await $.clock.now(),
          status: 'running',
        }
        await update($, runs, list => [...list, run].slice(-50))
      }
    } catch {
      // The pane is a view: never let it fail a spawn.
    }
    return spawned
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const b = await read($, board)
    const list = await read($, runs)
    const at = (await read($, now)) || (await $.clock.now())
    const running = list.filter(r => r.endedAt === undefined)
    const done = list.filter(r => r.endedAt !== undefined).slice(-6).reverse()
    const shown = shownStates(b)

    return (
      <Box flexDirection="column">
        <Text bold>Tickets</Text>
        {b.error ? (
          <Text dimColor>{b.error}</Text>
        ) : (
          <Text>{shown.map(s => `${s} ${b.counts[s] ?? 0}`).join('  ·  ')}</Text>
        )}
        <Text> </Text>
        <Text bold>Running ({running.length})</Text>
        {running.length === 0 && <Text dimColor>No factory agent running.</Text>}
        {running.map(r => (
          <Text color="green">● {label(r)} · {minutes(at - r.startedAt)}</Text>
        ))}
        {done.length > 0 && <Text> </Text>}
        {done.length > 0 && <Text bold>Finished</Text>}
        {done.map(r => (
          <Text dimColor>
            {r.status === 'completed' ? '✓' : '✗'} {label(r)} · {minutes((r.endedAt ?? at) - r.startedAt)}
          </Text>
        ))}
      </Box>
    )
  })
}
