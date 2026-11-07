import { describe, expect, it } from 'vitest'
import { EventBus } from './events'

describe('EventBus', () => {
  it('numbers events and replays from a sequence', () => {
    const bus = new EventBus(3, () => 5)
    const seen: number[] = []
    const stop = bus.subscribe((event) => seen.push(event.seq))
    for (let i = 0; i < 5; i += 1) bus.publish('tools.changed', { i })
    stop()
    bus.publish('tools.changed')
    expect(seen).toEqual([1, 2, 3, 4, 5])
    expect(bus.replay(6)).toEqual([])
    expect(bus.replay(4)?.map((event) => event.seq)).toEqual([5, 6])
    expect(bus.replay(1)).toBeNull()
    expect(bus.control('heartbeat').seq).toBe(6)
  })
})
