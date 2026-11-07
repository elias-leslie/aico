import { describe, expect, it } from 'vitest'
import { agoAt, count, standing, tokenLine, WORKING_MS } from './history'

const base = {
  id: 'codex:a',
  tool: 'codex',
  parentId: null,
  project: 'demo',
  cwd: '/work/demo',
  model: 'm',
  startedAt: 0,
  endedAt: 1_000_000,
  outcome: null,
  tokens: { input: 1, cacheRead: 2, cacheWrite: 3, output: 4 },
  toolCalls: 0,
  filesWritten: 0,
} as const

describe('recent sessions copy', () => {
  it('says where a session stands from its outcome and how long it has been still', () => {
    const s = (over: object) => ({ ...base, ...over }) as never
    expect(standing(s({ outcome: 'completed' }), 9e9)).toBe('finished')
    expect(standing(s({ outcome: 'aborted' }), 9e9)).toBe('stopped')
    expect(standing(s({ outcome: 'error' }), 9e9)).toBe('failed')
    expect(standing(s({}), 1_000_000 + WORKING_MS - 1)).toBe('working')
    expect(standing(s({}), 1_000_000 + WORKING_MS)).toBe('quiet')
  })

  it('never calls a conversation Finished while a running session owns it', () => {
    const done = { ...base, outcome: 'completed' } as never
    expect(standing(done, 9e9, { activity: 'working' })).toBe('working')
    expect(standing(done, 9e9, { activity: 'idle' })).toBe('idle')
    expect(standing(done, 9e9, { activity: 'blocked' })).toBe('waiting')
    expect(standing(done, 9e9, { activity: 'unknown' })).toBe('idle')
  })

  it('shortens big numbers and keeps small ones exact', () => {
    expect(count(999)).toBe('999')
    expect(count(12_345)).toBe('12k')
    expect(count(2_500_000)).toBe('2.5M')
    expect(tokenLine(base.tokens)).toBe('1 in · 2 cached · 4 out')
  })

  it('ages in minutes and hours, and shows no age for an unknown time', () => {
    expect(agoAt(null, 0)).toBe('—')
    expect(agoAt(0, 30_000)).toBe('just now')
    expect(agoAt(0, 5 * 60_000)).toBe('5 min ago')
    expect(agoAt(0, 3 * 3_600_000)).toBe('3 h ago')
  })
})
