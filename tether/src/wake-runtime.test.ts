import { afterEach, describe, expect, it } from 'vitest'
import type { LifecycleApiContext } from './lifecycle-api'
import { Store } from './store'
import { WaitStore } from './waits'
import { WakeService } from './wake-runtime'

const LAUNCHER = 'aaaa0001'
const LANE = 'bbbb0001'

const stores: Store[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

function service(now = 5_000) {
  const store = new Store(':memory:', () => 1_000)
  stores.push(store)
  const waits = new WaitStore(store.db)
  const context = { store, waits: { store: waits } } as unknown as LifecycleApiContext
  return { wakes: new WakeService(context, { now: () => now }), waits }
}

describe('WakeService.noteSent', () => {
  it('a coordination message to a lane counts as its launcher acting on it (review P1-2)', () => {
    // `st sessions send` reaches a lane as a delivery, not a root send: the
    // lane's next went-idle line must be a first line (a wake), not a repeat.
    const { wakes, waits } = service()
    wakes.noteSent([LAUNCHER], LANE, true)
    expect(waits.actedOn(LANE, '', [LAUNCHER], 4_999)).toBe(true)
    expect(wakes.toldSince(LAUNCHER, LANE, 4_999)).toBe(true)
  })

  it('an ack counts as acting on the session, never as telling it (review P1-3)', () => {
    const { wakes, waits } = service()
    wakes.noteSent([LAUNCHER], LANE, false)
    expect(waits.actedOn(LANE, '', [LAUNCHER], 4_999)).toBe(true)
    expect(wakes.toldSince(LAUNCHER, LANE, 0)).toBe(false)
  })

  it('a session naming itself records nothing', () => {
    const { wakes, waits } = service()
    wakes.noteSent([LANE], LANE, true)
    expect(waits.actedOn(LANE, '', [LANE], 0)).toBe(false)
    expect(wakes.toldSince(LANE, LANE, 0)).toBe(false)
  })
})
