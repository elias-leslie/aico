import { describe, expect, it } from 'vitest'
import { parentOf, startedBy } from './ancestry'

describe('ancestry', () => {
  it('reads the real parent from /proc', () => {
    expect(parentOf(process.pid)).toBe(process.ppid)
    expect(startedBy(process.ppid, 1)).toBe(true)
    expect(startedBy(process.pid + 100_000, 3)).toBe(false)
  })

  it('counts hops up a tree and stops at a root or an unreadable process', () => {
    const tree: Record<number, number> = { 10: 9, 9: 8, 8: 7 }
    const parent = (pid: number) => tree[pid] ?? null
    expect(startedBy(8, 2, 10, parent)).toBe(true)
    expect(startedBy(7, 2, 10, parent)).toBe(false)
    expect(startedBy(7, 3, 10, parent)).toBe(true)
    expect(startedBy(6, 9, 10, parent)).toBe(false)
  })
})
