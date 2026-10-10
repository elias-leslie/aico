import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ActivityGate, DONE_AFTER_MS, START_AFTER_MS } from './activity'

describe('ActivityGate', () => {
  let events: [boolean, number][]
  let gate: ActivityGate
  beforeEach(() => {
    vi.useFakeTimers()
    events = []
    gate = new ActivityGate(
      (busy, ran) => events.push([busy, ran]),
      () => Date.now(),
    )
  })
  afterEach(() => vi.useRealTimers())

  it('reports work only after output keeps flowing', () => {
    gate.output(true)
    vi.advanceTimersByTime(START_AFTER_MS - 100)
    expect(events).toEqual([])
    vi.advanceTimersByTime(200)
    expect(events).toEqual([[true, 0]])
  })

  it('ignores a short burst', () => {
    gate.output(true)
    vi.advanceTimersByTime(400)
    gate.output(false)
    vi.advanceTimersByTime(10_000)
    expect(events).toEqual([])
  })

  it('treats short pauses as one stretch of output', () => {
    gate.output(true)
    vi.advanceTimersByTime(800)
    gate.output(false)
    vi.advanceTimersByTime(500)
    gate.output(true)
    vi.advanceTimersByTime(800)
    expect(events).toEqual([[true, 0]])
  })

  it('reports done after a quiet spell, with how long it ran', () => {
    gate.output(true)
    vi.advanceTimersByTime(START_AFTER_MS + 5000)
    gate.output(false)
    vi.advanceTimersByTime(DONE_AFTER_MS - 100)
    expect(events).toHaveLength(1)
    vi.advanceTimersByTime(200)
    expect(events[1]?.[0]).toBe(false)
    expect(events[1]?.[1]).toBeGreaterThanOrEqual(5000 + DONE_AFTER_MS)
  })

  it('keeps working through a pause shorter than the done delay', () => {
    gate.output(true)
    vi.advanceTimersByTime(START_AFTER_MS + 100)
    gate.output(false)
    vi.advanceTimersByTime(DONE_AFTER_MS / 2)
    gate.output(true)
    vi.advanceTimersByTime(DONE_AFTER_MS * 2)
    expect(events).toEqual([[true, 0]])
  })

  it('does not count typing echo as work', () => {
    for (let i = 0; i < 20; i++) {
      gate.input()
      gate.output(true)
      vi.advanceTimersByTime(150)
    }
    expect(events).toEqual([])
  })
})
