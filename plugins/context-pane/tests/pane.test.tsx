import { expect, mock, test } from 'claude-code/testing'
import type { CommandRunInput, SessionUsage } from 'claude-code'

import { hitRate, split, tokens, verdict } from '../hooks/cache'

const PANE = {
  plugin: 'context-pane',
  component: 'Pane',
  requestId: 'context',
  props: { title: 'Context', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const CMD = { command: 'context-cache', args: '', origin: { kind: 'user' }, presentation: 'chat' } as unknown as CommandRunInput

const api = (read: number, written: number, uncached: number, output = 500) => ({
  input_tokens: uncached,
  output_tokens: output,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: written,
})

const usage = (a: ReturnType<typeof api> | null): SessionUsage =>
  ({
    startedAt: 0,
    context: {
      window: 1_000_000,
      tokens: 107_000,
      percent: 11,
      breakdown: { apiUsage: a, categories: [], totalTokens: 107_000, maxTokens: 1_000_000 },
    },
    rateLimits: [],
  }) as unknown as SessionUsage

test('the helpers spell and split counts', async () => {
  expect(tokens(950)).toBe('950')
  expect(tokens(1234)).toBe('1.2k')
  expect(tokens(98_200)).toBe('98k')
  expect(tokens(1_250_000)).toBe('1.3M')
  expect(hitRate({ read: 90, written: 5, uncached: 5, output: 0 })).toBe(90)
  expect(hitRate({ read: 0, written: 0, uncached: 0, output: 0 })).toBe(undefined)
  expect(split([90, 5, 5], 28).reduce((a, b) => a + b, 0)).toBe(28)
  expect(split([0, 0, 0], 28)).toEqual([0, 0, 0])
  expect(verdict({ read: 0, written: 9000, uncached: 10, output: 0 })).toMatch(/^Cache miss/)
  expect(verdict({ read: 95_000, written: 3000, uncached: 200, output: 0 })).toMatch(/^Cache is warm/)
})

test('the pane shows the window and the last response cache, on every surface', async ($, on) => {
  mock.clock(on, { now: 0 })
  on('command.register', () => ({ value: { command: 'context-cache' } }) as never)
  on('session.start', (_, e) => ({ cwd: e.cwd }) as never)
  on('turn.complete', (_, e) => ({ text: e.answer }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('session.usage', () => ({ value: usage(api(98_000, 6_000, 2_400)) }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(CMD)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^11% · 107k \/ 1M$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^cache hit 92%$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Read from cache/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Cache is warm/ })).toBeTruthy()
    await ui.unmount()
  }
})

test('turns add up into the session totals', async ($, on) => {
  mock.clock(on, { now: 0 })
  on('command.register', () => ({ value: { command: 'context-cache' } }) as never)
  on('session.start', (_, e) => ({ cwd: e.cwd }) as never)
  on('turn.complete', (_, e) => ({ text: e.answer }) as never)
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no panes here' } }) as never)
  on('session.usage', () => ({ value: usage(api(0, 20_000, 300)) }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const turn = (u: ReturnType<typeof api>) =>
    $.turn.complete({ reason: 'answer', answer: '', durationMs: 1, isAborted: false, turnId: 't', usage: { ...u, model: 'm' } } as never)
  await turn(api(0, 20_000, 300))
  await turn(api(60_000, 1_000, 200))

  const out = await $.command.run(CMD)
  const text = 'text' in out ? out.text : ''
  expect(text).toMatch(/This session \(2 turns\): cache hit 74%/)
  expect(text).toMatch(/Last response: cache hit 0%/)
  expect(text).toMatch(/Cache miss/)
  expect(text).toMatch(/No pane here: no panes here/)
})
