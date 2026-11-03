import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyStreamEvent,
  compatibleVersion,
  eventStreamPath,
  followEvents,
  parseAttachAnswer,
  reconnectDelay,
  splitNdjson,
  TetherClient,
  TetherError,
  type TetherEvent,
  TetherUnavailable,
  tetherSocketPath,
  wakeChoices,
  wakeClock,
} from './index'

type Handler = (req: IncomingMessage, res: ServerResponse) => void

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

async function fakeTether(handler: Handler): Promise<{ client: TetherClient; server: Server }> {
  const dir = mkdtempSync(join(tmpdir(), 'tether-client-test-'))
  const socket = join(dir, 'control.sock')
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(socket, resolve))
  cleanups.push(() => {
    server.closeAllConnections()
    server.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { client: new TetherClient(socket, 1_000), server }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let text = ''
    req.on('data', (chunk) => {
      text += chunk
    })
    req.on('end', () => resolve(text ? JSON.parse(text) : null))
  })
}

const event = (seq: number, type: string, bootId = 'boot-a'): TetherEvent => ({
  seq,
  bootId,
  type,
  at: 0,
  data: {},
})

describe('Tether socket path', () => {
  it('prefers TETHER_SOCKET, then the instance under XDG_RUNTIME_DIR', () => {
    expect(tetherSocketPath({ TETHER_SOCKET: '/x/y.sock' }, 1000)).toBe('/x/y.sock')
    expect(tetherSocketPath({ XDG_RUNTIME_DIR: '/run/user/1000' }, 1000)).toBe(
      '/run/user/1000/tether/default/control.sock',
    )
    expect(tetherSocketPath({ TETHER_INSTANCE: 'dev' }, 1000)).toBe(
      '/run/user/1000/tether/dev/control.sock',
    )
  })
})

describe('version compatibility', () => {
  it('needs API 3 or later that still accepts this Aico', () => {
    const v = { name: 'tether', version: '0.0.1', apiVersion: 3, minApiVersion: 1 }
    expect(compatibleVersion(v)).toBe(true)
    expect(compatibleVersion({ ...v, apiVersion: 1 })).toBe(false)
    expect(compatibleVersion({ ...v, apiVersion: 3, minApiVersion: 2 })).toBe(false)
    expect(compatibleVersion({ ...v, apiVersion: 2 })).toBe(false)
    expect(compatibleVersion({ ...v, apiVersion: 4 })).toBe(true)
  })
})

describe('attach answer', () => {
  const answer = {
    generation: 'a'.repeat(64),
    argv: ['/usr/bin/tmux', '-S', '/x/server.sock', 'attach-session', '-t', '$3'],
    env: { TERM: 'xterm-256color' },
  }

  it("keeps Tether's argv and environment as sent, for the caller to check", () => {
    expect(parseAttachAnswer({ ...answer, unset: ['TMUX'] })).toEqual(answer)
  })

  it('refuses an answer of the wrong shape', () => {
    for (const bad of [null, { ...answer, argv: [1] }, { ...answer, env: { TERM: 1 } }, {}])
      expect(() => parseAttachAnswer(bad)).toThrow(TetherUnavailable)
  })
})

describe('NDJSON and event cursor', () => {
  it('splits complete lines and keeps the partial tail', () => {
    expect(splitNdjson('{"a":1}\n\n{"b":2}\n{"c"')).toEqual({
      lines: ['{"a":1}', '{"b":2}'],
      rest: '{"c"',
    })
  })

  it('resyncs on first hello, gap and daemon restart; drops replayed events', () => {
    let step = applyStreamEvent({ bootId: null, seq: 0 }, event(7, 'hello'))
    expect(step).toEqual({ cursor: { bootId: 'boot-a', seq: 7 }, deliver: false, resync: true })
    step = applyStreamEvent(step.cursor, event(8, 'session.created'))
    expect(step).toMatchObject({ cursor: { seq: 8 }, deliver: true, resync: false })
    expect(applyStreamEvent(step.cursor, event(8, 'session.created')).deliver).toBe(false)
    expect(applyStreamEvent(step.cursor, event(8, 'heartbeat'))).toMatchObject({
      deliver: false,
      resync: false,
    })
    expect(applyStreamEvent(step.cursor, event(8, 'hello')).resync).toBe(false)
    expect(applyStreamEvent(step.cursor, event(20, 'gap')).resync).toBe(true)
    expect(applyStreamEvent(step.cursor, event(1, 'hello', 'boot-b'))).toEqual({
      cursor: { bootId: 'boot-b', seq: 1 },
      deliver: false,
      resync: true,
    })
    expect(eventStreamPath({ bootId: null, seq: 0 })).toBe('/v1/events')
    expect(eventStreamPath({ bootId: 'b', seq: 4 })).toBe('/v1/events?since=4&bootId=b')
  })

  it('backs off exponentially to a cap', () => {
    expect(reconnectDelay(0)).toBe(500)
    expect(reconnectDelay(2)).toBe(2000)
    expect(reconnectDelay(50)).toBe(10_000)
  })
})

describe('Tether requests', () => {
  it('maps stable error codes and a missing socket', async () => {
    const { client } = await fakeTether((req, res) => {
      if (req.url === '/v1/sessions/0a1b2c3d/end')
        json(res, 409, { error: 'blocked', reason: 'scope cleanup unproven' })
      else json(res, 404, { error: 'not_found' })
    })
    const blocked = await client.end('0a1b2c3d', 'a'.repeat(64)).catch((e: unknown) => e)
    expect(blocked).toBeInstanceOf(TetherError)
    expect(blocked).toMatchObject({
      status: 409,
      code: 'blocked',
      reason: 'scope cleanup unproven',
    })
    await expect(
      new TetherClient('/nonexistent/tether.sock').listSessions(),
    ).rejects.toBeInstanceOf(TetherUnavailable)
  })
})

describe('resize claim', () => {
  it('sends the viewer label when given, and reads the holder back', async () => {
    const seen: { method?: string; url?: string; body: unknown }[] = []
    const holder = {
      clientPid: 7,
      cols: 80,
      rows: 24,
      generation: 'g',
      claimedAt: 'now',
      viewer: { app: 'web', device: 'box' },
    }
    const { client } = await fakeTether(async (req, res) => {
      seen.push({ method: req.method, url: req.url, body: await readBody(req) })
      if (req.method === 'GET') json(res, 200, { generation: 'g', holder })
      else json(res, 200, { applied: true, changed: false })
    })
    const viewer = { app: 'web', device: 'box' }
    expect(await client.resizeClaim('0a1b2c3d', 'g', 7, 80, 24, viewer)).toEqual({
      applied: true,
      changed: false,
    })
    await client.resizeClaim('0a1b2c3d', 'g', 7, 80, 24)
    expect(await client.resizeHolder('0a1b2c3d')).toEqual({ generation: 'g', holder })
    expect(seen).toEqual([
      {
        method: 'POST',
        url: '/v1/sessions/0a1b2c3d/resize-claim',
        body: { generation: 'g', clientPid: 7, cols: 80, rows: 24, viewer },
      },
      {
        method: 'POST',
        url: '/v1/sessions/0a1b2c3d/resize-claim',
        body: { generation: 'g', clientPid: 7, cols: 80, rows: 24 },
      },
      { method: 'GET', url: '/v1/sessions/0a1b2c3d/resize-claim', body: null },
    ])
  })
})

describe('event stream', () => {
  it('reconnects with since/bootId and re-lists on a gap', async () => {
    const urls: string[] = []
    let connection = 0
    const { client } = await fakeTether((req, res) => {
      urls.push(req.url ?? '')
      connection += 1
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      if (connection === 1) {
        res.write(`${JSON.stringify(event(3, 'hello'))}\n`)
        res.end(`${JSON.stringify({ ...event(4, 'session.ended'), data: { id: '0a1b2c3d' } })}\n`)
      } else {
        res.write(`${JSON.stringify(event(9, 'hello'))}\n`)
        res.write(`${JSON.stringify(event(9, 'gap'))}\n`)
      }
    })
    const seen: string[] = []
    let resyncs = 0
    const stop = followEvents(client, {
      onResync: () => {
        resyncs += 1
      },
      onEvent: (e) => seen.push(`${e.type}:${String(e.data.id)}`),
    })
    cleanups.push(stop)
    await expect.poll(() => connection, { timeout: 3_000 }).toBe(2)
    await expect.poll(() => resyncs).toBe(2)
    expect(seen).toEqual(['session.ended:0a1b2c3d'])
    expect(urls).toEqual(['/v1/events', '/v1/events?since=4&bootId=boot-a'])
  })
})

describe('wake quick choices', () => {
  const policy = { laterMinutes: 60, tonightHour: 21, morningHour: 8 }
  it('offers in an hour, tonight and tomorrow morning', () => {
    const now = new Date(2026, 9, 26, 17, 0).getTime()
    expect(wakeChoices(policy, now)).toEqual([
      { label: 'In 1 hour', dueAt: now + 3600_000 },
      { label: 'Tonight', dueAt: new Date(2026, 9, 26, 21, 0).getTime() },
      { label: 'Tomorrow morning', dueAt: new Date(2026, 9, 27, 8, 0).getTime() },
    ])
    expect(wakeClock(new Date(2026, 9, 26, 21, 0).getTime(), now)).toBe('9:00 PM')
    expect(wakeClock(new Date(2026, 9, 27, 8, 0).getTime(), now)).toBe('Tue 8:00 AM')
  })

  it('moves past hours to the next day', () => {
    const late = new Date(2026, 9, 26, 23, 0).getTime()
    expect(wakeChoices({ ...policy, laterMinutes: 90 }, late).map((c) => c.label)).toEqual([
      'In 90 min',
      'Tomorrow night',
      'Tomorrow morning',
    ])
    const early = new Date(2026, 9, 26, 2, 0).getTime()
    expect(wakeChoices(policy, early)[2]).toEqual({
      label: 'This morning',
      dueAt: new Date(2026, 9, 26, 8, 0).getTime(),
    })
  })
})
