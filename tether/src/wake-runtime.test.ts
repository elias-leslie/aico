import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindCatalog, insertWidget } from './lifecycle/catalog'
import type { LifecycleApiContext } from './lifecycle-api'
import { Store } from './store'
import { WaitStore } from './waits'
import { WakeService } from './wake-runtime'

const LAUNCHER = 'aaaa0001'
const LANE = 'bbbb0001'
const HELPER = 'cccc0001'

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

  it('a line from outside counts when it goes out, not when it was queued', () => {
    const { wakes, reached } = reachedService()
    wakes.queueEvent(LANE, 'coord:cc:1c7a9f', '[Message] 1 request', false, { reached: true })
    expect(reached).toEqual([])
    wakes.noteReached(LANE, wakes.store.forSession(LANE))
    expect(reached).toEqual([`${LANE} got coord:cc:1c7a9f`])
  })

  it("a ride-along line never counts: a helper's repeat taken with the lane's own check-in (review P1-1)", () => {
    // The lane's own check-in pastes with its helper's repeat went-idle line
    // riding along: nothing reached the lane, so its next idle stays a repeat.
    const { wakes, reached } = reachedService()
    wakes.queueEvent(LANE, `lane:${HELPER}:finished`, '[Ready] lane went idle', true)
    wakes.queueEvent(LANE, 'coord:cc:1', '[Message] FYI', true, { reached: true })
    const rows = [
      ...wakes.store.forSession(LANE),
      { kind: 'time', source: null, createdBy: 'agent', ride: false, reached: false },
    ]
    wakes.noteReached(LANE, rows as never)
    expect(reached).toEqual([])
    expect(wakes.scheduler.takeRide(LANE)).toContain('went idle')
    expect(reached).toEqual([])
    // Tether's own wake-class lane line does count.
    wakes.queueEvent(LANE, `lane:${HELPER}:blocked`, '[Ready] lane is blocked')
    wakes.noteReached(LANE, wakes.store.forSession(LANE))
    expect(reached).toEqual([`${LANE} got lane:${HELPER}:blocked`])
  })

  it("a line the lane's own watcher queued (no sender) never counts, unless merged into one from outside (review P3-1)", () => {
    const { wakes, reached } = reachedService()
    // An eta reminder: a wake-class line with no other sender.
    wakes.queueEvent(LANE, 'coord:cc:1', '[Message] 1 request (your eta ran out)')
    wakes.noteReached(LANE, wakes.store.forSession(LANE))
    expect(reached).toEqual([])
    // A peer's FYI (ride-along, from outside) then the watcher's reminder
    // merged into it: still nothing to count.
    wakes.queueEvent(LANE, 'coord:cc:2', '[Message] FYI', true, { reached: true })
    wakes.queueEvent(LANE, 'coord:cc:2', '[Message] FYI, 1 request (eta ran out)')
    expect(wakes.store.forSession(LANE).map((row) => row.reached)).toEqual([false, false])
    // A peer's request, and the watcher's line merged into it later: counts.
    wakes.queueEvent(LANE, 'coord:cc:3', '[Message] 1 request', false, { reached: true })
    wakes.queueEvent(LANE, 'coord:cc:3', '[Message] 1 request, memory notice')
    wakes.noteReached(LANE, wakes.store.forSession(LANE))
    expect(reached).toEqual([`${LANE} got coord:cc:3`])
  })

  it('a lane idle on its own wait makes its queued ride-along reply to its receivers a wake (SummitFlow dcd7053e2 gap)', () => {
    const { wakes } = reachedService()
    // The lane's noted yes to its launcher rides along; an FYI it sent and a
    // yes to someone who is not its receiver stay as they are.
    wakes.queueEvent(LAUNCHER, 'coord:cc:1', '[Message] 1 closed yes', true, {
      reached: true,
      replyFrom: [LANE],
    })
    wakes.queueEvent(LAUNCHER, 'coord:cc:2', '[Message] FYI', true, { reached: true })
    wakes.queueEvent(HELPER, 'coord:cc:3', '[Message] 1 closed yes', true, {
      reached: true,
      replyFrom: [LANE],
    })
    expect(wakes.promoteReplies(LANE, [LAUNCHER])).toEqual([LAUNCHER])
    const rows = (id: string) =>
      wakes.store.forSession(id).sort((a, b) => (a.source ?? '').localeCompare(b.source ?? ''))
    const ride = (id: string) => rows(id).map((row) => [row.source, row.ride])
    expect(ride(LAUNCHER)).toEqual([
      ['coord:cc:1', false],
      ['coord:cc:2', true],
    ])
    // Now a wake from another session, like a reply posted as a wake.
    expect(rows(LAUNCHER).map((row) => row.reached)).toEqual([true, false])
    expect(ride(HELPER)).toEqual([['coord:cc:3', true]])
    // Nothing left to promote: no second wake.
    expect(wakes.promoteReplies(LANE, [LAUNCHER])).toEqual([])
    // A newer line merged into it keeps the sender (and a wake stays a wake).
    wakes.queueEvent(HELPER, 'coord:cc:3', '[Message] 1 closed yes, 1 FYI', true, {
      reached: true,
      replyFrom: [LAUNCHER],
    })
    expect(wakes.store.forSession(HELPER)[0]?.replyFrom).toEqual([LANE, LAUNCHER])
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

describe('answers to asks', () => {
  function answerService(now = 100_000) {
    const store = new Store(':memory:', () => 1_000)
    stores.push(store)
    bindCatalog(store.db)
    insertWidget(LANE, 'claude-code', 1_000, { origin: 'aico' })
    const context = { store, events: { publish: () => {} } } as unknown as LifecycleApiContext
    const time = { now }
    return { wakes: new WakeService(context, { now: () => time.now }), time }
  }

  it('queues an answer even while the agent state is unknown (Tether just restarted)', () => {
    const { wakes } = answerService()
    const id = wakes.queueAnswer(
      LANE,
      'Owner answered ask 991a6593792d "Q?": "A"',
      'ask:991a6593792d',
    )
    expect(id).toMatch(/^[0-9a-f]{12}$/)
    expect(wakes.store.forSession(LANE).map((row) => row.source)).toEqual(['ask:991a6593792d'])
    expect(wakes.deliveries.get(id as string)).toMatchObject({ deliveredAt: null })
  })

  it('says why an answer cannot be queued', () => {
    const { wakes } = answerService()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(wakes.queueAnswer(HELPER, 'answer', 'ask:991a6593792d')).toBeNull()
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining('not queued'))
    log.mockRestore()
  })

  it('logs a queued answer that is taken back, with how long it waited', () => {
    const { wakes, time } = answerService()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const id = wakes.queueAnswer(LANE, 'answer', 'ask:991a6593792d') as string
    time.now += 120_000
    wakes.cancelLine(id, 'ask 991a6593792d closed as done')
    expect(wakes.store.get(id)).toBeUndefined()
    expect(log).toHaveBeenLastCalledWith(
      `[tether:wakes] dropped undelivered line ask:991a6593792d on session=${LANE} (ask 991a6593792d closed as done), queued 2 min earlier`,
    )
    log.mockRestore()
  })
})
