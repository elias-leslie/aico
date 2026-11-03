import { describe, expect, it } from 'vitest'
import { HybridClock } from './hlc'

describe('HybridClock', () => {
  it('follows the wall clock and never repeats a stamp', () => {
    let wall = 1000
    const clock = new HybridClock(0, () => wall)
    expect(clock.next()).toBe(1000)
    expect(clock.next()).toBe(1001)
    expect(clock.next()).toBe(1002)
    wall = 5000
    expect(clock.next()).toBe(5000)
  })

  it('does not go backwards when the wall clock steps back', () => {
    let wall = 9000
    const clock = new HybridClock(0, () => wall)
    const first = clock.next()
    wall = 100
    expect(clock.next()).toBe(first + 1)
  })

  it('moves past a future stamp it observes', () => {
    const clock = new HybridClock(0, () => 1000)
    clock.observe(50_000)
    expect(clock.next()).toBe(50_001)
  })

  it('ignores an observed stamp it is already past', () => {
    const clock = new HybridClock(0, () => 1000)
    clock.observe(10)
    expect(clock.next()).toBe(1000)
    expect(clock.last).toBe(1000)
  })

  it('keeps order across a restart from the saved value', () => {
    let wall = 7000
    const before = new HybridClock(0, () => wall)
    before.next()
    const saved = before.next()
    wall = 10 // the machine restarted with a slow clock
    const after = new HybridClock(saved, () => wall)
    expect(after.next()).toBe(saved + 1)
  })
})
