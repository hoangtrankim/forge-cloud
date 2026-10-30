import { expect, mock, test } from 'claude-code/testing'

import { countStates, roleOf, ticketOf } from '../hooks/factory'

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

test('roles and tickets come from the agent call', async () => {
  expect(roleOf('factory-builder', 'Ticket 27 (spec 26). Follow your prompt.')).toBe('builder')
  expect(roleOf('general-purpose', 'Read `.claude/agents/factory-qa-writer.md` and follow it')).toBe('qa-writer')
  expect(roleOf('Explore', 'look around')).toBe(undefined)
  expect(ticketOf('Your task: Ticket 29 (spec 26). Follow your prompt.')).toBe(29)
  expect(ticketOf('Split spec 26.')).toBe(26)
  expect(countStates([{ state: 'in-qa' }, { state: 'in-qa' }, { state: 'planned' }])).toEqual({ 'in-qa': 2, planned: 1 })
})

test('the pane shows ticket counts and the running agent, on every surface', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('command.register', () => ({ value: { command: 'forge' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const ranIn: unknown[] = []
  on('session.cwd', () => ({ value: '/work/todo-app' }))
  on('process.run', (_, e) => {
    ranIn.push((e as { init?: { cwd?: string } }).init?.cwd ?? (e as { cwd?: string }).cwd)
    return { value: { exitCode: 0, stdout: JSON.stringify([{ state: 'building' }, { state: 'in-qa' }]), stderr: '' } }
  })
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
  on('agent.list', () => ({ value: [{ id: 'a1', description: 'x', type: 'factory-builder', status: 'running' }] }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ prompt: 'Ticket 29 (spec 26). Follow your prompt.', description: 'build 29', subagentType: 'factory-builder' } as never)
  await clock.advance(120_000)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /building 1/ }))?.text).toMatch(/in-qa 1/)
    expect((await ui.find({ type: 'Text', text: /builder #29/ }))?.text).toMatch(/sonnet · 2m/)
    await ui.unmount()
  }
  expect(ranIn[0]).toBe('/work/todo-app')
})

test('outside a factory repo the pane says so', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  on('command.register', () => ({ value: { command: 'forge' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/work' }))
  on('process.run', () => ({
    value: { exitCode: 1, stdout: '', stderr: 'fatal: not a git repository\ncannot tell which repo to use; pass --repo owner/name or set FACTORY_REPO' },
  }))
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /factory repo/ }))?.text).toBe('Not a factory repo: open the session in one')
  await ui.unmount()
})

test('a finished agent moves to Finished', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  let status = 'running'
  on('command.register', () => ({ value: { command: 'forge' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/work/todo-app' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '[]', stderr: '' } }))
  on('agent.spawn', () => ({ model: 'opus', agentId: 'r1' }))
  on('agent.list', () => ({ value: [{ id: 'r1', description: 'x', type: 'general-purpose', status }] }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({
    prompt: 'Read `.claude/agents/factory-reviewer.md` and follow it. Your task: Ticket 27 (spec 26).',
    description: 'review 27',
    subagentType: 'general-purpose',
  } as never)
  await clock.advance(60_000)
  status = 'completed'
  await clock.advance(5_000)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /reviewer #27/ }))?.text).toMatch(/^✓ reviewer #27 · opus · 1m/)
  expect((await ui.find({ type: 'Text', text: /No factory agent running/ }))?.text).toBeTruthy()
  await ui.unmount()
})

test('where no pane is placed, /forge answers with the view as text', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  on('command.register', () => ({ value: { command: 'forge' } }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'the attached surface places no panes' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/work/todo-app' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify([{ state: 'done' }, { state: 'spec' }]), stderr: '' } }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'b1' }))
  on('agent.list', () => ({ value: [{ id: 'b1', description: 'x', type: 'factory-builder', status: 'running' }] }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ prompt: 'Ticket 48 (spec 46).', description: 'build 48', subagentType: 'factory-builder' } as never)
  await clock.advance(60_000)

  const out = await $.command.run({ command: 'forge' })
  const text = 'text' in out ? out.text : ''
  expect(text).toMatch(/^Tickets: spec 1 · building 0 · in-qa 0\n/)
  expect(text).toMatch(/Running \(1\): builder #48 · sonnet · 1m/)
  expect(text).toMatch(/No pane here: the attached surface places no panes/)
})

test('where the pane is placed, /forge still answers with the view as text', async ($, on) => {
  mock.clock(on, { now: 0 })
  on('command.register', () => ({ value: { command: 'forge' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/work/todo-app' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify([{ state: 'in-review' }]), stderr: '' } }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const out = await $.command.run({ command: 'forge' })
  const text = 'text' in out ? out.text : ''
  expect(text).toMatch(/^Tickets: building 0 · in-review 1 · in-qa 0\nRunning \(0\): none$/)
})
