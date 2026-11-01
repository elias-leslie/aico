import { afterEach, describe, expect, it } from 'vitest'
import { bindCatalog } from './lifecycle/catalog'
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

describe('what reached a lane (its next went-idle line wakes)', () => {
  function reachedService() {
    const store = new Store(':memory:', () => 1_000)
    stores.push(store)
    bindCatalog(store.db)
    const reached: string[] = []
    const context = {
      store,
      events: { publish: () => {} },
      lanes: { reached: (lane: string, why: string) => reached.push(`${lane} ${why}`) },
    } as unknown as LifecycleApiContext
    return { wakes: new WakeService(context, { now: () => 5_000 }), reached }
  }

  it('a line the lane takes counts when it takes it, not when it was queued', () => {
    const { wakes, reached } = reachedService()
    wakes.queueEvent(LANE, 'coord:cc:1c7a9f', '[Message] 1 request', true)
    expect(reached).toEqual([])
    expect(wakes.scheduler.takeRide(LANE)).toContain('1 request')
    expect(reached).toEqual([`${LANE} got coord:cc:1c7a9f`])
  })

  it('its own wait line, or a check-in an agent set, is no message from outside', () => {
    const { wakes, reached } = reachedService()
    wakes.noteReached(LANE, [
      { kind: 'event', source: 'wait:0123456789ab', createdBy: 'agent' },
      { kind: 'time', source: null, createdBy: 'agent' },
    ] as never)
    expect(reached).toEqual([])
    wakes.noteReached(LANE, [{ kind: 'time', source: null, createdBy: 'owner' }] as never)
    expect(reached).toEqual([`${LANE} got a check-in`])
  })

  it("a lane's ride-along yes takes back its told mark, so that turn's went-idle line still goes", () => {
    // Review of SummitFlow ebd6ea870 P1: the lane asked its launcher
    // something mid-turn (told), then answered the launcher with a noted
    // yes, which rides along. The turn's went-idle line must not be dropped.
    const { wakes } = reachedService()
    wakes.noteSent([LANE], LAUNCHER, true)
    expect(wakes.toldSince(LANE, LAUNCHER, 4_999)).toBe(true)
    wakes.noteReplied([LANE], LAUNCHER, true)
    expect(wakes.toldSince(LANE, LAUNCHER, 0)).toBe(false)
    // A wake-class reply wakes the launcher itself: the told mark stays.
    wakes.noteSent([LANE], LAUNCHER, true)
    wakes.noteReplied([LANE], LAUNCHER, false)
    expect(wakes.toldSince(LANE, LAUNCHER, 4_999)).toBe(true)
  })

  it("a lane's reply counts for the lane, never for itself as receiver", () => {
    const { wakes, reached } = reachedService()
    wakes.noteReplied([LANE], LAUNCHER)
    wakes.noteReplied([LAUNCHER], LAUNCHER)
    expect(reached).toEqual([`${LANE} replied to ${LAUNCHER}`])
  })
})
