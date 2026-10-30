import { request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { TetherError } from 'tether/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApi } from './api'
import { MAX_CHAT_STREAMS } from './chat'
import { WebStore } from './db'
import { createWebServer } from './server'
import { Shows } from './shows'
import { TerminalHub } from './terminal'
import { FakeTether } from './testing'

const SECRET = 'owner-token-0123456789abcdef'

/** A fake Tether that also answers the chat routes and holds each stream open until told. */
class ChatTether extends FakeTether {
  requests: { method: string; path: string; body: unknown }[] = []
  streams: {
    path: string
    signal: AbortSignal
    feed: (line: unknown) => void
    finish: (error?: Error) => void
  }[] = []
  failNext: Error | null = null

  async request(method: string, path: string, body?: unknown) {
    const ok = (answer: unknown) => ({ status: 200, body: answer }) as never
    this.requests.push({ method, path, body })
    if (this.failNext) {
      const error = this.failNext
      this.failNext = null
      throw error
    }
    if (path === '/v1/chat/models') return ok({ items: [{ id: 'm1' }] })
    if (/^\/v1\/sessions\/[^/]+\/chat\?messages=false$/.test(path))
      return ok({ session: {}, queued: ['later'] })
    if (/^\/v1\/sessions\/[^/]+\/chat$/.test(path))
      return ok({ session: { id: 'hub-1', messages: [] }, queued: [] })
    if (/\/inject$/.test(path)) return ok({ queued: true })
    if (/\/chat\/cancel$/.test(path)) return ok({ cancelled: true, restored: ['queued one'] })
    if (path === '/v1/runs/run1/steps/build/chat/info')
      return ok({ sessionId: 'att-2', agentSlug: 'pi', requestedModel: null, attempt: 2 })
    if (/^\/v1\/runs\/run1\/steps\/build\/chat\?session=/.test(path))
      return ok({ session: { id: 'att-2' }, queued: [] })
    return super.request(method, path, body)
  }

  stream(
    path: string,
    _headers: Record<string, string>,
    onLine: (line: unknown) => void,
    signal: AbortSignal,
  ) {
    return new Promise<void>((resolve, reject) => {
      this.streams.push({
        path,
        signal,
        feed: onLine,
        finish: (error) => (error ? reject(error) : resolve()),
      })
      signal.addEventListener('abort', () => resolve())
    })
  }
}

let tether: ChatTether
let store: WebStore
let server: Server
let base: string
let chatId: string

const guard = {
  allowedHostnames: ['localhost', '127.0.0.1'],
  allowedOrigins: ['http://127.0.0.1:3002'],
}

beforeEach(async () => {
  tether = new ChatTether()
  chatId = tether.add({
    tool: 'agent-hub',
    backend: 'agent-hub',
    agentHub: {
      sessionId: 'hub-1',
      agentSlug: 'coder',
      requestedModel: 'deepseek',
      model: 'deepseek',
      turnState: 'idle',
      turnPhase: null,
      queued: 0,
      reachable: true,
      created: true,
      promptSent: true,
    },
  }).id
  store = new WebStore(':memory:')
  const api = buildApi({
    tether: tether.client,
    store,
    config: { agentHubUrl: null, agentHubClientId: null },
    uploads: {
      dir: '/nonexistent/uploads',
      remoteDir: '~/uploads',
      maxBytes: 1024,
      maxAgeMs: 1000,
    },
    shows: new Shows({ tether: tether.client, publicHost: null, run: async () => {} }),
  })
  const hub = new TerminalHub({ tether: tether.client, historyLines: 100, touched: () => {} })
  server = createWebServer(guard, api, hub)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  store.close()
})

/** A request with the Host header of the caller's choosing (fetch will not send one). */
function withHost(method: string, path: string, host: string, body?: unknown) {
  return new Promise<number>((resolve, reject) => {
    const { port } = new URL(base)
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: { Host: host, 'Content-Type': 'application/json' },
      },
      (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      },
    )
    req.on('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

interface Answer {
  ok?: boolean
  value?: unknown
  error?: { code: string; message: string; status?: number } | string
}

/** The failure code of an `{ok: false, error}` answer. */
const codeOf = (answer: Answer): string => (answer.error as { code: string }).code

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as Answer }
}

const callChat = (method: string, args: Record<string, unknown> = {}, session = chatId) =>
  post('/api/chat/call', { session, method, args: { sessionId: 'hub-1', ...args } })

/** Read a stream's `data:` items until `count` have arrived. */
async function readItems(response: Response, count: number): Promise<unknown[]> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('no body')
  const decoder = new TextDecoder()
  const items: unknown[] = []
  let buffer = ''
  while (items.length < count) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let at = buffer.indexOf('\n\n')
    while (at >= 0) {
      const frame = buffer.slice(0, at)
      buffer = buffer.slice(at + 2)
      if (frame.startsWith('data: ')) items.push(JSON.parse(frame.slice(6)))
      at = buffer.indexOf('\n\n')
    }
  }
  reader.releaseLock()
  return items
}

describe('chat info', () => {
  it('names the Agent Hub session, agent and model of a Tether session', async () => {
    const answer = await post('/api/chat/info', { session: chatId })
    expect(answer).toEqual({
      status: 200,
      body: {
        ok: true,
        value: {
          sessionId: 'hub-1',
          agentSlug: 'coder',
          requestedModel: 'deepseek',
          answeredModel: 'deepseek',
        },
      },
    })
  })

  it('refuses a session that is not an Agent Hub chat, one that is gone and a bad name', async () => {
    const shell = tether.add({ tool: 'shell' }).id
    expect((await post('/api/chat/info', { session: shell })).body).toMatchObject({
      ok: false,
      error: { code: 'not_a_chat' },
    })
    const gone = await post('/api/chat/info', { session: 'zzzzzzzz' })
    expect(gone.status).toBe(404)
    expect(codeOf(gone.body)).toBe('not_found')
    expect((await post('/api/chat/info', { session: '../x' })).status).toBe(400)
    expect((await post('/api/chat/info', {})).status).toBe(400)
    expect(
      (await post('/api/chat/info', { session: chatId, run: 'r', step: 'build' })).status,
    ).toBe(400)
  })

  it('opens a step on its latest attempt, read only', async () => {
    const answer = await post('/api/chat/info', { run: 'run1', step: 'build' })
    expect(answer.body).toEqual({
      ok: true,
      value: { sessionId: 'att-2', agentSlug: 'pi', requestedModel: null, readOnly: true },
    })
  })
})

describe('chat calls', () => {
  it('reads the chat, the queue and the model list for the named session', async () => {
    expect((await callChat('session')).body).toEqual({
      ok: true,
      value: { id: 'hub-1', messages: [] },
    })
    expect((await callChat('queue')).body).toEqual({ ok: true, value: ['later'] })
    expect((await callChat('models')).body).toEqual({ ok: true, value: [{ id: 'm1' }] })
  })

  it('sends with the current generation and the chosen model, and cancels', async () => {
    const sent = await callChat('send', { text: 'hello', model: 'm1' })
    expect(sent.body).toEqual({ ok: true, value: { queued: true } })
    expect(tether.requests.at(-1)).toEqual({
      method: 'POST',
      path: `/v1/sessions/${chatId}/inject`,
      body: { generation: 'g1', text: 'hello', mode: 'paste', submit: true, model: 'm1' },
    })
    expect((await callChat('cancel')).body).toEqual({
      ok: true,
      value: { cancelled: true, restored: ['queued one'] },
    })
    expect(tether.requests.at(-1)).toMatchObject({
      path: `/v1/sessions/${chatId}/chat/cancel`,
      body: { generation: 'g1' },
    })
  })

  it('refuses an unknown request, empty text, another session’s id and a bad model', async () => {
    expect(codeOf((await callChat('delete')).body)).toBe('unknown_method')
    expect(codeOf((await callChat('send', { text: '  ' })).body)).toBe('invalid_text')
    expect(codeOf((await callChat('send', { text: 'x', model: 5 })).body)).toBe('invalid_model')
    const other = await post('/api/chat/call', {
      session: chatId,
      method: 'session',
      args: { sessionId: 'hub-other' },
    })
    expect(other.status).toBe(409)
    expect(codeOf(other.body)).toBe('session_mismatch')
  })

  it('reads a step and never writes to it', async () => {
    const step = { run: 'run1', step: 'build', attempt: 'att-2' }
    const read = await post('/api/chat/call', {
      ...step,
      method: 'session',
      args: { sessionId: 'att-2' },
    })
    expect(read.body).toEqual({ ok: true, value: { id: 'att-2' } })
    expect(tether.requests.at(-1)?.path).toBe('/v1/runs/run1/steps/build/chat?session=att-2')
    for (const method of ['send', 'cancel']) {
      const refused = await post('/api/chat/call', {
        ...step,
        method,
        args: { sessionId: 'att-2', text: 'hi' },
      })
      expect(refused.status).toBe(403)
      expect(codeOf(refused.body)).toBe('read_only')
    }
    const queue = await post('/api/chat/call', {
      ...step,
      method: 'queue',
      args: { sessionId: 'att-2' },
    })
    expect(queue.body).toEqual({ ok: true, value: [] })
    expect(tether.requests.some((r) => r.method === 'POST')).toBe(false)
  })

  it('words Tether’s failures and never lets a token or address through', async () => {
    tether.failNext = new TetherError(503, 'agent_hub_unavailable', {})
    const down = await callChat('session')
    expect(down.status).toBe(503)
    expect(down.body).toEqual({
      ok: false,
      error: { code: 'agent_hub_unavailable', status: 503, message: 'Agent Hub is not reachable.' },
    })
    tether.failNext = new Error(`boom ${SECRET}`)
    const odd = await callChat('session')
    expect(odd.status).toBe(502)
    expect(JSON.stringify(odd.body)).not.toContain(SECRET)
    expect(codeOf(odd.body)).toBe('chat_failed')
  })
})

describe('chat guard', () => {
  it('refuses a foreign host or origin before any Tether request', async () => {
    const before = tether.calls.length
    expect(
      await withHost('POST', '/api/chat/call', 'evil.example', {
        session: chatId,
        method: 'models',
        args: {},
      }),
    ).toBe(403)
    const origin = await post(
      '/api/chat/call',
      { session: chatId, method: 'send', args: { sessionId: 'hub-1', text: 'hi' } },
      { Origin: 'https://evil.example' },
    )
    expect(origin.status).toBe(403)
    expect(origin.body).toEqual({ error: 'origin_not_allowed' })
    expect(await withHost('GET', `/api/chat/stream?session=${chatId}`, 'evil.example')).toBe(403)
    expect(tether.calls.length).toBe(before)
    expect(tether.requests).toEqual([])
    expect(tether.streams).toEqual([])
  })
})

describe('chat stream', () => {
  it('forwards events as server-sent items, drops heartbeats and ends with the turn', async () => {
    const response = await fetch(`${base}/api/chat/stream?session=${chatId}&afterSeq=4`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(response.headers.get('cache-control')).toContain('no-store')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(tether.streams).toHaveLength(1)
    expect(tether.streams[0].path).toBe(`/v1/sessions/${chatId}/chat/stream?afterSeq=4`)
    const items = readItems(response, 3)
    const [stream] = tether.streams
    stream.feed({ type: 'content', seq: 5, content: 'hi' })
    stream.feed({ type: 'heartbeat' })
    stream.feed({ type: 'done', seq: 6 })
    stream.finish()
    expect(await items).toEqual([
      { kind: 'event', event: { type: 'content', seq: 5, content: 'hi' } },
      { kind: 'event', event: { type: 'done', seq: 6 } },
      { kind: 'end' },
    ])
  })

  it('tells the browser when the stream broke, in plain words', async () => {
    const response = await fetch(`${base}/api/chat/stream?session=${chatId}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const items = readItems(response, 1)
    tether.streams[0].feed({ type: 'stream_error', code: 'stream_interrupted', message: 'x' })
    tether.streams[0].finish()
    expect(await items).toEqual([
      {
        kind: 'error',
        error: {
          code: 'stream_interrupted',
          message: 'The connection to the running turn was lost.',
        },
      },
    ])
  })

  it('closes the Tether stream when the browser goes away', async () => {
    const controller = new AbortController()
    const response = await fetch(`${base}/api/chat/stream?session=${chatId}`, {
      signal: controller.signal,
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(tether.streams[0].signal.aborted).toBe(false)
    controller.abort()
    await response.body?.cancel().catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(tether.streams[0].signal.aborted).toBe(true)
  })

  it('reads a step’s stream on its pinned attempt', async () => {
    const response = await fetch(`${base}/api/chat/stream?run=run1&step=build&attempt=att-2`)
    expect(response.status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(tether.streams[0].path).toBe(
      '/v1/runs/run1/steps/build/chat/stream?session=att-2&afterSeq=0',
    )
    response.body?.cancel().catch(() => undefined)
  })

  it('answers a refusal as JSON before any stream opens', async () => {
    const shell = tether.add({ tool: 'shell' }).id
    const notChat = await fetch(`${base}/api/chat/stream?session=${shell}`)
    expect(notChat.status).toBe(409)
    expect(codeOf((await notChat.json()) as Answer)).toBe('not_a_chat')
    const badSeq = await fetch(`${base}/api/chat/stream?session=${chatId}&afterSeq=-1`)
    expect(badSeq.status).toBe(400)
    expect(tether.streams).toEqual([])
  })

  it('caps the streams open at once and frees a slot when one closes', async () => {
    const open: AbortController[] = []
    for (let i = 0; i < MAX_CHAT_STREAMS; i++) {
      const controller = new AbortController()
      open.push(controller)
      const response = await fetch(`${base}/api/chat/stream?session=${chatId}`, {
        signal: controller.signal,
      })
      expect(response.status).toBe(200)
    }
    const over = await fetch(`${base}/api/chat/stream?session=${chatId}`)
    expect(over.status).toBe(429)
    expect(codeOf((await over.json()) as Answer)).toBe('too_many_streams')
    open[0].abort()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const again = await fetch(`${base}/api/chat/stream?session=${chatId}`)
    expect(again.status).toBe(200)
    again.body?.cancel().catch(() => undefined)
    for (const controller of open) controller.abort()
  })
})
