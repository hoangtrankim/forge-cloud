import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register } from 'claude-code'

import type { Board, Run, TicketRow } from '../types'
import {
  ENDED,
  NEEDS_YOU,
  PIPELINE,
  PRIORITY,
  SHORT,
  STATE_COLOR,
  ago,
  countStates,
  minutes,
  repoOf,
  roleOf,
  shortModel,
  stepOf,
  ticketOf,
  toRows,
} from './factory'

const PANE = 'forge'
const TITLE = 'Forge'
const runs = atom({ plugin: 'forge-panel', key: 'runs' } as const, [], { shape: 'runs-1' })
const board = atom({ plugin: 'forge-panel', key: 'board' } as const, { tickets: [], checkedAt: 0 }, {
  shape: 'board-2',
})
const now = atom({ plugin: 'forge-panel', key: 'now' } as const, 0)

async function refreshBoard($: EngineInterface): Promise<void> {
  let next: Board
  try {
    // The session's folder, not the host's: a desktop app's process starts elsewhere.
    const cwd = await $.session.cwd()
    const out = await $.process.run(['forge', 'list', '--all', '--json'], { cwd, timeoutMs: 60_000 })
    if (out.exitCode !== 0) {
      next = {
        tickets: [],
        checkedAt: await $.clock.now(),
        error: /cannot tell which repo|not a git repository/.test(out.stderr)
          ? 'Not a factory repo: open the session in one'
          : out.stderr.trim().split('\n').pop() || 'forge list failed',
      }
    } else {
      next = { tickets: toRows(JSON.parse(out.stdout)), checkedAt: await $.clock.now() }
      try {
        const remote = await $.process.run(['git', 'remote', 'get-url', 'origin'], { cwd, timeoutMs: 10_000 })
        const repo = remote.exitCode === 0 ? repoOf(remote.stdout) : undefined
        if (repo) next.repo = repo
      } catch {
        // No links, then: the titles still show.
      }
    }
  } catch {
    next = { tickets: [], checkedAt: await $.clock.now(), error: 'forge is not installed here' }
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

// What the pane and /forge both show, worked out once.
function view(b: Board, list: readonly Run[]) {
  const counts = countStates(b.tickets)
  const open = b.tickets.filter(t => !t.closed && t.state !== 'done')
  const needsYou = open.filter(t => (NEEDS_YOU as readonly string[]).includes(t.state))
  const waiting = open.filter(t => !(NEEDS_YOU as readonly string[]).includes(t.state))
  const groups = PIPELINE.filter(s => s !== 'done')
    .map(state => ({ state, tickets: waiting.filter(t => t.state === state) }))
    .filter(g => g.tickets.length > 0)
  const done = b.tickets.filter(t => t.state === 'done')
  const running = list.filter(r => r.endedAt === undefined)
  const finished = list.filter(r => r.endedAt !== undefined).slice(-6).reverse()
  const inFlight = open.some(t => t.state !== 'spec' && !(NEEDS_YOU as readonly string[]).includes(t.state))
  let hint = ''
  if (!b.error && running.length === 0) {
    if (open.length === 0) hint = 'All clear. Grill a new spec to start the next one.'
    else if (needsYou.length > 0 && waiting.length === 0) hint = 'Everything left waits on you.'
    else if (!inFlight) hint = 'Run the forge-loop skill to pick these up.'
    else hint = 'Run the forge-loop skill to carry on.'
  }
  return { counts, needsYou, groups, done, running, finished, hint }
}

const stateLabel = (s: string) => SHORT[s] ?? s
const label = (r: Run) => `${r.role}${r.ticket ? ` #${r.ticket}` : ''}${r.model ? ` · ${r.model}` : ''}`
const issueUrl = (repo: string | undefined, id: number) => (repo ? `https://github.com/${repo}/issues/${id}` : '')
const tags = (t: TicketRow) =>
  [t.round > 0 ? `round ${t.round}` : '', t.risky ? '⚠ risky' : '', t.state === 'needs-human' || t.state === 'blocked' ? t.state : '']
    .filter(Boolean)
    .join(' · ')

function summary(b: Board, list: readonly Run[], at: number): string {
  if (b.error) return `Forge\n${b.error}`
  const v = view(b, list)
  const row = (t: TicketRow) => `  #${t.id} ${t.title}${tags(t) ? `  (${tags(t)})` : ''}`
  const lines = [`Forge${b.repo ? ` · ${b.repo}` : ''}`, '']
  lines.push('Needs you: ' + (v.needsYou.length ? '' : 'nothing ✓'))
  lines.push(...v.needsYou.map(row))
  lines.push('', 'Pipeline: ' + PIPELINE.map(s => `${stateLabel(s)} ${v.counts[s] ?? 0}`).join(' › '))
  for (const g of v.groups) lines.push('', `${g.state}:`, ...g.tickets.map(row))
  lines.push('', `Running (${v.running.length}): ` + (v.running.map(r => `${label(r)} · ${minutes(at - r.startedAt)}`).join(', ') || 'none'))
  if (v.finished.length > 0) lines.push('Finished: ' + v.finished.map(r => `${r.status === 'completed' ? '✓' : '✗'} ${label(r)}`).join(', '))
  if (v.done.length > 0) lines.push('Recently done: ' + v.done.map(t => `#${t.id} ${t.title}${t.risky ? ' (⚠ risky: look at the merge)' : ''}`).join(', '))
  if (v.hint) lines.push('', v.hint)
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
      {
        const t = await $.clock.now()
        await update($, now, () => t)
      }
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
    const { Box, Text, Link } = $.ui.resolve(e)
    const b = await read($, board)
    const list = await read($, runs)
    const at = (await read($, now)) || (await $.clock.now())

    const heading = (text: string, color?: Color) => (
      <Text weight="bold" size="footnote" color={color ?? 'subtle'}>
        {text}
      </Text>
    )
    const ticket = (t: TicketRow) => {
      const url = issueUrl(b.repo, t.id)
      const name = `#${t.id} ${t.title}`
      return (
        <Box flexDirection="row" gap={1}>
          <Text color={STATE_COLOR[t.state] ?? 'text'}>●</Text>
          {url ? <Link href={url}>{name}</Link> : <Text>{name}</Text>}
          {t.round > 0 && <Text color="warning">round {t.round}</Text>}
          {t.risky && <Text color="warning">⚠ risky</Text>}
          {t.state !== 'spec' && PRIORITY[t.priority] && (
            <Text dimColor={t.priority > 1} color={t.priority <= 1 ? 'suggestion' : undefined}>
              {PRIORITY[t.priority]}
            </Text>
          )}
        </Box>
      )
    }

    if (b.error) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text weight="bold">Forge</Text>
          <Text color="error">{b.error}</Text>
        </Box>
      )
    }

    const v = view(b, list)
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text weight="bold">Forge{b.repo ? ` · ${b.repo}` : ''}</Text>
          <Text dimColor size="footnote">
            {b.checkedAt ? `updated ${ago(at - b.checkedAt)}` : 'loading…'}
          </Text>
        </Box>

        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={v.needsYou.length ? 'error' : 'success'}
          paddingX={1}
        >
          {heading('NEEDS YOU', v.needsYou.length ? 'error' : 'success')}
          {v.needsYou.length === 0 && <Text color="success">Nothing waiting on you ✓</Text>}
          {v.needsYou.map(t => (
            <Box flexDirection="column">
              {ticket(t)}
              <Text color="error" size="footnote">
                {'  '}
                {t.state === 'needs-human' ? 'Sent back 3 times: needs your call' : 'Blocked: needs a hand to move on'}
              </Text>
            </Box>
          ))}
        </Box>

        <Box flexDirection="column">
          {heading('PIPELINE')}
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            {PIPELINE.map((s, i) => {
              const n = v.counts[s] ?? 0
              return (
                <Text>
                  <Text color={STATE_COLOR[s] ?? 'text'} weight={n ? 'bold' : 'regular'} dimColor={n === 0}>
                    {stateLabel(s)} {n}
                  </Text>
                  {i < PIPELINE.length - 1 && <Text dimColor> ›</Text>}
                </Text>
              )
            })}
          </Box>
        </Box>

        {v.groups.map(g => (
          <Box flexDirection="column">
            {heading(g.state === 'spec' ? 'WAITING TO START (spec)' : g.state.toUpperCase(), STATE_COLOR[g.state])}
            {g.tickets.map(ticket)}
          </Box>
        ))}

        <Box flexDirection="column">
          {heading(`RUNNING NOW (${v.running.length})`, v.running.length ? 'success' : undefined)}
          {v.running.length === 0 && <Text dimColor>No factory agent running.</Text>}
          {v.running.map(r => (
            <Box flexDirection="row" gap={1}>
              <Text color="success">●</Text>
              <Text weight="semibold">{label(r)}</Text>
              <Text tabular>· {minutes(at - r.startedAt)}</Text>
              {stepOf(r.role) && <Text dimColor>({stepOf(r.role)})</Text>}
            </Box>
          ))}
        </Box>

        {v.finished.length > 0 && (
          <Box flexDirection="column">
            {heading('RECENTLY FINISHED')}
            {v.finished.map(r => (
              <Box flexDirection="row" gap={1}>
                <Text color={r.status === 'completed' ? 'success' : 'error'}>{r.status === 'completed' ? '✓' : '✗'}</Text>
                <Text dimColor>
                  {label(r)} · {minutes((r.endedAt ?? at) - r.startedAt)}
                </Text>
              </Box>
            ))}
          </Box>
        )}

        {v.done.length > 0 && (
          <Box flexDirection="column">
            {heading('RECENTLY DONE', 'success')}
            {v.done.map(ticket)}
          </Box>
        )}

        {v.hint && <Text color="suggestion">→ {v.hint}</Text>}
      </Box>
    )
  })
}
