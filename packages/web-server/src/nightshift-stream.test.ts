import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Router } from './http'
import {
  MAX_NIGHTSHIFT_STREAMS,
  NightshiftRelay,
  type RelayEvent,
  registerNightshiftStream,
} from './nightshift-stream'

/** A fake Nightshift: GET /api/stream holds each connection open until the test writes or ends it. */
class FakeNightshift {
  server: Server
  streams: ServerResponse[] = []
  status = 200
  url = ''

  constructor() {
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url !== '/api/stream') {
        res.writeHead(404).end()
        return
      }
      if (this.status !== 200) {
        res.writeHead(this.status, { 'Content-Type': 'application/json' }).end('{}')
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('retry: 3000\n\n')
      this.streams.push(res)
      res.on('close', () => {
        this.streams = this.streams.filter((s) => s !== res)
      })
    })
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  send(event: string, data: unknown, id = 1): void {
    for (const s of this.streams)
      s.write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}

const until = (check: () => boolean, ms = 3000) =>
  vi.waitFor(() => expect(check()).toBe(true), { timeout: ms })

describe('NightshiftRelay', () => {
  let nightshift: FakeNightshift
  let relay: NightshiftRelay

  beforeEach(async () => {
    nightshift = new FakeNightshift()
    await nightshift.start()
    relay = new NightshiftRelay(
      { nightshiftUrl: nightshift.url },
      { minBackoffMs: 20, maxBackoffMs: 40, coalesceMs: 20 },
    )
  })

  afterEach(async () => {
    relay.stop()
    await nightshift.stop()
    vi.restoreAllMocks()
  })

  it('opens one upstream for every listener and closes it when the last one leaves', async () => {
    expect(nightshift.streams).toHaveLength(0)
    const a: RelayEvent[] = []
    const b: RelayEvent[] = []
    const offA = relay.subscribe((e) => a.push(e))
    const offB = relay.subscribe((e) => b.push(e))
    await until(() => nightshift.streams.length === 1)

    nightshift.send('hello', { rev: 1 })
    await until(() => a.some((e) => e.type === 'changed'))
    expect(a).toEqual([{ type: 'live', live: true }, { type: 'changed' }])
    expect(b).toEqual(a)

    // One rev's batch of item events plus its health line: one `changed`.
    nightshift.send('item', { id: 'i1', rev: 2, state: 'open' }, 2)
    nightshift.send('item', { id: 'i2', rev: 2, state: null }, 2)
    nightshift.send('health', { rev: 2, counts: {}, stale: null, store: { ok: true } }, 2)
    await until(() => a.length === 3)
    await new Promise((r) => setTimeout(r, 60))
    expect(a).toEqual([{ type: 'live', live: true }, { type: 'changed' }, { type: 'changed' }])

    offA()
    expect(nightshift.streams).toHaveLength(1)
    offB()
    await until(() => nightshift.streams.length === 0)
    expect(relay.live).toBe(false)
  })

  it('says the feed is down when Nightshift drops it, and comes back by itself', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const seen: RelayEvent[] = []
    relay.subscribe((e) => seen.push(e))
    await until(() => nightshift.streams.length === 1)
    nightshift.send('hello', { rev: 1 })
    await until(() => relay.live)

    nightshift.streams[0].end()
    await until(() => seen.some((e) => e.type === 'live' && !e.live))
    await until(() => nightshift.streams.length === 1)
    nightshift.send('reset', { rev: 9 }, 9)
    await until(() => relay.live)
    expect(seen.filter((e) => e.type === 'live')).toEqual([
      { type: 'live', live: true },
      { type: 'live', live: false },
      { type: 'live', live: true },
    ])
  })

  it('never says live while Nightshift refuses the stream, and keeps trying', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    nightshift.status = 503
    const seen: RelayEvent[] = []
    relay.subscribe((e) => seen.push(e))
    await new Promise((r) => setTimeout(r, 200))
    expect(relay.live).toBe(false)
    expect(seen).toEqual([])
    // Logged once for the same reason, not per retry.
    expect(errors).toHaveBeenCalledTimes(1)
    expect(String(errors.mock.calls[0][0])).toContain('answered 503')

    nightshift.status = 200
    await until(() => nightshift.streams.length === 1)
    nightshift.send('hello', { rev: 1 })
    await until(() => relay.live)
  })

  it('reconnects when Nightshift goes silent (no keepalives either)', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    relay.stop()
    relay = new NightshiftRelay(
      { nightshiftUrl: nightshift.url },
      { minBackoffMs: 20, maxBackoffMs: 40, coalesceMs: 20, silenceMs: 100 },
    )
    relay.subscribe(() => {})
    await until(() => nightshift.streams.length === 1)
    nightshift.send('hello', { rev: 1 })
    await until(() => relay.live)
    const first = nightshift.streams[0]
    await until(() => nightshift.streams.length === 1 && nightshift.streams[0] !== first)
    expect(errors.mock.calls.map((c) => String(c[0])).join('\n')).toContain('sent nothing for')
  })

  it('opens nothing when Nightshift is not configured', () => {
    const off = new NightshiftRelay({ nightshiftUrl: null })
    const seen: RelayEvent[] = []
    off.subscribe((e) => seen.push(e))
    expect(off.live).toBe(false)
    expect(seen).toEqual([])
  })
})

describe('GET /api/nightshift/stream', () => {
  let nightshift: FakeNightshift
  let relay: NightshiftRelay
  let server: Server
  let base: string

  beforeEach(async () => {
    nightshift = new FakeNightshift()
    await nightshift.start()
    relay = new NightshiftRelay(
      { nightshiftUrl: nightshift.url },
      { minBackoffMs: 20, maxBackoffMs: 40, coalesceMs: 20 },
    )
    const router = new Router()
    registerNightshiftStream(router, relay)
    server = createServer((req, res) => {
      void router.handle(req, res, new URL(req.url ?? '/', 'http://localhost'))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    relay.stop()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await nightshift.stop()
  })

  /** Read a browser stream until `want` frames (event + data) have arrived. */
  async function frames(response: Response, want: number): Promise<string[]> {
    const reader = (response.body as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const out: string[] = []
    while (out.length < want) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let end = buffer.indexOf('\n\n')
      while (end >= 0) {
        const block = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        end = buffer.indexOf('\n\n')
        if (block.startsWith('event:')) out.push(block.replace(/\n/g, ' '))
      }
    }
    await reader.cancel()
    return out
  }

  it('relays the feed state and changes to the browser, and lets go when it leaves', async () => {
    const controller = new AbortController()
    const response = await fetch(`${base}/api/nightshift/stream`, { signal: controller.signal })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    await until(() => nightshift.streams.length === 1)
    nightshift.send('hello', { rev: 1 })
    expect(await frames(response, 3)).toEqual([
      'event: live data: {"live":false}',
      'event: live data: {"live":true}',
      'event: changed data: {}',
    ])
    controller.abort()
    await until(() => relay.listening === 0)
    await until(() => nightshift.streams.length === 0)
  })

  it('refuses past the stream bound', async () => {
    const open: AbortController[] = []
    for (let i = 0; i < MAX_NIGHTSHIFT_STREAMS; i += 1) {
      const controller = new AbortController()
      open.push(controller)
      const response = await fetch(`${base}/api/nightshift/stream`, { signal: controller.signal })
      expect(response.status).toBe(200)
    }
    const refused = await fetch(`${base}/api/nightshift/stream`)
    expect(refused.status).toBe(503)
    for (const controller of open) controller.abort()
  })
})
