// Pure helpers: cache counts from a usage, and how the pane spells them.

import type { CacheCounts } from '../types'

type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export function countsOf(u: Usage): CacheCounts {
  return {
    read: u.cache_read_input_tokens || 0,
    written: u.cache_creation_input_tokens || 0,
    uncached: u.input_tokens || 0,
    output: u.output_tokens || 0,
  }
}

export function add(a: CacheCounts, b: CacheCounts): CacheCounts {
  return { read: a.read + b.read, written: a.written + b.written, uncached: a.uncached + b.uncached, output: a.output + b.output }
}

export const inputOf = (c: CacheCounts) => c.read + c.written + c.uncached

// The share of the input the cache served, 0 to 100; undefined with no input.
export function hitRate(c: CacheCounts): number | undefined {
  const all = inputOf(c)
  return all ? Math.round((100 * c.read) / all) : undefined
}

export function share(part: number, c: CacheCounts): number {
  const all = inputOf(c)
  return all ? Math.round((100 * part) / all) : 0
}

// 1234 -> 1.2k, 1234567 -> 1.2M
export function tokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

// A bar of `width` cells split by parts, in order; rounding never loses a cell.
export function split(parts: readonly number[], width: number): number[] {
  const total = parts.reduce((a, b) => a + b, 0)
  if (!total) return parts.map(() => 0)
  const exact = parts.map(p => (p * width) / total)
  const cells = exact.map(Math.floor)
  let left = width - cells.reduce((a, b) => a + b, 0)
  const order = exact.map((x, i) => ({ i, rest: x - Math.floor(x) })).sort((a, b) => b.rest - a.rest)
  for (const { i } of order) {
    if (left <= 0) break
    cells[i] = (cells[i] ?? 0) + 1
    left--
  }
  return cells
}

// What a reader should take from the last response's cache, in one line.
export function verdict(c: CacheCounts | undefined): string {
  if (!c || !inputOf(c)) return 'No response yet in this window.'
  const rate = hitRate(c) ?? 0
  if (rate >= 80) return 'Cache is warm: most of the prompt was reused.'
  if (c.read === 0 && c.written > 0) return 'Cache miss: the prompt was written fresh (first request, a change near the top, or over 5 minutes idle).'
  if (rate >= 40) return 'Cache partly reused: part of the prompt changed.'
  return 'Little was reused from cache.'
}
