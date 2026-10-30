import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { TetherError } from 'tether/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { Router } from './http'
import { createWebServer } from './server'
import {
  deviceLabel,
  parseClientMessage,
  RECONNECT_CODE,
  retryDelay,
  SESSION_DEAD_CODE,
  type Size,
  sizeOf,
  TerminalHub,
  type TerminalLink,
} from './terminal'
import { FakeTether } from './testing'

class FakeLink {
  pid = 4242
  cols: number
  rows: number
  closed = false
  refusedByHost = false
  readonly written: string[] = []
  readonly pasted: string[] = []
  readonly resized: Size[] = []
  reseeds = 0
  readonly ready = Promise.resolve()
  private data: ((text: string) => void)[] = []
  private exits: (() => void)[] = []

  constructor(
    readonly argv: string[],
    readonly size: Size | null,
  ) {
    this.cols = size?.cols ?? 0
    this.rows = size?.rows ?? 0
  }
  write(text: string) {
    this.written.push(text)
  }
  paste(text: string) {
    this.pasted.push(text)
  }
  reseed() {
    this.reseeds += 1
  }
  resize(cols: number, rows: number) {
    if (cols === this.cols && rows === this.rows) return
    this.cols = cols
    this.rows = rows
    this.resized.push({ cols, rows })
  }
  settleSize() {}
  delivered() {}
  kill() {
    if (this.closed) return
    this.closed = true
    for (const exit of this.exits) exit()
  }
  onData(listener: (text: string) => void) {
    this.data.push(listener)
  }
  onExit(listener: () => void) {
    this.exits.push(listener)
  }
  emit(text: string) {
    for (const listener of this.data) listener(text)
  }
}

let tether: FakeTether
let hub: TerminalHub
let links: FakeLink[]
let server: Server
let port: number
const ORIGIN = 'http://127.0.0.1:3002'

beforeEach(async () => {
  tether = new FakeTether()
  links = []
  hub = new TerminalHub({
    tether: tether.client,
    historyLines: 123,
    touched: () => {},
    retryDelay: () => 5,
    openLink: (argv, _env, size) => {
      const link = new FakeLink(argv, size)
      links.push(link)
      return link as unknown as TerminalLink
    },
  })
  server = createWebServer(
    { allowedHostnames: ['127.0.0.1'], allowedOrigins: [ORIGIN] },
    new Router(),
    hub,
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterEach(async () => {
  hub.stop()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
})

interface Frames {
  ws: WebSocket
  controls: Record<string, unknown>[]
  data: string[]
  closed: Promise<{ code: number; reason: string }>
  next(match: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>
}

function open(id: string, headers: Record<string, string> = { Origin: ORIGIN }): Frames {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/${id}`, { headers })
  const controls: Record<string, unknown>[] = []
  const data: string[] = []
  const waiters: [
    (frame: Record<string, unknown>) => boolean,
    (f: Record<string, unknown>) => void,
  ][] = []
  ws.on('message', (raw: Buffer) => {
    if (raw[0] === 0x01) data.push(raw.subarray(1).toString())
    if (raw[0] !== 0x02) return
    const frame = JSON.parse(raw.subarray(1).toString()) as Record<string, unknown>
    controls.push(frame)
    for (const [index, [match, resolve]] of waiters.entries())
      if (match(frame)) {
        waiters.splice(index, 1)
        resolve(frame)
        break
      }
  })
  ws.on('error', () => {})
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }))
  })
  return {
    ws,
    controls,
    data,
    closed,
    next: (match) => {
      const found = controls.find(match)
      if (found) return Promise.resolve(found)
      return new Promise((resolve) => waiters.push([match, resolve]))
    },
  }
}

const ctrl = (message: Record<string, unknown>) => JSON.stringify({ __ctrl: true, ...message })
const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i += 1) await new Promise((r) => setTimeout(r, 5))
  expect(check()).toBe(true)
}

describe('frames', () => {
  it('tells control JSON from typed input', () => {
    expect(parseClientMessage(Buffer.from('ls\r'), false)).toEqual({ kind: 'data', text: 'ls\r' })
    expect(parseClientMessage(Buffer.from('{"a":1}'), false)).toEqual({
      kind: 'data',
      text: '{"a":1}',
    })
    expect(parseClientMessage(Buffer.from('{"__ctrl":true,"ping":true}'), false)).toEqual({
      kind: 'control',
      message: { __ctrl: true, ping: true },
    })
    expect(parseClientMessage(Buffer.from([0x01, 0x61]), true)).toEqual({ kind: 'data', text: 'a' })
    expect(parseClientMessage(Buffer.from([0x09]), true)).toBeNull()
  })

  it('clamps sizes and ignores malformed ones', () => {
    expect(sizeOf({ resize: { cols: 9999, rows: 0 } })).toEqual({ cols: 512, rows: 1 })
    expect(sizeOf({ resize: { cols: 80.7, rows: 24 } })).toEqual({ cols: 80, rows: 24 })
    expect(sizeOf({ resize: { cols: '80', rows: 24 } })).toBeNull()
    expect(sizeOf({ resize: null })).toBeNull()
  })

  it('names the device from the user agent', () => {
    expect(
      deviceLabel(
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36',
      ),
    ).toBe('Chrome on Android')
    expect(
      deviceLabel(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('Safari on iPhone')
    expect(
      deviceLabel('Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0'),
    ).toBe('Firefox on Linux')
    expect(deviceLabel(undefined)).toBe('Browser')
  })
})

describe('terminal socket', () => {
  it('starts at the first size, relays input and output, and claims with its label', async () => {
    const session = tether.add()
    const view = open(session.id, {
      Origin: ORIGIN,
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0 Safari/537.36',
    })
    const transport = await view.next((f) => f.transport === 'control')
    expect(transport).toEqual({ __ctrl: true, transport: 'control', history_lines: 123 })
    view.ws.send(
      ctrl({ resize: { cols: 100, rows: 40 }, claim: true, capabilities: ['binary_protocol'] }),
    )
    await until(() => links.length === 1)
    const link = links[0]
    expect(link.size).toEqual({ cols: 100, rows: 40 })
    expect(link.argv[3]).toBe('attach-session')

    const held = await view.next((f) => 'size_holder' in f)
    expect(held.size_holder).toEqual({
      here: true,
      viewer: { app: 'web', device: 'Chrome on Linux' },
    })
    expect(tether.callsOf('resizeClaim')).toEqual([
      [session.id, 'g1', 4242, 100, 40, { app: 'web', device: 'Chrome on Linux' }],
    ])

    view.ws.send('echo hi\r')
    view.ws.send(Buffer.from([0x01, ...Buffer.from('x')]))
    view.ws.send(ctrl({ paste: 'line1\nline2' }))
    view.ws.send(ctrl({ resize: { cols: 80, rows: 24 } }))
    view.ws.send(ctrl({ refresh: true }))
    view.ws.send(ctrl({ ping: true }))
    await until(() => link.reseeds === 1)
    expect(link.written).toEqual(['echo hi\r', 'x'])
    expect(link.pasted).toEqual(['line1\nline2'])
    expect(link.resized).toEqual([{ cols: 80, rows: 24 }])
    expect(tether.callsOf('resizeClaim')).toHaveLength(1)

    link.emit('hello')
    await until(() => view.data.includes('hello'))

    // Another client takes the size: the notice names it.
    hub.event({
      seq: 1,
      bootId: 'b',
      type: 'session.resized',
      at: 0,
      data: {
        id: session.id,
        generation: 'g1',
        clientPid: 9,
        cols: 50,
        rows: 20,
        changed: true,
        viewer: { app: 'desktop', device: 'davion' },
      },
    })
    const other = await view.next(
      (f) => (f.size_holder as { here?: boolean } | undefined)?.here === false,
    )
    expect(other.size_holder).toEqual({ here: false, viewer: { app: 'desktop', device: 'davion' } })

    // "Use here": a claim at the current size.
    view.ws.send(ctrl({ resize: { cols: 80, rows: 24 }, claim: true }))
    await until(() => tether.callsOf('resizeClaim').length === 2)

    view.ws.close()
    await until(() => link.closed)
    expect(hub.openCount).toBe(0)
  })

  it('starts unsized when no size arrives, and says who holds the size', async () => {
    const session = tether.add()
    tether.holder = {
      generation: 'g1',
      holder: {
        clientPid: 7,
        cols: 90,
        rows: 30,
        generation: 'g1',
        claimedAt: '',
        viewer: { app: 'desktop', device: 'box' },
      },
    }
    const view = open(session.id)
    await view.next((f) => f.transport === 'control')
    view.ws.send('typed early')
    const held = await view.next((f) => 'size_holder' in f)
    expect(held.size_holder).toEqual({ here: false, viewer: { app: 'desktop', device: 'box' } })
    expect(links[0].size).toBeNull()
    expect(links[0].written).toEqual(['typed early'])
    view.ws.close()
  })

  it('closes 4000 for a session Tether does not have, and when it ends', async () => {
    const missing = open('gone1234')
    const closed = await missing.closed
    expect(closed.code).toBe(SESSION_DEAD_CODE)
    expect(JSON.parse(closed.reason)).toMatchObject({ error: 'session_dead' })

    const session = tether.add()
    const view = open(session.id)
    await view.next((f) => f.transport === 'control')
    view.ws.send(ctrl({ resize: { cols: 80, rows: 24 } }))
    await until(() => links.length === 1)
    hub.event({ seq: 2, bootId: 'b', type: 'session.ended', at: 0, data: { id: session.id } })
    expect((await view.closed).code).toBe(SESSION_DEAD_CODE)
  })

  it("closes 4000 when the session's process exits, and asks for a reattach otherwise", async () => {
    const ending = tether.add()
    const view = open(ending.id)
    await view.next((f) => f.transport === 'control')
    view.ws.send(ctrl({ resize: { cols: 80, rows: 24 } }))
    await until(() => links.length === 1)
    tether.sessions.delete(ending.id)
    links[0].kill()
    const ended = await view.closed
    expect(ended.code).toBe(SESSION_DEAD_CODE)
    expect(JSON.parse(ended.reason)).toMatchObject({ message: 'Session ended' })

    const running = tether.add()
    const again = open(running.id)
    await again.next((f) => f.transport === 'control')
    again.ws.send(ctrl({ resize: { cols: 80, rows: 24 } }))
    await until(() => links.length === 2)
    links[1].kill()
    expect((await again.closed).code).toBe(RECONNECT_CODE)
  })

  it('refuses an upgrade from a foreign Origin before attaching', async () => {
    const session = tether.add()
    const view = open(session.id, { Origin: 'https://evil.example' })
    const error = await new Promise<Error>((resolve) => view.ws.on('error', resolve))
    expect(error.message).toMatch(/403/)
    expect(tether.callsOf('attach')).toEqual([])
  })
})

describe('a session on another host', () => {
  const HOST = 'agent-work'
  const peer = (state: string) => ({ state, since: 1, listedAt: 1 }) as never
  const hostStates = (view: Frames) =>
    view.controls
      .filter((f) => 'host_state' in f)
      .map((f) => (f.host_state as { state: string }).state)
  // The socket attaches once the page sends its first size.
  const start = async (view: Frames, size = { cols: 80, rows: 24 }) => {
    await view.next((f) => f.transport === 'control')
    view.ws.send(ctrl({ resize: size }))
  }
  const peerEvent = (type: 'peer.state' | 'peer.resync', data: Record<string, unknown>) =>
    hub.event({ seq: 9, bootId: 'b', type, at: 0, data: { host: HOST, ...data } })

  it('backs off exponentially, capped and jittered', () => {
    expect(retryDelay(0, () => 0.5)).toBe(1_000)
    expect(retryDelay(4, () => 0.5)).toBe(16_000)
    expect(retryDelay(9, () => 0)).toBe(15_000)
  })

  it('attaches over ssh and says the session is live on its host', async () => {
    const session = tether.add({ host: HOST })
    const view = open(session.id)
    await start(view)
    await until(() => links.length === 1)
    expect(links[0].argv[0]).toBe('/usr/bin/ssh')
    await view.next((f) => 'host_state' in f)
    expect(hostStates(view)).toEqual(['live'])
    view.ws.close()
  })

  it('waits for an offline host with no link, then attaches when the hub resyncs', async () => {
    const session = tether.add({ host: HOST, peer: peer('offline') })
    const view = open(session.id)
    await start(view)
    await view.next((f) => 'host_state' in f)
    expect(hostStates(view)).toEqual(['offline'])
    view.ws.send('typed while away')
    view.ws.send(ctrl({ resize: { cols: 90, rows: 30 } }))
    await new Promise((r) => setTimeout(r, 20))
    expect(links).toHaveLength(0)
    expect(tether.callsOf('attach')).toHaveLength(0)
    // Another host's resync is not this one's.
    hub.event({ seq: 9, bootId: 'b', type: 'peer.resync', at: 0, data: { host: 'other' } })
    await new Promise((r) => setTimeout(r, 20))
    expect(links).toHaveLength(0)
    peerEvent('peer.resync', {})
    await until(() => links.length === 1)
    expect(links[0].size).toEqual({ cols: 90, rows: 30 })
    expect(links[0].written).toEqual([])
    await until(() => hostStates(view).at(-1) === 'live')
    view.ws.close()
  })

  it('a host going away drops the link and keeps the socket open', async () => {
    const session = tether.add({ host: HOST })
    const view = open(session.id)
    await start(view)
    await until(() => links.length === 1)
    peerEvent('peer.state', { state: 'powered_off' })
    await until(() => hostStates(view).at(-1) === 'powered_off')
    expect(links[0].closed).toBe(true)
    expect(view.ws.readyState).toBe(WebSocket.OPEN)
    view.ws.close()
  })

  it('a dropped link retries a bounded number of times, then waits for Reconnect', async () => {
    const session = tether.add({ host: HOST })
    const view = open(session.id)
    await start(view)
    await until(() => links.length === 1)
    await until(() => hostStates(view).at(-1) === 'live')
    tether.attachFailures.push(...Array.from({ length: 6 }, () => new Error('ssh failed')))
    links[0].kill()
    await until(() => hostStates(view).at(-1) === 'disconnected')
    expect(tether.callsOf('attach')).toHaveLength(7)
    expect(hostStates(view)).toEqual(['live', 'connecting', 'disconnected'])
    expect(view.ws.readyState).toBe(WebSocket.OPEN)
    view.ws.send(ctrl({ reconnect: true }))
    await until(() => links.length === 2)
    await until(() => hostStates(view).at(-1) === 'live')
    view.ws.send('back')
    await until(() => links[1].written.includes('back'))
    view.ws.close()
  })

  it('a host with no room for another session says so, then waits for Reconnect', async () => {
    const session = tether.add({ host: HOST })
    const view = open(session.id)
    await start(view)
    await until(() => links.length === 1)
    await until(() => hostStates(view).at(-1) === 'live')
    links[0].refusedByHost = true
    links[0].kill()
    await until(() => hostStates(view).at(-1) === 'refused')
    await new Promise((r) => setTimeout(r, 20))
    expect(tether.callsOf('attach')).toHaveLength(1)
    expect(view.ws.readyState).toBe(WebSocket.OPEN)
    view.ws.send(ctrl({ reconnect: true }))
    await until(() => links.length === 2)
    await until(() => hostStates(view).at(-1) === 'live')
    view.ws.close()
  })

  it('a host_unavailable refusal shows the host state instead of closing', async () => {
    const session = tether.add({ host: HOST })
    tether.attachFailures.push(
      new TetherError(409, 'host_unavailable', { host: HOST, state: 'connecting' }),
    )
    const view = open(session.id)
    await start(view)
    await until(() => hostStates(view).at(-1) === 'connecting')
    expect(links).toHaveLength(0)
    expect(view.ws.readyState).toBe(WebSocket.OPEN)
    view.ws.close()
  })

  it('answers a resume probe even while the host is away', async () => {
    const session = tether.add({ host: HOST, peer: peer('offline') })
    const view = open(session.id)
    await start(view)
    await view.next((f) => 'host_state' in f)
    view.ws.send(ctrl({ ping: true, probe: true }))
    await view.next((f) => f.pong === true)
    view.ws.close()
  })
})
