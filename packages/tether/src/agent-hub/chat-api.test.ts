// The chat routes over the control socket, against a fake Agent Hub: read,
// NDJSON stream, cancel, model list, and that the owner token never leaks.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { callSocket } from '../client'
import { resolvePaths, type TetherPaths } from '../config'
import { type RunningDaemon, startDaemon } from '../daemon'
import { insertAgentHubSession, insertWidget } from '../lifecycle/catalog'
import { chatTiming } from './chat-api'
import { FakeHub } from './fake-hub'

const TOKEN = 'OWNER-TOKEN-7f3c9a1e-do-not-leak'

let dir: string
let paths: TetherPaths
let daemon: RunningDaemon
let hub: FakeHub
let projectRoot: string
const everything: string[] = []

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tether-chat-api-'))
  projectRoot = join(dir, 'proj')
  mkdirSync(projectRoot)
  writeFileSync(join(dir, 'owner-token'), `${TOKEN}\n`)
  everything.length = 0
  hub = new FakeHub()
  const baseUrl = await hub.listen()
  paths = resolvePaths({
    instance: 'test',
    env: {
      HOME: dir,
      TETHER_STATE_DIR: join(dir, 'state'),
      TETHER_RUNTIME_DIR: join(dir, 'run'),
      XDG_CONFIG_HOME: join(dir, 'config'),
    },
  })
  daemon = await startDaemon(paths, {
    TETHER_SUMMITFLOW_URL: 'off',
    TETHER_RECONCILE: 'off',
    HOME: dir,
    TETHER_AGENT_HUB_URL: baseUrl,
    TETHER_AGENT_HUB_CLIENT_ID: 'client-1',
    TETHER_AGENT_HUB_OWNER_TOKEN_FILE: join(dir, 'owner-token'),
  })
  await daemon.ready
})

afterEach(async () => {
  chatTiming.heartbeatMs = 15_000
  await daemon.close()
  await hub.close()
  rmSync(dir, { recursive: true, force: true })
})

// biome-ignore lint/suspicious/noExplicitAny: loosely typed JSON bodies in assertions
type Body = Record<string, any>

async function call(method: string, path: string, body?: unknown) {
  const answer = await callSocket(paths.socket, method, path, body)
  everything.push(JSON.stringify(answer.body))
  return answer
}

const create = () =>
  call('POST', '/v1/roots', {
    requestId: 'hub-1',
    tool: 'agent-hub',
    agentSlug: 'chat',
    projectId: 'sample-app',
    projectRoot,
    initialPrompt: 'Say hello.',
    role: 'lead',
    workRole: 'implementation',
  })

async function started() {
  const made = await create()
  if (made.status !== 200) throw new Error(JSON.stringify(made))
  const id = (made.body as Body).hostIdentity as string
  const generation = ((await call('GET', `/v1/sessions/${id}`)).body as Body).generation as string
  const [hubSession] = [...hub.sessions.values()]
  return { id, generation, hubSession }
}

interface OpenStream {
  status: number
  headers: Record<string, string | string[] | undefined>
  lines: Record<string, unknown>[]
  ended: Promise<void>
  waitFor: (predicate: (lines: Record<string, unknown>[]) => boolean) => Promise<void>
  close: () => void
}

function openStream(path: string): Promise<OpenStream> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: paths.socket, method: 'GET', path }, (res) => {
      const lines: Record<string, unknown>[] = []
      let buffer = ''
      const waiters: (() => void)[] = []
      let finish: () => void = () => undefined
      const ended = new Promise<void>((r) => {
        finish = r
      })
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        everything.push(chunk)
        buffer += chunk
        for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
          const text = buffer.slice(0, at)
          buffer = buffer.slice(at + 1)
          if (text) lines.push(JSON.parse(text))
        }
        for (const wake of waiters.splice(0)) wake()
      })
      res.on('close', () => {
        finish()
        for (const wake of waiters.splice(0)) wake()
      })
      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        lines,
        ended,
        close: () => req.destroy(),
        waitFor: async (predicate) => {
          const deadline = Date.now() + 5_000
          while (!predicate(lines)) {
            if (Date.now() > deadline) throw new Error(`timed out; lines: ${JSON.stringify(lines)}`)
            await new Promise<void>((wake) => {
              waiters.push(wake)
              setTimeout(wake, 50)
            })
          }
        },
      })
    })
    req.on('error', reject)
    req.end()
  })
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('chat read', () => {
  it('returns the session with its messages and the queued follow-ups, oldest first', async () => {
    const { id, generation } = await started()
    const send = (text: string) =>
      call('POST', `/v1/sessions/${id}/inject`, { generation, text, mode: 'paste', submit: true })
    await send('Second.')
    await send('Third.')
    const chat = await call('GET', `/v1/sessions/${id}/chat`)
    expect(chat.status).toBe(200)
    const body = chat.body as Body
    expect(body.queued).toEqual(['Second.', 'Third.'])
    expect(body.session).toMatchObject({ agent_slug: 'chat', turn_state: 'running' })
    expect(body.session.messages.map((m: Body) => m.content)).toEqual(['Say hello.'])
    // messages=false is the summary only, and the queue still comes with it.
    const light = (await call('GET', `/v1/sessions/${id}/chat?messages=false`)).body as Body
    expect(light.session.messages).toBeUndefined()
    expect(light.session.message_count).toBe(1)
    expect(light.queued).toEqual(['Second.', 'Third.'])
    expect(hub.requests.at(-1)?.query.get('include_events')).toBe('false')
  })

  it('answers 404, 409 and 503 for the cases it cannot serve', async () => {
    const { id } = await started()
    expect((await call('GET', '/v1/sessions/00000000/chat')).status).toBe(404)
    insertWidget('aabbcc01', 'claude-code', 1_000, { origin: 'cli' })
    expect(await call('GET', '/v1/sessions/aabbcc01/chat')).toMatchObject({
      status: 409,
      body: { error: 'workload_unavailable' },
    })
    insertWidget('aabbcc02', 'agent-hub', 1_000, { origin: 'cli', backend: 'agent-hub' })
    insertAgentHubSession('aabbcc02', {
      hubSessionId: 'hub-session-two',
      agentSlug: 'chat',
      model: null,
    })
    for (const path of ['chat', 'chat/stream'])
      expect(await call('GET', `/v1/sessions/aabbcc02/${path}`), path).toMatchObject({
        status: 409,
        body: { error: 'workload_unavailable' },
      })
    hub.down = 503
    expect(await call('GET', `/v1/sessions/${id}/chat`)).toMatchObject({
      status: 503,
      body: { error: 'agent_hub_unavailable' },
    })
    const stream = await openStream(`/v1/sessions/${id}/chat/stream`)
    expect(stream.status).toBe(503)
    expect(await call('GET', '/v1/chat/models')).toMatchObject({
      status: 503,
      body: { error: 'agent_hub_unavailable' },
    })
  })
})

describe('chat stream', () => {
  it('replays from afterSeq, sends heartbeats and ends after the done event', async () => {
    chatTiming.heartbeatMs = 30
    const { id, hubSession } = await started()
    hub.pushEvent(hubSession.id, { type: 'content', seq: 2, content: 'Hel' })
    hub.pushEvent(hubSession.id, { type: 'content', seq: 3, content: 'lo' })
    const stream = await openStream(`/v1/sessions/${id}/chat/stream?afterSeq=1`)
    expect(stream.status).toBe(200)
    expect(String(stream.headers['content-type'])).toContain('application/x-ndjson')
    await stream.waitFor((lines) => lines.some((l) => l.type === 'heartbeat'))
    hub.pushEvent(hubSession.id, { type: 'done', seq: 4, session_id: hubSession.id })
    await stream.ended
    const events = stream.lines.filter((l) => l.type !== 'heartbeat')
    expect(events.map((l) => l.seq)).toEqual([2, 3, 4])
    expect(events.map((l) => l.type)).toEqual(['content', 'content', 'done'])
    expect(hub.requests.find((r) => r.path.endsWith('/stream'))?.query.get('after_seq')).toBe('1')
  })

  it('starts from the whole turn without afterSeq and rejects a bad one', async () => {
    const { id, hubSession } = await started()
    hub.pushEvent(hubSession.id, { type: 'done', seq: 2, session_id: hubSession.id })
    const stream = await openStream(`/v1/sessions/${id}/chat/stream`)
    await stream.ended
    expect(stream.lines.map((l) => l.type)).toEqual(['connected', 'done'])
    for (const bad of ['x', '-1', '1.5', ''])
      expect((await call('GET', `/v1/sessions/${id}/chat/stream?afterSeq=${bad}`)).status).toBe(400)
  })

  it('ends with the idle event when no turn is running', async () => {
    const { id, hubSession } = await started()
    hubSession.events = []
    hub.finishTurn(hubSession.id)
    const stream = await openStream(`/v1/sessions/${id}/chat/stream`)
    await stream.ended
    expect(stream.lines).toEqual([{ type: 'idle', session_id: hubSession.id, last_state: 'none' }])
  })

  it('aborts the upstream attach when the client leaves, and the turn keeps running', async () => {
    const { id, hubSession } = await started()
    const stream = await openStream(`/v1/sessions/${id}/chat/stream`)
    await stream.waitFor((lines) => lines.length > 0)
    await until(() => hub.streams.size === 1)
    stream.close()
    await until(() => hub.streams.size === 0)
    expect(hubSession.turnRunning).toBe(true)
    // Nothing reconnects after the client is gone.
    await new Promise((r) => setTimeout(r, 700))
    expect(hub.streams.size).toBe(0)
  })

  it('ends with one stream_error line when Agent Hub gives up mid-stream', async () => {
    const { id, hubSession } = await started()
    const stream = await openStream(`/v1/sessions/${id}/chat/stream`)
    await stream.waitFor((lines) => lines.length > 0)
    await until(() => hub.streams.size === 1)
    hub.pushEvent(hubSession.id, { type: 'content', seq: 2, content: 'partial' })
    await stream.waitFor((lines) => lines.some((l) => l.type === 'content'))
    hub.dropStreams(410)
    await stream.ended
    const last = stream.lines.at(-1) as Body
    expect(last).toMatchObject({ type: 'stream_error' })
    expect(typeof last.code).toBe('string')
    expect(typeof last.message).toBe('string')
    expect(stream.lines.filter((l) => l.type === 'stream_error')).toHaveLength(1)
    expect(stream.lines.some((l) => l.type === 'content')).toBe(true)
  })
})

describe('chat cancel and models', () => {
  it('cancels the running turn once and fences on the generation', async () => {
    const { id, generation, hubSession } = await started()
    const cancel = (body: unknown) => call('POST', `/v1/sessions/${id}/chat/cancel`, body)
    expect(await cancel({ generation: 'f'.repeat(64) })).toMatchObject({
      status: 409,
      body: { error: 'stale_generation' },
    })
    expect((await cancel({})).status).toBe(400)
    expect((await cancel({ generation, extra: 1 })).status).toBe(400)
    expect(hub.count('POST', /^\/api\/complete\/cancel$/)).toBe(0)
    expect(await cancel({ generation })).toMatchObject({
      status: 200,
      body: { cancelled: true, restored: [] },
    })
    expect(hubSession.turnRunning).toBe(false)
    expect(await cancel({ generation })).toMatchObject({ status: 200, body: { cancelled: false } })
    hub.down = 503
    expect(await cancel({ generation })).toMatchObject({
      status: 503,
      body: { error: 'agent_hub_unavailable' },
    })
  })

  it('lists the model catalog', async () => {
    expect(await call('GET', '/v1/chat/models')).toMatchObject({
      status: 200,
      body: { items: [{ id: 'cheap-model', provider: 'fake', routable: true }] },
    })
  })
})

describe('owner token', () => {
  it('never appears in an answer, a stream line or an error body', async () => {
    const { id, generation, hubSession } = await started()
    await call('GET', `/v1/sessions/${id}/chat`)
    await call('GET', '/v1/chat/models')
    const stream = await openStream(`/v1/sessions/${id}/chat/stream`)
    await stream.waitFor((lines) => lines.length > 0)
    hub.pushEvent(hubSession.id, { type: 'content', seq: 2, content: 'x' })
    hub.dropStreams(410)
    await stream.ended
    hub.attachStatus = null
    await call('POST', `/v1/sessions/${id}/chat/cancel`, { generation })
    await call('GET', '/v1/sessions/00000000/chat')
    hub.down = 503
    await call('GET', `/v1/sessions/${id}/chat`)
    await call('GET', '/v1/chat/models')
    await call('POST', `/v1/sessions/${id}/chat/cancel`, { generation })
    const failed = await openStream(`/v1/sessions/${id}/chat/stream`)
    expect(failed.status).toBe(503)
    await failed.ended
    // The test is only meaningful if Tether did send the token to Agent Hub.
    const sent = hub.requests.map((r) => r.headers['x-agent-hub-owner-token'])
    expect(sent).toContain(TOKEN)
    expect(everything.length).toBeGreaterThan(8)
    for (const text of everything) expect(text).not.toContain(TOKEN)
  })
})
