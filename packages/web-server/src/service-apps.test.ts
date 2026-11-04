import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import type { IncomingMessage, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ask } from '@aico/agent'
import { secretsDir, writePrivate } from '@aico/fleet/secrets'
import { NeedsYou, Notifier, NotifyStore, Outbox, parseNotice } from '@aico/notify'
import { StatusStore } from '@aico/status'
import type { TetherClient } from '@aico/tether-client'
import { fetchPage, openCounter, type searchWeb, today } from '@aico/webtools'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createServiceAppsServer, serviceTokenApp } from './service-apps'

const token = 'p'.repeat(43)
const otherToken = 'j'.repeat(43)
const apps = Object.fromEntries(
  ['portfolio-ai', 'jobinator-4000'].map((app) => [
    app,
    {
      machine: 'apps',
      agents: { review: { model: 'codex/gpt-6.1-sol', prompts: ['review-prompt'] } },
      prompts: ['review-prompt'],
    },
  ]),
)
let dir: string
let env: NodeJS.ProcessEnv
let server: Server
let base: string
let status: StatusStore
let notices: NotifyStore
const run = vi.fn(async (..._args: Parameters<typeof ask>) => ({
  outcome: { kind: 'done' as const, model: 'codex/gpt-6.1-sol', text: 'OK' },
  tokens: { input: 1, output: 1 },
  wallMs: 1,
}))
const search = vi.fn(
  async (..._args: Parameters<typeof searchWeb>): Promise<Record<string, unknown>> => ({
    results: [],
  }),
)
const page = vi.fn(
  async (..._args: Parameters<typeof fetchPage>): Promise<Record<string, unknown>> => ({
    content: 'Public source.',
  }),
)
const receive = vi.fn()
const tether = vi.fn()

beforeEach(async () => {
  vi.clearAllMocks()
  dir = mkdtempSync(join(tmpdir(), 'aico-apps-test-'))
  env = { AICO_DATA_DIR: dir }
  for (const [app, value] of [
    ['portfolio-ai', token],
    ['jobinator-4000', otherToken],
  ])
    writePrivate(
      join(secretsDir(env), `service-${app}.sha256`),
      createHash('sha256')
        .update(value as string)
        .digest('hex'),
    )
  status = new StatusStore(':memory:')
  notices = new NotifyStore(':memory:')
  tether.mockResolvedValue({
    body: { id: '0123456789ab', requester: 'portfolio-ai', state: 'open' },
  })
  server = createServiceAppsServer({
    status,
    notify: {
      notifier: {
        receive,
        resolve: async (source: string, key: string, text: string) => {
          for (const stored of notices.forKey(source, key))
            if (stored.askId) await tether('POST', `/v1/asks/${stored.askId}/withdraw`)
          receive({ source, key, severity: 'ok', body: text }, 'local')
          return { resolved: 1 }
        },
      } as never,
      store: notices,
      rowsWritten: vi.fn(),
    },
    tether: { request: tether } as Pick<TetherClient, 'request'>,
    env,
    apps,
    ask: run,
    web: { search, fetch: page },
    prompt: (slug) => (slug === 'review-prompt' ? 'Review carefully.' : null),
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>((done) => server.close(() => done()))
  status.close()
  notices.close()
  rmSync(dir, { recursive: true, force: true })
})
const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })

it('takes a token only directly on the LAN and never via browser or proxy headers', async () => {
  expect((await call('GET', '/v1/ask/config')).status).toBe(200)
  for (const name of [
    'origin',
    'forwarded',
    'x-forwarded-for',
    'x-forwarded-host',
    'x-forwarded-proto',
    'cf-connecting-ip',
    'cf-ray',
    'cf-access-jwt-assertion',
    'via',
  ])
    expect((await call('GET', '/v1/ask/config', undefined, { [name]: 'proxy' })).status).toBe(401)
  expect(
    (await call('GET', '/v1/ask/config', undefined, { authorization: 'Bearer wrong' })).status,
  ).toBe(401)
  const req = {
    socket: { remoteAddress: '8.8.8.8' },
    headers: { authorization: `Bearer ${token}` },
  } as IncomingMessage
  expect(serviceTokenApp(req, apps, env)).toBeNull()
})

it('cannot use sessions, commands, arbitrary files, host approvals or owner answers', async () => {
  for (const path of [
    '/api/sessions',
    '/v1/sessions',
    '/api/status',
    '/api/asks',
    '/api/agents',
    '/api/tray',
    '/v1/asks/0123456789ab/answer',
    '/v1/exec',
  ])
    expect((await call('POST', path, {})).status).toBe(404)
  for (const extra of [
    { cwd: '/elsewhere' },
    { files: ['/private'] },
    { model: 'claude' },
    { role: 'operations' },
  ])
    expect(
      (await call('POST', '/v1/ask', { agent_slug: 'review', question: 'Hello', ...extra })).status,
    ).toBe(422)
  expect(run).not.toHaveBeenCalled()
  expect(tether).not.toHaveBeenCalled()
})

it('uses only assigned model roles and prompts and preserves schema and image payloads', async () => {
  expect((await call('POST', '/v1/ask', { agent_slug: 'other', question: 'Hello' })).status).toBe(
    403,
  )
  expect((await call('GET', '/v1/ask/prompts/unassigned')).status).toBe(404)
  expect(
    ((await (await call('GET', '/v1/ask/prompts/review-prompt')).json()) as { content: string })
      .content,
  ).toBe('Review carefully.')
  const schema = { type: 'object' },
    images = [{ data: 'eA==', mimeType: 'image/png' }]
  expect(
    (await call('POST', '/v1/ask', { agent_slug: 'review', question: 'Hello', schema, images }))
      .status,
  ).toBe(200)
  expect(run.mock.calls[0]?.[0]).toMatchObject({
    model: 'codex/gpt-6.1-sol',
    question: 'Review carefully.\n\nHello',
    schema,
    images,
  })
})

const row = {
  id: 'portfolio-ai/service',
  project: 'portfolio-ai',
  machine: 'apps',
  kind: 'service',
  state: 'ok',
  what: 'Portfolio',
  meaning: 'Running.',
}
it('accepts own rows atomically and refuses other projects, hosts and command actions', async () => {
  expect((await call('POST', '/v1/status/rows', row)).status).toBe(200)
  for (const override of [
    { project: 'aico' },
    { id: 'aico/service' },
    { machine: 'elsewhere' },
    { actions: [{ kind: 'run', ref: 'sh' }] },
  ])
    expect(
      (
        await call('POST', '/v1/status/rows', [
          { ...row, id: 'portfolio-ai/second' },
          { ...row, ...override },
        ])
      ).status,
    ).toBe(403)
  expect(status.read().rows).toHaveLength(1)
  const theirs = await call('GET', '/v1/status/rows', undefined, {
    authorization: `Bearer ${otherToken}`,
  })
  expect(((await theirs.json()) as { rows: unknown[] }).rows).toEqual([])
})

it('cannot spoof another sender or create command-bearing notices or asks', async () => {
  const notice = {
    v: 1,
    source: 'portfolio-ai',
    kind: 'alert',
    severity: 'info',
    title: 'Test',
    body: 'Test',
  }
  for (const override of [{ source: 'ominull' }, { command: 'sh' }, { if_ignored: 'sh' }])
    expect((await call('POST', '/v1/notices', { ...notice, ...override })).status).toBe(403)
  expect((await call('POST', '/v1/notices', notice)).status).toBe(200)
  expect(receive).toHaveBeenCalledOnce()
  expect((await call('POST', '/v1/asks', { question: 'Continue?', command: 'sh' })).status).toBe(
    422,
  )
  expect(
    (await call('POST', '/v1/asks', { question: 'Continue?', requester: 'owner' })).status,
  ).toBe(422)
  expect((await call('POST', '/v1/asks', { question: 'Continue?' })).status).toBe(200)
  expect(tether).toHaveBeenLastCalledWith('POST', '/v1/asks', {
    question: 'Continue?',
    requester: 'portfolio-ai',
    blocking: false,
  })
})

it('reads and closes only its own asks; resolution closes only its sender and key', async () => {
  expect(
    (
      await call('POST', '/v1/asks/0123456789ab/withdraw', undefined, {
        authorization: `Bearer ${otherToken}`,
      })
    ).status,
  ).toBe(404)
  expect(tether).toHaveBeenCalledTimes(1)
  expect((await call('GET', '/v1/asks/0123456789ab')).status).toBe(200)
  expect((await call('POST', '/v1/asks/0123456789ab/withdraw')).status).toBe(200)
  expect(tether).toHaveBeenLastCalledWith('POST', '/v1/asks/0123456789ab/withdraw')
  const own = notices.accept(
    parseNotice({ v: 1, source: 'portfolio-ai', key: 'same-key', title: 'Own', body: 'Own' }),
    'local',
    [],
    Date.now(),
  )
  const other = notices.accept(
    parseNotice({ v: 1, source: 'jobinator-4000', key: 'same-key', title: 'Other', body: 'Other' }),
    'local',
    [],
    Date.now(),
  )
  notices.setAsk(own.id, 'aaaaaaaaaaaa')
  notices.setAsk(other.id, 'bbbbbbbbbbbb')
  tether.mockClear()
  expect(
    (await call('POST', '/v1/notices/resolve', { key: 'same-key', text: 'Finished.' })).status,
  ).toBe(200)
  expect(tether).toHaveBeenCalledExactlyOnceWith('POST', '/v1/asks/aaaaaaaaaaaa/withdraw')
  expect(receive).toHaveBeenLastCalledWith(
    expect.objectContaining({ source: 'portfolio-ai', key: 'same-key', severity: 'ok' }),
    'local',
  )
})

it('withdraws the ask when a condition resolves while its ask is still being created', async () => {
  let finishCreate!: (id: string) => void
  let sawResolve!: () => void
  let noticeSettled!: () => void
  const created = new Promise<string>((done) => {
    finishCreate = done
  })
  const entered = new Promise<void>((done) => {
    sawResolve = done
  })
  const settled = new Promise<void>((done) => {
    noticeSettled = done
  })
  const close = vi.fn(async () => {})
  const needsYou = new NeedsYou({ store: notices, asks: { create: () => created, close } })
  const accepted = needsYou.noticeAccepted.bind(needsYou)
  vi.spyOn(needsYou, 'noticeAccepted').mockImplementation(async (id, notice) => {
    await accepted(id, notice)
    if (notice.kind === 'todo') noticeSettled()
  })
  const forKey = notices.forKey.bind(notices)
  vi.spyOn(notices, 'forKey').mockImplementation((source, key) => {
    sawResolve()
    return forKey(source, key)
  })
  const sender = { devices: () => [], send: vi.fn(async () => 'sent' as const) }
  const outbox = new Outbox({ store: notices, sender, publicHost: null })
  const notifier = new Notifier({ store: notices, sender, outbox, needsYou, log: () => {} })
  server.closeAllConnections()
  await new Promise<void>((done) => server.close(() => done()))
  server = createServiceAppsServer({
    status,
    notify: { notifier, store: notices, rowsWritten: vi.fn() },
    tether: { request: tether } as Pick<TetherClient, 'request'>,
    env,
    apps,
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  expect(
    (
      await call('POST', '/v1/notices', {
        v: 1,
        source: 'portfolio-ai',
        kind: 'todo',
        title: 'Pending condition',
        body: 'Pending condition',
        key: 'pending',
      })
    ).status,
  ).toBe(200)
  const resolving = call('POST', '/v1/notices/resolve', {
    key: 'pending',
    text: 'Condition ended.',
  })
  await entered
  finishCreate('cccccccccccc')
  await Promise.all([settled, resolving])
  expect(close).toHaveBeenCalledExactlyOnceWith('cccccccccccc', 'withdraw')
})

it('keeps public evidence behind the app token and counts each search and fetch', async () => {
  for (const headers of [{ authorization: 'Bearer wrong' }, { 'cf-ray': 'cloudflare' }] as Record<
    string,
    string
  >[])
    expect(
      (await call('POST', '/v1/ask/evidence', { query: 'official careers' }, headers)).status,
    ).toBe(401)
  expect(search).not.toHaveBeenCalled()
  expect(
    (await call('POST', '/v1/ask/evidence', { query: 'official careers', headers: {} })).status,
  ).toBe(422)
  expect((await call('POST', '/v1/ask/evidence', { query: 'official careers' })).status).toBe(200)
  expect(search).toHaveBeenCalledWith('official careers', { max: 5 }, expect.anything())
  expect(
    (await call('POST', '/v1/ask/evidence', { url: 'https://example.com/careers' })).status,
  ).toBe(200)
  expect(page).toHaveBeenCalledWith(
    'https://example.com/careers',
    { maxChars: 12000, backend: 'jina' },
    expect.anything(),
  )
  const db = openCounter(dir)
  try {
    expect(today(db, new Date())).toMatchObject({
      calls: 2,
      byVerb: { 'portfolio-ai/search': 1, 'portfolio-ai/fetch': 1 },
    })
  } finally {
    db.close()
  }
})

it('refuses private and credential-bearing evidence URLs without a network fetch', async () => {
  page.mockImplementationOnce(fetchPage)
  const response = await call('POST', '/v1/ask/evidence', { url: 'http://127.0.0.1/private' })
  expect(await response.json()).toMatchObject({ error: expect.stringContaining('rejects private') })
  page.mockImplementationOnce(fetchPage)
  const credentials = await call('POST', '/v1/ask/evidence', {
    url: 'https://example.com/?token=private',
  })
  expect(await credentials.json()).toMatchObject({
    error: expect.stringContaining('credential-bearing'),
  })
})
