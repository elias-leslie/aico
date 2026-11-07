import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Store } from '@aico/session-engine/store'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DeliveryLog, deliveryLine, deliverySource, registerDeliveryRoutes } from './deliveries'
import { HttpError, Router, sendError } from './http'
import { bindCatalog, insertWidget } from './lifecycle/catalog'
import {
  DEFAULT_WAKE_POLICY,
  PULLER_GRACE_MS,
  type WakeOperations,
  WakeScheduler,
  WakeStore,
} from './wakes'

const SESSION = '0a1b2c3d'
const SHELL = '0a1b2c3e'

let store: Store
let wakes: WakeStore
let log: DeliveryLog
let clock: { now: number }
let state: { idle: boolean; empty: boolean; lastKey: number | null }
let pasted: string[]
let lines: string[]
let scheduler: WakeScheduler
let told: [string, string, boolean][]
let replied: [string, string, boolean][]

function ops(overrides: Partial<WakeOperations> = {}): WakeOperations {
  return {
    now: () => clock.now,
    policy: () => DEFAULT_WAKE_POLICY,
    busy: async () => (state.idle ? null : 'the agent is working (claude-status)'),
    inputEmpty: async () => state.empty,
    lastKeyAt: async () => state.lastKey,
    deliver: async (_id, text) => {
      pasted.push(text)
      return true
    },
    delivered: (_id, rows, via) => log.delivered(rows, via, clock.now),
    conversationHolder: async () => null,
    relaunch: async () => ({ status: 'failed', reason: 'not in tests' }),
    changed: () => {},
    log: (line) => lines.push(line),
    ...overrides,
  }
}

beforeEach(() => {
  store = new Store(':memory:', () => 1_000)
  bindCatalog(store.db)
  insertWidget(SESSION, 'claude-code', 1_000, { origin: 'aico' })
  insertWidget(SHELL, 'bash', 1_000, { origin: 'aico' })
  let n = 0
  wakes = new WakeStore(store.db, () => {
    n += 1
    return `${n}`.padStart(12, 'a')
  })
  log = new DeliveryLog(store.db)
  clock = { now: 100_000 }
  state = { idle: true, empty: true, lastKey: null }
  pasted = []
  lines = []
  told = []
  replied = []
  scheduler = new WakeScheduler(wakes, ops())
})

afterEach(() => {
  scheduler.stop()
  store.close()
})

describe('delivery lines', () => {
  it('takes one line that cannot start a command', () => {
    expect(deliveryLine('  [Message] 1 request from cc:1c7a9f ', 500)).toBe(
      '[Message] 1 request from cc:1c7a9f',
    )
    expect(deliveryLine('/clear', 500)).toBeNull()
    expect(deliveryLine('!rm -rf /', 500)).toBeNull()
    expect(deliveryLine('two\nlines', 500)).toBeNull()
    expect(deliveryLine('bidi ‮', 500)).toBeNull()
    expect(deliveryLine('x'.repeat(501), 500)).toBeNull()
    expect(deliveryLine('', 500)).toBeNull()
    expect(deliveryLine(7, 500)).toBeNull()
  })

  it('takes an owner source but never one of Tether’s own', () => {
    expect(deliverySource('coord:cc:1c7a9f')).toBe('coord:cc:1c7a9f')
    expect(deliverySource('wait:abc')).toBeNull()
    expect(deliverySource('lane:0a1b2c3d:finished')).toBeNull()
    expect(deliverySource('ask:x')).toBeNull()
    expect(deliverySource('nocolon')).toBeNull()
    expect(deliverySource('Coord:x')).toBeNull()
  })
})

describe('native pullers', () => {
  it('hands the due lines to an attached puller instead of pasting, once', async () => {
    scheduler.start()
    const pulled = scheduler.pull(SESSION, 5_000)
    const wake = wakes.addEvent({ sessionId: SESSION, source: 'coord:x', note: 'one', now: 1 })
    log.record({ id: wake.id, sessionId: SESSION, source: 'coord:x', now: 1 })
    await scheduler.tick()
    expect(await pulled).toBe('one')
    expect(pasted).toEqual([])
    expect(wakes.forSession(SESSION)).toEqual([])
    expect(log.get(wake.id)).toMatchObject({ via: 'native', deliveredAt: 100_000 })
    // Nothing is due any more: a second puller gets nothing.
    clock.now += 60_000
    const again = scheduler.pull(SESSION, 0)
    await scheduler.tick()
    expect(await again).toBeNull()
  })

  it('does not wait for typing or the input line, only for idle', async () => {
    state.empty = false
    state.lastKey = clock.now
    scheduler.start()
    const pulled = scheduler.pull(SESSION, 5_000)
    wakes.addEvent({ sessionId: SESSION, source: 'coord:x', note: 'one', now: 1 })
    state.idle = false
    await scheduler.tick()
    expect(scheduler.heldReason(SESSION)).toMatch(/working/)
    state.idle = true
    await scheduler.tick()
    expect(await pulled).toBe('one')
    expect(pasted).toEqual([])
  })

  it('holds the paste while a puller is between polls, then pastes after the grace', async () => {
    scheduler.start()
    // A poll that does not wait holds nothing.
    expect(await scheduler.pull(SESSION, 0)).toBeNull()
    expect(scheduler.pulling(SESSION)).toBe(false)
    expect(await scheduler.pull(SESSION, 1)).toBeNull()
    wakes.addEvent({ sessionId: SESSION, source: 'coord:x', note: 'one', now: 1 })
    await scheduler.tick()
    expect(pasted).toEqual([])
    expect(scheduler.heldReason(SESSION)).toMatch(/between polls/)
    clock.now += PULLER_GRACE_MS + 1
    await scheduler.tick()
    expect(pasted).toEqual(['one'])
  })

  it('keeps the rows when the puller left before taking them', async () => {
    scheduler.start()
    const abort = new AbortController()
    const pulled = scheduler.pull(SESSION, 5_000, abort.signal)
    abort.abort()
    expect(await pulled).toBeNull()
    wakes.addEvent({ sessionId: SESSION, source: 'coord:x', note: 'one', now: 1 })
    await scheduler.tick()
    expect(wakes.forSession(SESSION)).toHaveLength(1)
    const next = scheduler.pull(SESSION, 5_000)
    await scheduler.tick()
    expect(await next).toBe('one')
  })

  it('a line being pasted is in flight, not dropped', async () => {
    let release: (ok: boolean) => void = () => {}
    scheduler = new WakeScheduler(
      wakes,
      ops({ deliver: () => new Promise<boolean>((resolve) => (release = resolve)) }),
    )
    scheduler.start()
    const wake = wakes.addEvent({ sessionId: SESSION, source: 'coord:x', note: 'one', now: 1 })
    const pass = scheduler.tick()
    for (let i = 0; i < 20 && !scheduler.inFlight(wake.id); i += 1)
      await new Promise((resolve) => setImmediate(resolve))
    expect(wakes.get(wake.id)).toBeUndefined()
    expect(scheduler.inFlight(wake.id)).toBe(true)
    release(true)
    await pass
    expect(scheduler.inFlight(wake.id)).toBe(false)
  })

  it('a line withdrawn while its paste is out does not come back if the paste fails', async () => {
    let release: (ok: boolean) => void = () => {}
    scheduler = new WakeScheduler(
      wakes,
      ops({ deliver: () => new Promise<boolean>((resolve) => (release = resolve)) }),
    )
    scheduler.start()
    const wake = wakes.addEvent({ sessionId: SESSION, source: 'coord:x', note: 'one', now: 1 })
    const pass = scheduler.tick()
    for (let i = 0; i < 20 && !scheduler.inFlight(wake.id); i += 1)
      await new Promise((resolve) => setImmediate(resolve))
    expect(scheduler.withdraw(SESSION, 'coord:x')).toEqual({ withdrawn: [], sending: true })
    release(false)
    await pass
    expect(wakes.forSession(SESSION)).toEqual([])
  })

  it('never hands a line to a client that can no longer be answered', async () => {
    scheduler.start()
    let open = true
    const pulled = scheduler.pull(SESSION, 5_000, undefined, () => open)
    open = false
    wakes.addEvent({ sessionId: SESSION, source: 'coord:x', note: 'one', now: 1 })
    await scheduler.tick()
    expect(wakes.forSession(SESSION)).toHaveLength(1)
    expect(await pulled).toBeNull()
  })

  it('a newer puller replaces the older one, which ends empty', async () => {
    scheduler.start()
    const first = scheduler.pull(SESSION, 5_000)
    const second = scheduler.pull(SESSION, 5_000)
    expect(await first).toBe('')
    wakes.addEvent({ sessionId: SESSION, source: 'coord:x', note: 'one', now: 1 })
    await scheduler.tick()
    expect(await second).toBe('one')
  })
})

describe('delivery classes', () => {
  const ride = (source: string, note: string) =>
    wakes.addEvent({ sessionId: SESSION, source, note, now: 1, ride: true })

  it('never pastes a ride-along line on its own, and does not poll for it', async () => {
    scheduler.start()
    ride('coord:x', '[Message] Ack from cc:1')
    await scheduler.tick()
    expect(pasted).toEqual([])
    expect(wakes.forSession(SESSION)).toHaveLength(1)
    expect(scheduler.heldReason(SESSION)).toMatch(/ride-along/)
    clock.now += 600_000
    await scheduler.tick()
    expect(pasted).toEqual([])
  })

  it('a ride-along line joins the next wake paste, after the wake line', async () => {
    scheduler.start()
    ride('coord:x', 'ride')
    wakes.addEvent({ sessionId: SESSION, source: 'lane:a:blocked', note: 'blocked', now: 2 })
    await scheduler.tick()
    expect(pasted).toEqual(['blocked / ride'])
    expect(wakes.forSession(SESSION)).toEqual([])
  })

  it('a wake line is never delayed by queued ride-along lines', async () => {
    scheduler.start()
    ride('coord:x', 'ride')
    await scheduler.tick()
    expect(pasted).toEqual([])
    const wake = wakes.addEvent({ sessionId: SESSION, source: 'wait:y', note: 'ready', now: 3 })
    expect(wake.ride).toBe(false)
    await scheduler.tick()
    expect(pasted).toEqual(['ready / ride'])
  })

  it('a wake line merged into a queued ride-along line makes it a wake', () => {
    const first = ride('coord:x', 'old')
    const wake = wakes.addEvent({ sessionId: SESSION, source: 'coord:x', note: 'new', now: 2 })
    expect(wake.id).toBe(first.id)
    expect(wake.ride).toBe(false)
  })

  it('a ride-along line merged into a queued wake keeps it a wake (review P1-1)', async () => {
    // The launcher is busy, so a lane's first went-idle line (a wake) waits;
    // the lane's repeat line for the same source must not turn it ride-along.
    state.idle = false
    scheduler.start()
    const first = wakes.addEvent({
      sessionId: SESSION,
      source: 'lane:a:finished',
      note: 'one',
      now: 1,
    })
    await scheduler.tick()
    const repeat = ride('lane:a:finished', 'two')
    expect(repeat).toMatchObject({ id: first.id, ride: false, note: 'two' })
    state.idle = true
    await scheduler.tick()
    expect(pasted).toEqual(['two'])
  })

  it('a paste that fails puts a wake back as a wake over a newer ride-along line', async () => {
    let n = 0
    const failing = new WakeScheduler(
      wakes,
      ops({
        deliver: async () => {
          n += 1
          // A ride-along line of the same source comes in while the paste is out.
          if (n === 1) ride('coord:x', 'newer')
          return n > 1
        },
      }),
    )
    failing.start()
    wakes.addEvent({ sessionId: SESSION, source: 'coord:x', note: 'wake', now: 1 })
    await failing.tick()
    expect(wakes.forSession(SESSION)).toMatchObject([{ note: 'newer', ride: false }])
    clock.now += 60_000
    await failing.tick()
    expect(n).toBe(2)
    failing.stop()
  })

  it('takeRide hands over only the ride-along lines, once, as a native delivery', () => {
    const one = ride('coord:x', 'one')
    log.record({ id: one.id, sessionId: SESSION, source: 'coord:x', now: 1 })
    wakes.addEvent({ sessionId: SESSION, source: 'lane:a:blocked', note: 'blocked', now: 2 })
    expect(scheduler.takeRide(SESSION)).toBe('one')
    expect(log.get(one.id)).toMatchObject({ via: 'native', deliveredAt: 100_000 })
    expect(wakes.forSession(SESSION).map((row) => row.note)).toEqual(['blocked'])
    expect(scheduler.takeRide(SESSION)).toBeNull()
  })

  it('peekRide leaves the lines queued; confirmRide takes exactly the rows peeked', () => {
    const one = ride('coord:x', 'one')
    log.record({ id: one.id, sessionId: SESSION, source: 'coord:x', now: 1 })
    ride('coord:y', 'two')
    const peeked = scheduler.peekRide(SESSION)
    expect(peeked?.text).toBe('one / two')
    // The client never confirmed (it timed out, or its hook was killed): nothing is lost.
    expect(wakes.forSession(SESSION)).toHaveLength(2)
    expect(scheduler.peekRide(SESSION)?.token).toBe(peeked?.token)
    // A newer line replaces one before the confirm: that row stays for the next turn.
    ride('coord:y', 'two, newer')
    expect(scheduler.confirmRide(SESSION, peeked?.token ?? '')).toBe(1)
    expect(log.get(one.id)).toMatchObject({ via: 'native', deliveredAt: 100_000 })
    expect(wakes.forSession(SESSION).map((row) => row.note)).toEqual(['two, newer'])
    expect(scheduler.confirmRide(SESSION, peeked?.token ?? '')).toBe(0)
  })

  it('a puller attached for wakes is not woken by ride-along lines', async () => {
    scheduler.start()
    const pulled = scheduler.pull(SESSION, 200)
    ride('coord:x', 'ride')
    await scheduler.tick()
    expect(await pulled).toBeNull()
    expect(wakes.forSession(SESSION)).toHaveLength(1)
  })
})

describe('delivery routes', () => {
  let server: Server
  let base: string

  beforeEach(async () => {
    const router = new Router()
    registerDeliveryRoutes(router, {
      log: () => log,
      exists: (id) => id === SESSION || id === SHELL,
      receiver: (id) => id === SESSION,
      maxChars: () => 500,
      queue: (id, source, line, ride, reach) =>
        wakes.addEvent({ sessionId: id, source, note: line, now: clock.now, ride, ...reach }),
      sent: (from, to, isTold) => told.push([from.join(','), to, isTold]),
      replied: (from, to, ride) => replied.push([from.join(','), to, ride]),
      takeRide: (id) => scheduler.takeRide(id),
      peekRide: (id) => scheduler.peekRide(id),
      confirmRide: (id, token) => scheduler.confirmRide(id, token),
      withdraw: (id, source) => {
        const { withdrawn, sending } = scheduler.withdraw(id, source)
        return { withdrawn: withdrawn.length, sending }
      },
      pending: (id) => wakes.get(id) !== undefined,
      pull: (id, ms, aborted) => scheduler.pull(id, ms, aborted),
      now: () => clock.now,
    })
    server = createServer((req, res) => {
      router.dispatch(req, res).catch((error) => {
        if (error instanceof HttpError) sendError(res, error)
        else res.writeHead(500).end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  async function call(method: string, path: string, body?: unknown) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }

  it('queues a line, coalesces by source and reports what became of it', async () => {
    const queued = await call('POST', `/v1/sessions/${SESSION}/deliveries`, {
      source: 'coord:cc:1c7a9f',
      line: '[Message] 1 request from cc:1c7a9f',
    })
    expect(queued.status).toBe(201)
    expect(queued.body).toMatchObject({ state: 'queued', sessionId: SESSION, coalesced: false })
    const again = await call('POST', `/v1/sessions/${SESSION}/deliveries`, {
      source: 'coord:cc:1c7a9f',
      line: '[Message] 2 requests from cc:1c7a9f',
    })
    expect(again.status).toBe(200)
    expect(again.body).toMatchObject({ id: queued.body.id, coalesced: true })
    expect(wakes.forSession(SESSION).map((row) => [row.kind, row.note])).toEqual([
      ['event', '[Message] 2 requests from cc:1c7a9f'],
    ])
    scheduler.start()
    await scheduler.tick()
    expect(pasted).toEqual(['[Message] 2 requests from cc:1c7a9f'])
    const got = await call('GET', `/v1/deliveries/${queued.body.id}`)
    expect(got.body).toMatchObject({ state: 'delivered', via: 'paste', deliveredAt: 100_000 })
  })

  it('says dropped when the row went without a delivery', async () => {
    const queued = await call('POST', `/v1/sessions/${SESSION}/deliveries`, {
      source: 'coord:x',
      line: 'hello',
    })
    wakes.remove(queued.body.id as string)
    expect((await call('GET', `/v1/deliveries/${queued.body.id}`)).body.state).toBe('dropped')
  })

  it('withdraws a stale line by source: it is never pasted, others stay', async () => {
    const stale = await call('POST', `/v1/sessions/${SESSION}/deliveries`, {
      source: 'coord:cc:1c7a9f',
      line: '[Message] 1 request from cc:1c7a9f',
    })
    await call('POST', `/v1/sessions/${SESSION}/deliveries`, {
      source: 'coord:other',
      line: 'keep',
    })
    const gone = await call(
      'DELETE',
      `/v1/sessions/${SESSION}/deliveries?source=${encodeURIComponent('coord:cc:1c7a9f')}`,
    )
    expect(gone).toMatchObject({ status: 200, body: { withdrawn: 1, sending: false } })
    expect(
      (await call('DELETE', `/v1/sessions/${SESSION}/deliveries?source=coord:cc:1c7a9f`)).body,
    ).toMatchObject({ withdrawn: 0 })
    scheduler.start()
    await scheduler.tick()
    expect(pasted).toEqual(['keep'])
    expect((await call('GET', `/v1/deliveries/${stale.body.id}`)).body.state).toBe('dropped')
    expect((await call('DELETE', `/v1/sessions/${SESSION}/deliveries?source=wait:x`)).status).toBe(
      400,
    )
    expect((await call('DELETE', `/v1/sessions/${SESSION}/deliveries`)).status).toBe(400)
    expect((await call('DELETE', '/v1/sessions/ffffffff/deliveries?source=coord:x')).status).toBe(
      404,
    )
  })

  it('refuses bad bodies, shells and unknown sessions', async () => {
    const post = (id: string, body: unknown) => call('POST', `/v1/sessions/${id}/deliveries`, body)
    expect((await post(SESSION, { source: 'wait:x', line: 'x' })).body).toMatchObject({
      error: 'invalid_body',
      field: 'source',
    })
    expect((await post(SESSION, { source: 'coord:x', line: '/clear' })).body).toMatchObject({
      field: 'line',
    })
    expect((await post(SESSION, { source: 'coord:x', line: 'x', extra: 1 })).status).toBe(400)
    expect((await post(SHELL, { source: 'coord:x', line: 'x' })).body.error).toBe(
      'delivery_unsupported',
    )
    expect((await post('ffffffff', { source: 'coord:x', line: 'x' })).status).toBe(404)
    expect((await call('GET', '/v1/deliveries/ffffffffffff')).status).toBe(404)
  })

  it('long-polls the due lines for a native puller', async () => {
    scheduler.start()
    const polled = call('GET', `/v1/sessions/${SESSION}/due?wait=5`)
    await new Promise((resolve) => setTimeout(resolve, 50))
    wakes.addEvent({ sessionId: SESSION, source: 'coord:x', note: 'ready', now: 1 })
    await scheduler.tick()
    expect((await polled).body).toEqual({ text: 'ready' })
    expect((await call('GET', `/v1/sessions/${SESSION}/due`)).body).toEqual({ text: null })
    expect((await call('GET', `/v1/sessions/${SESSION}/due?wait=56`)).status).toBe(400)
    expect((await call('GET', `/v1/sessions/${SHELL}/due`)).body.error).toBe('delivery_unsupported')
  })

  it('queues a ride-along line, takes it with ?ride=1 and records who told whom', async () => {
    const queued = await call('POST', `/v1/sessions/${SESSION}/deliveries`, {
      source: 'coord:a',
      line: '[Message] Ack from cc:1',
      ride: true,
    })
    expect(queued.status).toBe(201)
    expect(wakes.forSession(SESSION).map((row) => row.ride)).toEqual([true])
    scheduler.start()
    await scheduler.tick()
    expect(pasted).toEqual([])
    expect((await call('GET', `/v1/sessions/${SESSION}/due?ride=1`)).body).toEqual({
      text: '[Message] Ack from cc:1',
    })
    expect((await call('GET', `/v1/sessions/${SESSION}/due?ride=1`)).body).toEqual({ text: null })
    expect((await call('GET', `/v1/deliveries/${queued.body.id}`)).body).toMatchObject({
      state: 'delivered',
      via: 'native',
    })
    // A wake line names who told this session, a reply (an ack) only that its
    // sender acted on it; a ride-along line records nothing (review follow-up:
    // it moved `st aico wait`'s default since).
    await call('POST', `/v1/sessions/${SESSION}/deliveries`, {
      source: 'coord:b',
      line: 'Request',
      from: ['0a1b2c3e'],
    })
    await call('POST', `/v1/sessions/${SESSION}/deliveries`, {
      source: 'coord:c',
      line: 'FYI',
      from: ['0a1b2c3f'],
      ride: true,
    })
    await call('POST', `/v1/sessions/${SESSION}/deliveries`, {
      source: 'coord:d',
      line: 'Ack',
      from: ['0a1b2c40'],
      reply: true,
    })
    expect(told).toEqual([
      ['0a1b2c3e', SESSION, true],
      ['0a1b2c40', SESSION, false],
    ])
    // A reply, ride-along too (a lane's yes to its launcher), shows what it
    // answers reached its sender.
    await call('POST', `/v1/sessions/${SESSION}/deliveries`, {
      source: 'coord:e',
      line: 'Ack yes',
      from: ['0a1b2c41'],
      reply: true,
      ride: true,
    })
    expect(replied).toEqual([
      ['0a1b2c40', SESSION, false],
      ['0a1b2c41', SESSION, true],
    ])
    // A wake line from another session reached this one from outside; a
    // ride-along line never does, nor a line with no other sender (the
    // session's own watcher: an eta reminder, a memory notice). A ride-along
    // reply keeps its sender, for a sender that goes idle on its own wait.
    await call('POST', `/v1/sessions/${SESSION}/deliveries`, {
      source: 'coord:f',
      line: 'Your eta ran out',
    })
    await call('POST', `/v1/sessions/${SESSION}/deliveries`, {
      source: 'coord:g',
      line: 'Self',
      from: [SESSION],
    })
    const row = (source: string) => {
      const wake = wakes.forSession(SESSION).find((item) => item.source === source)
      return wake && { reached: wake.reached, replyFrom: wake.replyFrom }
    }
    expect(row('coord:b')).toEqual({ reached: true, replyFrom: [] })
    expect(row('coord:c')).toEqual({ reached: false, replyFrom: [] })
    expect(row('coord:d')).toEqual({ reached: true, replyFrom: [] })
    expect(row('coord:e')).toEqual({ reached: false, replyFrom: ['0a1b2c41'] })
    expect(row('coord:f')).toEqual({ reached: false, replyFrom: [] })
    expect(row('coord:g')).toEqual({ reached: false, replyFrom: [] })
  })

  it('peeks ride-along lines with a token and takes them only on the confirm', async () => {
    const queued = await call('POST', `/v1/sessions/${SESSION}/deliveries`, {
      source: 'coord:a',
      line: '[Message] FYI from cc:1',
      ride: true,
    })
    const peeked = await call('GET', `/v1/sessions/${SESSION}/due?ride=peek`)
    expect(peeked.body).toMatchObject({ text: '[Message] FYI from cc:1' })
    const token = peeked.body.token as string
    expect((await call('GET', `/v1/sessions/${SESSION}/due?ride=peek`)).body.token).toBe(token)
    expect((await call('GET', `/v1/deliveries/${queued.body.id}`)).body.state).toBe('queued')
    const confirm = `/v1/sessions/${SESSION}/due?token=${encodeURIComponent(token)}`
    expect((await call('DELETE', confirm)).body).toEqual({ taken: 1 })
    expect((await call('DELETE', confirm)).body).toEqual({ taken: 0 })
    expect((await call('GET', `/v1/deliveries/${queued.body.id}`)).body).toMatchObject({
      state: 'delivered',
      via: 'native',
    })
    expect((await call('GET', `/v1/sessions/${SESSION}/due?ride=peek`)).body).toEqual({
      text: null,
      token: null,
    })
    expect((await call('DELETE', `/v1/sessions/${SESSION}/due?token=nope`)).status).toBe(400)
    expect((await call('DELETE', `/v1/sessions/${SESSION}/due`)).status).toBe(400)
  })

  it('refuses a bad ride or from, and ride=1 with a wait', async () => {
    const post = (body: unknown) => call('POST', `/v1/sessions/${SESSION}/deliveries`, body)
    expect((await post({ source: 'coord:x', line: 'x', ride: 'yes' })).body).toMatchObject({
      field: 'ride',
    })
    expect((await post({ source: 'coord:x', line: 'x', from: ['nope'] })).body).toMatchObject({
      field: 'from',
    })
    expect((await post({ source: 'coord:x', line: 'x', reply: 1 })).body).toMatchObject({
      field: 'reply',
    })
    expect((await call('GET', `/v1/sessions/${SESSION}/due?ride=1&wait=5`)).status).toBe(400)
    expect((await call('GET', `/v1/sessions/${SESSION}/due?ride=2`)).status).toBe(400)
    expect((await call('GET', `/v1/sessions/${SHELL}/due?ride=1`)).body.error).toBe(
      'delivery_unsupported',
    )
  })
})
