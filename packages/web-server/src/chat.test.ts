// The real web routes on a faux provider: no model, token or gateway is contacted.
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatSessions, openAgentDb, type RoleRules } from '@aico/agent'
import { putOriginal } from '@aico/notes/blobs'
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApi } from './api'
import type { Ask, Asks } from './asks'
import { chatStarter } from './chat'
import { readChatAttachments } from './chat-attachments'
import { WebStore } from './db'
import { NotesStore } from './notes-db'
import { createWebServer } from './server'
import { Shows } from './shows'
import { TerminalHub } from './terminal'
import { FakeTether } from './testing'
import { QUIET } from './testing-notices'

const first = fauxProvider({ provider: 'openai', api: 'faux-chat', models: [{ id: 'first' }] })
const models = createModels()
models.setProvider(first.provider)
const rules: RoleRules = {
  role: 'implementation',
  chain: [{ id: 'codex/first', piProvider: 'openai', piModel: 'first', effort: null }],
  level: 'lean',
  tools: ['bash', 'read', 'write'],
  guardHook: null,
  egress: 'host',
  hosts: null,
  contain: null,
}
let folder: string
let base: string
let chats: ChatSessions
let store: WebStore
let server: ReturnType<typeof createWebServer>
let db: ReturnType<typeof openAgentDb>
let asksStalled = false
let answered: { id: string; reply: { files?: string[] } }[]
let questions: Ask[]
let pushes: unknown[]
let captures: {
  store: NotesStore
  blobsDir: string
  limits: { maxBytes: number; maxFiles: number }
}
let attachmentFailure = false
async function attachment() {
  const bytes = Buffer.from('The attachment reached the model.')
  const hash = await putOriginal(captures.blobsDir, bytes)
  return captures.store.insertCapture({
    clientId: 'chat-test-file',
    name: 'sync-log.txt',
    kind: 'text',
    mime: 'text/plain',
    size: bytes.length,
    hash,
  }).capture.id
}
const question = (session: string): Ask => ({
  id: '0123456789ab',
  session,
  requester: null,
  question: 'Keep the first copy?',
  options: ['Keep it', 'Replace it'],
  recommended: 0,
  body: null,
  command: null,
  share: null,
  wantsFiles: null,
  files: [],
  blocking: false,
  state: 'open',
  answer: null,
  note: null,
  delivery: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  answeredAt: null,
})
const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
  return {
    status: res.status,
    body: (await res.json()) as ReturnType<ChatSessions['get']> & {
      items: { id: string; asks: unknown[] }[]
      questions: { recommended: number }[]
    },
  }
}
beforeEach(async () => {
  folder = mkdtempSync(join(tmpdir(), 'aico-chat-routes-'))
  db = openAgentDb(':memory:')
  pushes = []
  questions = []
  answered = []
  asksStalled = false
  attachmentFailure = false
  captures = {
    store: new NotesStore(':memory:', { hostName: 'test' }),
    blobsDir: join(folder, 'blobs'),
    limits: { maxBytes: 10000, maxFiles: 5 },
  }
  chats = new ChatSessions(db, {
    dataDir: folder,
    push: async (report) => {
      pushes.push(report)
    },
    rules: () => rules,
    models,
    contextFiles: [],
    attachments: async (ids) => {
      if (attachmentFailure) throw new Error('The photo is still being prepared.')
      return readChatAttachments(ids, captures)
    },
  })
  const tether = new FakeTether()
  store = new WebStore(':memory:')
  const asks = {
    list: async () => (asksStalled ? new Promise<Ask[]>(() => {}) : questions),
    snapshot: () => ({ asks: questions, state: asksStalled ? 'stale' : 'ready' }),
    answer: async (
      id: string,
      reply: { option?: number; text?: string; note?: string; files?: string[] },
    ) => {
      answered.push({ id, reply })
      if (reply.text && (reply.text.length > 100 || /[\r\n]/.test(reply.text)))
        throw new Error('Tether requires one-line answer text of at most 100 characters')
      if (reply.note && reply.note.length > 1000) throw new Error('Tether note is too long')
      const ask = questions.find((q) => q.id === id) as Ask
      ask.answer =
        reply.option !== undefined ? (ask.options[reply.option] ?? null) : (reply.text ?? null)
      ask.state = 'answered'
      ask.files = (reply.files ?? []).map((file) => ({
        id: file,
        name: 'sync-log.txt',
        mime: 'text/plain',
        size: 3,
        path: null,
        host: null,
      }))
      return ask
    },
    act: async () => {
      questions = []
      return null
    },
  } as unknown as Asks
  const api = buildApi({
    tether: tether.client,
    store,
    chats,
    captures,
    asks,
    uploads: { dir: folder, remoteDir: folder, maxBytes: 1024, maxAgeMs: 1000 },
    shows: new Shows({ tether: tether.client, publicHost: null, notices: QUIET }),
  })
  server = createWebServer(
    { allowedHostnames: ['127.0.0.1'], allowedOrigins: [] },
    api,
    new TerminalHub({ tether: tether.client, historyLines: 10, touched: () => {} }),
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterEach(async () => {
  await chats.shutdown()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  db.close()
  store.close()
  captures.store.close()
  rmSync(folder, { recursive: true, force: true })
})
const start = async () => {
  first.setResponses([fauxAssistantMessage('First answer')])
  const res = await call('POST', '/api/chat', {
    role: 'implementation',
    cwd: folder,
    message: 'First question',
  })
  expect(res.status).toBe(200)
  await chats.settled(res.body.id)
  return res.body.id as string
}
describe('Aico chat routes', () => {
  it.each(['chat', 'asks'])(
    'keeps an unrelated composer draft when an option is answered through %s',
    async (surface) => {
      const id = await start()
      const file = await attachment()
      chats.draft(id, 'My next message', [file])
      questions = [question(id)]
      first.setResponses([fauxAssistantMessage('First selected')])
      const path =
        surface === 'chat' ? `/api/chat/${id}/answer` : `/api/asks/${questions[0]?.id}/answer`
      const response = await call('POST', path, { ask: questions[0]?.id, option: 0 })
      expect(response.status).toBe(200)
      await chats.settled(id)
      expect(chats.get(id)).toMatchObject({ draft: 'My next message', draftAttachments: [file] })
    },
  )

  it('keeps a failed attachment visible and retries it with its original prompt', async () => {
    const id = await start()
    const file = await attachment()
    attachmentFailure = true
    await call('POST', `/api/chat/${id}/send`, { message: 'Read the photo', attachments: [file] })
    await chats.settled(id)
    expect(chats.get(id)).toMatchObject({
      state: 'failed',
      draft: 'Read the photo',
      draftAttachments: [file],
    })
    attachmentFailure = false
    first.setResponses([fauxAssistantMessage('Attachment received')])
    await call('POST', `/api/chat/${id}/resume`)
    await chats.settled(id)
    expect(chats.get(id).state).toBe('idle')
    expect(JSON.stringify(chats.get(id).messages)).toContain('The attachment reached the model.')
  })
  it('includes a prepared attachment when the next message answers an arriving question', async () => {
    const id = await start()
    const file = await attachment()
    questions = [question(id)]
    first.setResponses([fauxAssistantMessage('Attachment received with the answer')])
    await call('POST', `/api/chat/${id}/answer`, {
      ask: questions[0]?.id,
      message: 'Use this file',
      attachments: [file],
    })
    await chats.settled(id)
    expect(JSON.stringify(chats.get(id).messages)).toContain('The attachment reached the model.')
  })
  it('passes capture ids as files when a chat question wants files', async () => {
    const id = await start()
    const file = await attachment()
    questions = [{ ...question(id), wantsFiles: { min: 1, max: 2, hint: null } }]
    first.setResponses([fauxAssistantMessage('Got it')])
    const res = await call('POST', `/api/chat/${id}/answer`, {
      ask: questions[0]?.id,
      message: 'Here',
      attachments: [file],
    })
    expect(res.status).toBe(200)
    expect(answered[0]?.reply.files).toEqual([file])
  })
  it('sends no files for a question that does not take them', async () => {
    const id = await start()
    const file = await attachment()
    questions = [question(id)]
    first.setResponses([fauxAssistantMessage('Got it')])
    await call('POST', `/api/chat/${id}/answer`, {
      ask: questions[0]?.id,
      message: 'Here',
      attachments: [file],
    })
    expect(answered[0]?.reply.files).toBeUndefined()
  })
  it('hands the files of a drawer answer to the chat', async () => {
    const id = await start()
    const file = await attachment()
    questions = [{ ...question(id), wantsFiles: { min: 1, max: 2, hint: null } }]
    const ask = questions[0] as Ask
    first.setResponses([fauxAssistantMessage('Saw the file')])
    const res = await call('POST', `/api/asks/${ask.id}/answer`, { text: 'Photo', files: [file] })
    expect(res.status).toBe(200)
    await chats.settled(id)
    expect(JSON.stringify(chats.get(id).messages)).toContain('The attachment reached the model.')
  })
  it('names the starting session only for a chat another session started', () => {
    expect(chatStarter({ startedBy: 'codex:0123abcd' })).toBe('0123abcd')
    expect(chatStarter({ startedBy: '0123abcd' })).toBe('0123abcd')
    for (const startedBy of ['owner', null, 'codex:683968', 'codex:not-a-session'])
      expect(chatStarter({ startedBy })).toBeNull()
  })
  it('starts from role routing, stores two messages and pushes the session state and totals to Tether', async () => {
    const id = await start()
    first.setResponses([fauxAssistantMessage('Second answer')])
    expect(
      (await call('POST', `/api/chat/${id}/send`, { message: 'Second question' })).status,
    ).toBe(200)
    await chats.settled(id)
    const view = (await call('GET', `/api/chat/${id}`)).body
    expect(view.messages.map((m: { role: string }) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ])
    expect(view.state).toBe('idle')
    expect(view.nextModel).toBe('codex/first')
    expect(pushes.at(-1)).toMatchObject({
      id,
      chat: { state: 'idle', title: 'First question' },
      turns: [{ turn: 1 }, { turn: 2 }],
    })
    expect(
      pushes.find((push) => (push as { chat?: { state: string } }).chat?.state === 'working'),
    ).toMatchObject({ endedAt: null, outcome: null })
    const sessions = (await call('GET', '/api/sessions')).body.items
    expect(sessions.find((s: { id: string }) => s.id === id)).toMatchObject({
      backend: 'aico-agent',
      activity: 'idle',
      asks: [],
    })
    expect(
      (await call('POST', `/api/chat/${id}/send`, { message: ' ', model: 'outside-role' })).status,
    ).toBe(422)
    expect((await call('GET', '/api/chat/missing')).status).toBe(404)
    expect((await call('GET', '/api/agent-hub/models')).status).toBe(404)
  })
  it('returns queued messages as a draft on Stop and can finish the interrupted reply', async () => {
    const id = await start()
    const file = await attachment()
    first.setResponses([
      fauxAssistantMessage(fauxToolCall('bash', { command: 'printf partial; sleep 20' })),
    ])
    let arrived: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      arrived = resolve
    })
    const off = chats.subscribe(id, () => {
      if (db.prepare('SELECT 1 FROM tool_calls WHERE run_id = ?').get(id)) arrived()
    })
    await call('POST', `/api/chat/${id}/send`, { message: 'Run a command' })
    await started
    off()
    await call('PUT', `/api/chat/${id}/draft`, { draft: 'Queued one' })
    await call('POST', `/api/chat/${id}/send`, { message: 'Queued one', attachments: [file] })
    await call('POST', `/api/chat/${id}/send`, { message: 'Queued two' })
    const stopped = (await call('POST', `/api/chat/${id}/stop`)).body
    expect(stopped).toMatchObject({
      state: 'stopped',
      draft: 'Queued one\n\nQueued two',
      queued: [],
      draftAttachments: [file],
    })
    expect(stopped.totals.toolCalls).toBe(1)
    expect(JSON.stringify(stopped.messages)).toContain('printf partial')
    first.setResponses([fauxAssistantMessage('Finished the interrupted reply')])
    await call('POST', `/api/chat/${id}/resume`)
    await chats.settled(id)
    expect(chats.get(id)).toMatchObject({
      state: 'idle',
      note: expect.stringContaining('Resumed at'),
    })
  })
  it('branches from a turn without changing its source or copying later messages', async () => {
    const id = await start()
    const source = JSON.stringify(chats.get(id).messages)
    first.setResponses([fauxAssistantMessage('Branch answer')])
    const result = await call('POST', `/api/chat/${id}/branch`, {
      turn: 1,
      message: 'Try a different approach',
      model: 'codex/first',
    })
    expect(result.status).toBe(200)
    await chats.settled(result.body.id)
    expect(chats.get(result.body.id)).toMatchObject({ parent: id, branchTurn: 1, state: 'idle' })
    expect(chats.get(result.body.id).title).toMatch(/^Branch at turn 1 · /)
    expect(JSON.stringify(chats.get(id).messages)).toBe(source)
    expect(
      (await call('POST', `/api/chat/${id}/branch`, { turn: 999, message: 'No such turn' })).status,
    ).toBe(422)
  })
  it('only enters Needs you for a direct ask and delivers the selected answer into the chat', async () => {
    const id = await start()
    questions = [question(id)]
    const view = (await call('GET', `/api/chat/${id}`)).body
    expect(view.state).toBe('needs-you')
    expect(view.questions[0].recommended).toBe(0)
    expect((await call('GET', '/api/sessions')).body.items[0].asks).toHaveLength(1)
    first.setResponses([fauxAssistantMessage('Keeping the first copy')])
    expect(
      (await call('POST', `/api/chat/${id}/answer`, { ask: questions[0]?.id, option: 0 })).status,
    ).toBe(200)
    await chats.settled(id)
    expect((await call('GET', `/api/chat/${id}`)).body).toMatchObject({
      state: 'idle',
      questions: [],
    })
    expect(JSON.stringify(chats.get(id).messages)).toContain('Keep it')
  })
  it('answers a multiline explanation while preserving the full chat message', async () => {
    const id = await start()
    questions = [question(id)]
    const message = 'Keep the original copy.\n' + 'This is the reason. '.repeat(80)
    chats.draft(id, message)
    first.setResponses([fauxAssistantMessage('Understood')])
    expect(
      (await call('POST', `/api/chat/${id}/answer`, { ask: questions[0]?.id, message })).status,
    ).toBe(200)
    await chats.settled(id)
    expect(JSON.stringify(chats.get(id).messages)).toContain(
      JSON.stringify(message.trim()).slice(1, -1),
    )
    expect(chats.get(id).draft).toBe('')
  })
  it('uses the chosen model and effort to finish after a model swap', async () => {
    const id = await start()
    first.setResponses([
      () => ({
        ...fauxAssistantMessage('Unapproved substituted reply'),
        responseModel: 'different-model',
      }),
    ])
    await call('POST', `/api/chat/${id}/send`, { message: 'Continue' })
    await chats.settled(id)
    expect(chats.get(id).state).toBe('swapped')
    first.setResponses([fauxAssistantMessage('Resumed on the chosen model')])
    await call('POST', `/api/chat/${id}/resume`, { model: 'codex/first', effort: 'low' })
    await chats.settled(id)
    expect(chats.get(id)).toMatchObject({ state: 'idle', effort: 'low' })
    expect(chats.get(id).messages.find((m) => m.seq === 3)).toMatchObject({
      stop_reason: 'aborted',
    })
  })
  it('can return an explicitly chosen effort to routing', async () => {
    const id = await start()
    first.setResponses([fauxAssistantMessage('low'), fauxAssistantMessage('routed')])
    await call('POST', `/api/chat/${id}/send`, { message: 'Use low effort', effort: 'low' })
    await chats.settled(id)
    expect(chats.get(id).effort).toBe('low')
    await call('POST', `/api/chat/${id}/send`, { message: 'Use the role’s effort', effort: null })
    await chats.settled(id)
    expect(chats.get(id).effort).toBeNull()
  })
  it('removes an ended chat from Sessions but keeps its history and transcript', async () => {
    const id = await start()
    questions = [question(id)]
    await call('DELETE', `/api/sessions/${id}`)
    expect((await call('GET', '/api/sessions')).body.items.find((s) => s.id === id)).toBeUndefined()
    expect(chats.list().find((chat) => chat.id === id)?.state).toBe('ended')
    const ended = (await call('GET', `/api/chat/${id}`)).body
    expect(ended.state).toBe('ended')
    expect(ended.startedBy).toBe('owner')
    expect(ended.testing).toBe(false)
    expect(ended.lastReplyAt).toBeGreaterThan(0)
    expect(ended.messages.length).toBeGreaterThan(0)
    expect(questions).toEqual([])
  })
  it('keeps ended chat messages readable and paginated in Recent', async () => {
    const id = await start()
    await call('DELETE', `/api/sessions/${id}`)
    const path = `/api/history/aico-agent%3A${id}/events`
    const newest = (await call('GET', `${path}?limit=1`))
      .body as unknown as import('@aico/tether-client').HistoryEventPage
    expect(newest.items).toHaveLength(1)
    expect(newest.items[0]).toMatchObject({ role: 'assistant', kind: 'text', text: 'First answer' })
    expect(newest.older).not.toBeNull()
    const older = (await call('GET', `${path}?limit=1&before=${newest.older}`))
      .body as unknown as import('@aico/tether-client').HistoryEventPage
    expect(older.items[0]).toMatchObject({ role: 'user', kind: 'text' })
    expect(older.older).toBeNull()
    const forward = (await call('GET', `${path}?limit=1&from=${older.newer}`))
      .body as unknown as import('@aico/tether-client').HistoryEventPage
    expect(forward.items).toEqual(newest.items)
    expect((await call('GET', `${path}?limit=0`)).body.items).toHaveLength(1)
    // Other pushed runs still use Tether's existing history reader.
    expect((await call('GET', '/api/history/aico-agent%3Adeadbeef/events')).body.items).toEqual([])
  })
  it('shares when a live chat was opened across devices', async () => {
    const id = await start()
    expect((await call('POST', '/api/sessions/seen', { ids: [id] })).status).toBe(200)
    const seen = store.seenAt().get(id)
    expect(seen).toBeGreaterThan(0)
    expect((await call('GET', '/api/sessions')).body.items.find((s) => s.id === id)).toMatchObject({
      seen_at: seen,
    })
    expect((await call('GET', `/api/sessions/${id}`)).body).toMatchObject({ seen_at: seen })
  })
  it('records agent test chat provenance and keeps it after End', async () => {
    first.setResponses([fauxAssistantMessage('Test reply')])
    const { body, status } = await call('POST', '/api/chat', {
      role: 'implementation',
      cwd: folder,
      message: 'Test only',
      startedBy: 'codex:test-session',
      testing: true,
    })
    expect(status).toBe(200)
    await chats.settled(body.id)
    expect(chats.summary(body.id)).toMatchObject({ startedBy: 'codex:test-session', testing: true })
    await call('DELETE', `/api/sessions/${body.id}`)
    expect(chats.summary(body.id)).toMatchObject({
      startedBy: 'codex:test-session',
      testing: true,
      state: 'ended',
    })
    expect(
      (await call('GET', '/api/sessions')).body.items.find((s) => s.id === body.id),
    ).toBeUndefined()
  })
  it('requires an agent session when marking a chat as a test', async () => {
    expect(
      (
        await call('POST', '/api/chat', {
          role: 'implementation',
          cwd: folder,
          message: 'Test only',
          testing: true,
        })
      ).status,
    ).toBe(422)
  })
  it('keeps the chat readable when Tether’s question listing stalls', async () => {
    const id = await start()
    asksStalled = true
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 300)
    try {
      const response = await fetch(`${base}/api/chat/${id}`, { signal: controller.signal })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ state: 'idle', questionsStatus: 'stale' })
    } finally {
      clearTimeout(timer)
    }
  })
  it('streams completed and partial chat snapshots, and closes a subscriber independently of the run', async () => {
    const id = await start()
    const controller = new AbortController()
    const res = await fetch(`${base}/api/chat/${id}/stream`, { signal: controller.signal })
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const reader = res.body?.getReader()
    const chunk = await reader?.read()
    expect(new TextDecoder().decode(chunk?.value)).toContain(': open')
    controller.abort()
    expect(chats.get(id).state).toBe('idle')
  })
  it('keeps a stopped chat as an ended session after End', async () => {
    const id = await start()
    expect((await call('DELETE', `/api/sessions/${id}`)).status).toBe(200)
    expect(chats.get(id).state).toBe('ended')
    expect((await call('POST', `/api/chat/${id}/send`, { message: 'too late' })).status).toBe(409)
  })
})
