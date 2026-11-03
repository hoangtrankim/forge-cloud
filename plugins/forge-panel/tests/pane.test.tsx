import { expect, mock, test } from 'claude-code/testing'
import type { AgentStatus, CommandRunInput, On, ProcessRunResult } from 'claude-code'

import { countStates, filledCells, progress, repoOf, roleOf, stageOf, stepOf, ticketOf, toRows, workInHand } from '../hooks/factory'

const PANE = {
  plugin: 'forge-panel',
  component: 'Pane',
  requestId: 'forge',
  props: {
    title: 'Forge',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const FORGE = { command: 'forge', args: '', origin: { kind: 'user' }, presentation: 'chat' } as unknown as CommandRunInput

const ok = (stdout: string): ProcessRunResult =>
  ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }) as ProcessRunResult
const fail = (stderr: string): ProcessRunResult =>
  ({ exitCode: 1, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false }) as ProcessRunResult

const T = (id: number, state: string, more: Record<string, unknown> = {}) => ({
  id,
  title: `Ticket ${id}`,
  state,
  priority: 2,
  round: 0,
  risky: false,
  closed: state === 'done',
  ...more,
})

// The engine side of a factory repo: forge list answers `tickets`, git answers the remote.
function factoryRepo(on: On, tickets: unknown[], ranIn: unknown[] = []) {
  on('command.register', () => ({ value: { command: 'forge' } }) as never)
  on('session.start', (_, e) => ({ cwd: e.cwd }) as never)
  on('session.cwd', () => ({ value: '/work/todo-app' }))
  on('process.run', (_, e) => {
    ranIn.push(e.init?.cwd)
    if (e.argv[0] === 'git') return { value: ok('https://github.com/hoangtrankim/todo-app.git\n') }
    return { value: ok(JSON.stringify(tickets)) }
  })
}

test('roles, tickets, rows and repos come out right', async () => {
  expect(roleOf('factory-builder', 'Ticket 27 (spec 26). Follow your prompt.')).toBe('builder')
  expect(roleOf('general-purpose', 'Read `.claude/agents/factory-qa-writer.md` and follow it')).toBe('qa-writer')
  expect(roleOf('Explore', 'look around')).toBe(undefined)
  expect(ticketOf('Your task: Ticket 29 (spec 26). Follow your prompt.')).toBe(29)
  expect(ticketOf('Split spec 26.')).toBe(26)
  expect(stepOf('builder')).toBe('step 4 of 6')
  expect(stepOf('security')).toBe('')
  expect(countStates([{ state: 'in-qa' }, { state: 'in-qa' }, { state: 'planned' }, { state: 'spec', closed: true }])).toEqual({
    'in-qa': 2,
    planned: 1,
  })
  expect(repoOf('git@github.com:hoangtrankim/todo-app.git')).toBe('hoangtrankim/todo-app')
  expect(repoOf('https://github.com/hoangtrankim/todo-app')).toBe('hoangtrankim/todo-app')
  expect(repoOf('https://gitlab.example.com/a/b.git')).toBe(undefined)
  const rows = toRows([T(1, 'done'), T(2, 'done'), T(3, 'done'), T(4, 'done'), T(9, 'spec', { priority: 1 }), T(5, 'spec'), T(6, 'spec', { closed: true })])
  expect(rows.map(r => r.id)).toEqual([9, 5, 4, 3, 2])
})

test('progress counts the work in hand by pipeline steps', async () => {
  expect(stageOf('spec')).toBe(0)
  expect(stageOf('building')).toBe(3)
  expect(stageOf('done')).toBe(6)
  expect(stageOf('needs-human')).toBe(3)
  // Spec 40 is split into 41-43; spec 46 is not split yet; 30 is done under a closed spec.
  const rows = toRows([
    T(40, 'spec'),
    T(41, 'done', { spec: 40 }),
    T(42, 'building', { spec: 40 }),
    T(43, 'planned', { spec: 40 }),
    T(46, 'spec'),
    T(30, 'done', { spec: 29 }),
  ])
  const work = workInHand(rows)
  expect(work.map(t => t.id).sort()).toEqual([41, 42, 43, 46])
  expect(work.some(t => t.id === 40)).toBe(false)
  // (6 + 3 + 1 + 0) of 4 × 6 steps
  expect(progress(work)).toEqual({ pct: 42, done: 1, total: 4 })
  expect(progress([])).toEqual({ pct: 0, done: 0, total: 0 })
  expect(filledCells(42, 24)).toBe(10)
  expect(filledCells(150, 24)).toBe(24)
})

test('the pane lists tickets by state with links, and the running agent with its step, on every surface', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const ranIn: unknown[] = []
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  factoryRepo(on, [T(46, 'spec', { title: 'Filter todos by All, Active, Done' }), T(29, 'building', { round: 1, risky: true }), T(28, 'done')], ranIn)
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }) as never)
  on('agent.list', () => ({ value: [{ id: 'a1', description: 'x', type: 'factory-builder', status: 'running' as AgentStatus }] }) as never)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ prompt: 'Ticket 29 (spec 26). Follow your prompt.', description: 'build 29', subagentType: 'factory-builder' } as never)
  await clock.advance(120_000)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Nothing waiting on you/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /WAITING TO START/ })).toBeTruthy()
    const link = await ui.find({ type: 'Link', text: /#46 Filter todos/ })
    expect((link?.props as { href?: string } | undefined)?.href).toBe('https://github.com/hoangtrankim/todo-app/issues/46')
    expect(await ui.find({ type: 'Text', text: /round 1/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /⚠ risky/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /builder #29 · sonnet/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /step 4 of 6/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /RECENTLY DONE/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^secondary$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^\d+% · \d+ of \d+ done$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^▰▰▰$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^p\d$/ })).toBeFalsy()
    await ui.unmount()
  }
  expect(ranIn[0]).toBe('/work/todo-app')
})

test('tickets that wait on the owner go in Needs you', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  factoryRepo(on, [T(31, 'needs-human', { round: 3 }), T(32, 'blocked')])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Nothing waiting on you/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /needs your call/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Blocked: needs a hand/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Everything left waits on you/ })).toBeTruthy()
  await ui.unmount()
})

test('outside a factory repo the pane says so', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  on('command.register', () => ({ value: { command: 'forge' } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('session.start', (_, e) => ({ cwd: e.cwd }) as never)
  on('session.cwd', () => ({ value: '/work' }))
  on('process.run', () => ({
    value: fail('fatal: not a git repository\ncannot tell which repo to use; pass --repo owner/name or set FACTORY_REPO'),
  }))
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /factory repo/ }))?.text).toBe('Not a factory repo: open the session in one')
  await ui.unmount()
})

test('a finished agent moves to Recently finished', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  let status: AgentStatus = 'running' as AgentStatus
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  factoryRepo(on, [])
  on('agent.spawn', () => ({ model: 'opus', agentId: 'r1' }) as never)
  on('agent.list', () => ({ value: [{ id: 'r1', description: 'x', type: 'general-purpose', status }] }) as never)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({
    prompt: 'Read `.claude/agents/factory-reviewer.md` and follow it. Your task: Ticket 27 (spec 26).',
    description: 'review 27',
    subagentType: 'general-purpose',
  } as never)
  await clock.advance(60_000)
  status = 'completed' as AgentStatus
  await clock.advance(5_000)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /RECENTLY FINISHED/ })).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /reviewer #27/ }))?.text).toMatch(/reviewer #27 · opus · 1m/)
  expect(await ui.find({ type: 'Text', text: /No factory agent running/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /All clear/ })).toBeTruthy()
  await ui.unmount()
})

test('where no pane is placed, /forge answers with the view as text', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'the attached surface places no panes' } }) as never)
  factoryRepo(on, [T(47, 'done'), T(46, 'spec', { title: 'Filter todos' })])
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'b1' }) as never)
  on('agent.list', () => ({ value: [{ id: 'b1', description: 'x', type: 'factory-builder', status: 'running' as AgentStatus }] }) as never)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ prompt: 'Ticket 48 (spec 46).', description: 'build 48', subagentType: 'factory-builder' } as never)
  await clock.advance(60_000)

  const out = await $.command.run(FORGE)
  const text = 'text' in out ? out.text : ''
  expect(text).toMatch(/^Forge · hoangtrankim\/todo-app\n/)
  expect(text).toMatch(/Needs you: nothing ✓/)
  expect(text).toMatch(/Pipeline: █*░+ 0% · 0 of 1 done\n {2}spec 1 › planned 0 › designed 0 › building 0 › review 0 › qa 0 › done 0/)
  expect(text).toMatch(/spec:\n {2}#46 Filter todos/)
  expect(text).toMatch(/Running \(1\): builder #48 · sonnet · 1m/)
  expect(text).toMatch(/No pane here: the attached surface places no panes/)
})

test('where the pane is placed, /forge still answers with the view as text', async ($, on) => {
  mock.clock(on, { now: 0 })
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  factoryRepo(on, [T(50, 'in-review')])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const out = await $.command.run(FORGE)
  const text = 'text' in out ? out.text : ''
  expect(text).toMatch(/Pipeline: .* 67% · 0 of 1 done\n.*review 1/)
  expect(text).toMatch(/Running \(0\): none/)
  expect(text).toMatch(/Run the forge-loop skill to carry on\.$/)
  expect(text).not.toMatch(/No pane here/)
})
