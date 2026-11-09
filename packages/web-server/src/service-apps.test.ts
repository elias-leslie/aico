import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AskResult, ask } from '@aico/agent'
import { secretsDir, writePrivate } from '@aico/fleet/secrets'
import { NeedsYou, Notifier, NotifyStore, Outbox, parseNotice } from '@aico/notify'
import { StatusStore } from '@aico/status'
import type { TetherClient } from '@aico/tether-client'
import { fetchPage, openCounter, type searchWeb, today } from '@aico/webtools'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createServiceAppsServer,
  SERVICE_APPS,
  type ServiceAppsDeps,
  serviceTokenApp,
} from './service-apps'

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
const run = vi.fn(
  async (..._args: Parameters<typeof ask>): Promise<AskResult> => ({
    outcome: { kind: 'done' as const, model: 'codex/gpt-6.1-sol', text: 'OK' },
    tokens: { input: 1, output: 1 },
    wallMs: 1,
  }),
)
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
const publicFallback = vi.fn(
  async (
    ..._args: Parameters<NonNullable<ServiceAppsDeps['publicSearch']>>
  ): Promise<Record<string, unknown>> => ({
    error: 'Public search fallback unavailable',
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
  server = await listen(apps)
})
/** The listener over this test's stores, and `base` pointing at it. */
async function listen(
  served: NonNullable<ServiceAppsDeps['apps']>,
  freeTier?: ServiceAppsDeps['freeTier'],
  usageFacts?: ServiceAppsDeps['usageFacts'],
) {
  const made = createServiceAppsServer({
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
    apps: served,
    ask: run,
    ...(freeTier && { freeTier }),
    ...(usageFacts && { usageFacts }),
    web: { search, fetch: page },
    publicSearch: publicFallback,
    prompt: (slug) => (slug === 'review-prompt' ? 'Review carefully.' : null),
  })
  await new Promise<void>((done) => made.listen(0, '127.0.0.1', done))
  base = `http://127.0.0.1:${(made.address() as AddressInfo).port}`
  return made
}
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

it('uses subscription Gemini and local fallback for private household vision roles', () => {
  const roles = SERVICE_APPS['portfolio-ai']?.agents
  for (const slug of ['household-receipt-vision', 'household-shelf-tag-vision']) {
    expect(roles?.[slug]).toMatchObject({
      model: 'gemini-3.8-flash',
      fallback_models: [
        { model: 'codex/gpt-6.1-sol', subscription_only: true },
        { model: 'local/qwen3-vl:8b-instruct' },
      ],
    })
    expect(roles?.[slug]?.free_tier).not.toBe(true)
  }
  expect(roles?.['household-price-scout']?.free_tier).toBe(true)
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

it('falls to the free tier only for a role marked for it, and says so', async () => {
  const failing: AskResult = {
    outcome: { kind: 'error', model: 'codex/gpt-6.1-sol', detail: 'signed out' },
    tokens: { input: 0, output: 0 },
    wallMs: 1,
  }
  run.mockResolvedValue(failing)
  const free = vi.fn(async () => ({
    outcome: { kind: 'done' as const, model: 'flash', text: 'From the free tier' },
    tokens: { input: 1, output: 1 },
    wallMs: 2,
    provider: 'gemini-free-tier',
  }))
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  server.closeAllConnections()
  await new Promise((done) => server.close(done))
  const marked = {
    ...apps,
    'portfolio-ai': {
      ...apps['portfolio-ai'],
      agents: {
        review: { model: 'codex/gpt-6.1-sol', prompts: ['review-prompt'], free_tier: true },
        private: { model: 'codex/gpt-6.1-sol', prompts: ['review-prompt'] },
      },
    },
  } as typeof apps
  server = await listen(marked, free)
  const to = (agent_slug: string) => call('POST', '/v1/ask', { agent_slug, question: 'Hello' })
  const fell = await to('review')
  expect(fell.status).toBe(200)
  expect(await fell.json()).toMatchObject({
    provider: 'gemini-free-tier',
    outcome: { kind: 'done' },
  })
  expect(free).toHaveBeenCalledTimes(1)
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('portfolio-ai/review'))
  const stayed = await to('private')
  expect(stayed.status).toBe(502)
  expect(free).toHaveBeenCalledTimes(1)
  // Photos never go to it: the free-tier path sends text only, and a photo may be a private document.
  const photo = await call('POST', '/v1/ask', {
    agent_slug: 'review',
    question: 'Hello',
    images: [{ media_type: 'image/png', data: 'AAAA' }],
  })
  expect(photo.status).not.toBe(200)
  expect(free).toHaveBeenCalledTimes(1)
  // A prompt too big for agy is a reason to fall, like a failure.
  run.mockResolvedValue({
    ...failing,
    outcome: { kind: 'bad_input', detail: 'too big', too_big: true },
  })
  expect((await to('review')).status).toBe(200)
  expect(free).toHaveBeenCalledTimes(2)
  warn.mockRestore()
})

it('uses the local vision fallback on image provider failure while keeping request and accounting', async () => {
  server.closeAllConnections()
  await new Promise((done) => server.close(done))
  server = await listen({
    ...apps,
    'portfolio-ai': {
      ...apps['portfolio-ai'],
      agents: {
        review: {
          model: 'gemini-3.8-flash',
          fallback_models: [{ model: 'local/qwen3-vl:8b-instruct' }],
          prompts: ['review-prompt'],
        },
      },
    },
  })
  const images = [{ data: 'eA==', mimeType: 'image/png' }]
  const schema = { type: 'object' }
  run.mockReset()
  run.mockResolvedValueOnce({
    outcome: { kind: 'error', model: 'gemini-3.8-flash', detail: 'unavailable' },
    tokens: { input: 2, output: 1 },
    wallMs: 3,
  })
  run.mockResolvedValueOnce({
    outcome: { kind: 'done', model: 'local/qwen3-vl:8b-instruct', text: '{}' },
    tokens: { input: 5, output: 4 },
    wallMs: 7,
  })
  const response = await call('POST', '/v1/ask', {
    agent_slug: 'review',
    question: 'Read',
    images,
    schema,
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    provider: 'local',
    outcome: { kind: 'done', model: 'local/qwen3-vl:8b-instruct' },
    tokens: { input: 7, output: 5 },
    wallMs: 10,
  })
  expect(run).toHaveBeenCalledTimes(2)
  expect(run.mock.calls[1]?.[0]).toMatchObject({
    model: 'local/qwen3-vl:8b-instruct',
    images,
    schema,
    question: 'Review carefully.\n\nRead',
  })

  run.mockClear()
  run.mockResolvedValueOnce({
    outcome: { kind: 'bad_input', detail: 'Invalid inline image' },
    tokens: { input: 0, output: 0 },
    wallMs: 1,
  })
  expect(
    (await call('POST', '/v1/ask', { agent_slug: 'review', question: 'Read', images })).status,
  ).toBe(422)
  expect(run).toHaveBeenCalledTimes(1)

  run.mockClear()
  run.mockResolvedValueOnce({
    outcome: {
      kind: 'schema_invalid',
      model: 'gemini-3.8-flash',
      errors: ['wrong shape'],
      text: '{}',
    },
    tokens: { input: 0, output: 0 },
    wallMs: 1,
  })
  run.mockResolvedValueOnce({
    outcome: { kind: 'done', model: 'local/qwen3-vl:8b-instruct', text: '{}' },
    tokens: { input: 0, output: 0 },
    wallMs: 1,
  })
  expect(
    (await call('POST', '/v1/ask', { agent_slug: 'review', question: 'Read', images, schema }))
      .status,
  ).toBe(200)
  expect(run).toHaveBeenCalledTimes(2)

  run.mockClear()
  run.mockResolvedValueOnce({
    outcome: { kind: 'tool_denied', model: 'gemini-3.8-flash', detail: 'image read denied' },
    tokens: { input: 0, output: 0 },
    wallMs: 1,
  })
  expect(
    (await call('POST', '/v1/ask', { agent_slug: 'review', question: 'Read', images, schema }))
      .status,
  ).toBe(502)
  expect(run).toHaveBeenCalledTimes(1)

  run.mockClear()
  run.mockResolvedValueOnce({
    outcome: { kind: 'error', model: 'gemini-3.8-flash', detail: 'unavailable' },
    tokens: { input: 0, output: 0 },
    wallMs: 1,
  })
  run.mockResolvedValueOnce({
    outcome: { kind: 'error', model: 'local/qwen3-vl:8b-instruct', detail: 'connection failed' },
    tokens: { input: 0, output: 0 },
    wallMs: 1,
  })
  const failed = await call('POST', '/v1/ask', { agent_slug: 'review', question: 'Read', images })
  expect(failed.status).toBe(502)
  expect(await failed.json()).toMatchObject({
    provider: 'local',
    outcome: { detail: expect.stringContaining("workstation's GPU") },
  })
  run.mockImplementation(async () => ({
    outcome: { kind: 'done', model: 'codex/gpt-6.1-sol', text: 'OK' },
    tokens: { input: 1, output: 1 },
    wallMs: 1,
  }))
})

it('tries declared fallbacks in order and never routes around refusals or invalid input', async () => {
  server.closeAllConnections()
  await new Promise((done) => server.close(done))
  const free = vi.fn(async () => ({
    outcome: { kind: 'done' as const, model: 'flash', text: 'free' },
    tokens: { input: 1, output: 1 },
    wallMs: 3,
    provider: 'gemini-free-tier',
  }))
  let codexUsedPercent = 10
  let unreadable = false
  const usageFacts: NonNullable<ServiceAppsDeps['usageFacts']> = (now) => ({
    collected_at: now,
    readings: [
      {
        provider: 'codex',
        window_minutes: 10080,
        observed_at: now,
        used_percent: codexUsedPercent,
        resets_at: new Date(Date.parse(now) + 60_000).toISOString(),
        source: 'test',
      },
    ],
    credits: { codex: { balance: 50, pace_per_day_7d: 0, earliest_expiry: null } },
    refusals: [],
    ...(unreadable && { unreadable: { codex: 'collection failed' } }),
  })
  server = await listen(
    {
      ...apps,
      'portfolio-ai': {
        ...apps['portfolio-ai'],
        agents: {
          review: {
            model: 'gemini-3.8-flash',
            fallback_models: [
              { model: 'codex/gpt-6.1-sol', subscription_only: true },
              { model: 'local/qwen3-vl:8b-instruct' },
            ],
            free_tier: true,
            prompts: ['review-prompt'],
          },
        },
      },
    },
    free,
    usageFacts,
  )
  const image = [{ data: 'eA==', mimeType: 'image/png' }]
  const payload = {
    agent_slug: 'review',
    question: 'Read',
    images: image,
    schema: { type: 'object' },
  }
  const failure = (model: string): AskResult => ({
    outcome: { kind: 'error', model, detail: 'unavailable' },
    tokens: { input: 1, output: 1 },
    wallMs: 1,
  })
  const answer = (model: string): AskResult => ({
    outcome: { kind: 'done', model, text: '{}' },
    tokens: { input: 2, output: 2 },
    wallMs: 2,
  })

  run.mockReset()
  run
    .mockResolvedValueOnce(failure('gemini-3.8-flash'))
    .mockResolvedValueOnce(answer('codex/gpt-6.1-sol'))
  const codex = await call('POST', '/v1/ask', payload)
  expect(codex.status).toBe(200)
  expect(await codex.json()).toMatchObject({
    provider: 'codex',
    outcome: { model: 'codex/gpt-6.1-sol' },
    tokens: { input: 3, output: 3 },
    wallMs: 3,
  })
  expect(run.mock.calls.map(([request]) => request.model)).toEqual([
    'gemini-3.8-flash',
    'codex/gpt-6.1-sol',
  ])
  expect(run.mock.calls[1]?.[0]).toMatchObject({ images: image, schema: payload.schema })

  codexUsedPercent = 100
  run.mockClear()
  run
    .mockResolvedValueOnce(failure('gemini-3.8-flash'))
    .mockResolvedValueOnce(answer('local/qwen3-vl:8b-instruct'))
  const credits = await call('POST', '/v1/ask', payload)
  expect(credits.status).toBe(200)
  expect(await credits.json()).toMatchObject({ provider: 'local' })
  expect(run.mock.calls.map(([request]) => request.model)).toEqual([
    'gemini-3.8-flash',
    'local/qwen3-vl:8b-instruct',
  ])

  codexUsedPercent = 10
  unreadable = true
  run.mockClear()
  run
    .mockResolvedValueOnce(failure('gemini-3.8-flash'))
    .mockResolvedValueOnce(answer('local/qwen3-vl:8b-instruct'))
  expect((await call('POST', '/v1/ask', payload)).status).toBe(200)
  expect(run.mock.calls.map(([request]) => request.model)).toEqual([
    'gemini-3.8-flash',
    'local/qwen3-vl:8b-instruct',
  ])
  unreadable = false

  run.mockClear()
  run
    .mockResolvedValueOnce(failure('gemini-3.8-flash'))
    .mockResolvedValueOnce(failure('codex/gpt-6.1-sol'))
    .mockResolvedValueOnce(answer('local/qwen3-vl:8b-instruct'))
  const local = await call('POST', '/v1/ask', payload)
  expect(local.status).toBe(200)
  expect(await local.json()).toMatchObject({
    provider: 'local',
    outcome: { model: 'local/qwen3-vl:8b-instruct' },
    tokens: { input: 4, output: 4 },
    wallMs: 4,
  })
  expect(run.mock.calls.map(([request]) => request.model)).toEqual([
    'gemini-3.8-flash',
    'codex/gpt-6.1-sol',
    'local/qwen3-vl:8b-instruct',
  ])
  expect(free).not.toHaveBeenCalled()

  run.mockClear()
  run
    .mockResolvedValueOnce(failure('gemini-3.8-flash'))
    .mockResolvedValueOnce(failure('codex/gpt-6.1-sol'))
    .mockResolvedValueOnce(failure('local/qwen3-vl:8b-instruct'))
  const publicText = await call('POST', '/v1/ask', {
    agent_slug: 'review',
    question: 'Public page',
  })
  expect(publicText.status).toBe(200)
  expect(await publicText.json()).toMatchObject({
    provider: 'gemini-free-tier',
    tokens: { input: 4, output: 4 },
  })
  expect(free).toHaveBeenCalledTimes(1)
  free.mockClear()

  run.mockClear()
  run
    .mockResolvedValueOnce(failure('gemini-3.8-flash'))
    .mockResolvedValueOnce(failure('codex/gpt-6.1-sol'))
    .mockResolvedValueOnce(failure('local/qwen3-vl:8b-instruct'))
  expect((await call('POST', '/v1/ask', payload)).status).toBe(502)
  expect(free).not.toHaveBeenCalled()

  for (const outcome of [
    { kind: 'bad_input', detail: 'Invalid inline image' },
    {
      kind: 'model_refused',
      model: 'gemini-3.8-flash',
      refusal: { kind: 'refusal', category: 'safety', detail: 'refused' },
    },
    { kind: 'refused', reason: 'model_denied', detail: 'policy denied' },
    { kind: 'model_swap', requested: 'gemini-3.8-flash', served: 'other' },
    { kind: 'tool_denied', model: 'gemini-3.8-flash', detail: 'denied' },
  ] as AskResult['outcome'][]) {
    run.mockClear()
    run.mockResolvedValueOnce({ outcome, tokens: { input: 0, output: 0 }, wallMs: 1 })
    await call('POST', '/v1/ask', payload)
    expect(run).toHaveBeenCalledTimes(1)
    expect(free).not.toHaveBeenCalled()
  }
  run.mockImplementation(async () => answer('codex/gpt-6.1-sol'))
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
    {
      kind: 'check',
      last_run: '2026-11-08T12:00:00Z',
      guard: {
        episode_id: 'x',
        phase: 'hot',
        temperature_c: 85,
        cpu_quota_percent: 50,
        admission_open: false,
        delivery_machine: 'aico',
      },
    },
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
    { maxChars: 50000, backend: 'jina' },
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

it('falls back when a site-scoped search returns only unrelated domains', async () => {
  search.mockResolvedValueOnce({ results: [{ url: 'https://bing.com/irrelevant' }] })
  publicFallback.mockResolvedValueOnce({ results: [{ url: 'https://www.costco.com/item' }] })
  const response = await call('POST', '/v1/ask/evidence', { query: 'site:costco.com olive oil' })
  expect(await response.json()).toMatchObject({ results: [{ url: 'https://www.costco.com/item' }] })
  expect(publicFallback).toHaveBeenCalledWith(
    'site:costco.com olive oil',
    'gemini-3.8-flash',
    5,
    env,
  )
})

it('uses actual model-assisted discovery first for retail offers instead of accepting generic leads', async () => {
  publicFallback.mockResolvedValueOnce({
    provider: 'agy-search-web',
    results: [{ url: 'https://retailer.example/product?variant=blue' }],
    fallback_reason: 'Shared search failed or returned no requested site URLs',
  })
  const response = await call('POST', '/v1/ask/evidence', {
    query: 'Acme X100 blue price',
    intent: 'product_offers',
  })
  expect(await response.json()).toEqual({
    provider: 'agy-search-web',
    results: [{ url: 'https://retailer.example/product?variant=blue' }],
  })
  expect(publicFallback).toHaveBeenCalledWith('Acme X100 blue price', 'gemini-3.8-flash', 5, env)
  expect(search).not.toHaveBeenCalled()
  expect(page).not.toHaveBeenCalled() // Discovery cannot manufacture a verified fetched offer.
})

it('retains ordinary search as the retail fallback when the model search is unavailable', async () => {
  publicFallback.mockResolvedValueOnce({
    error: 'Public search fallback unavailable',
    detail: 'error',
  })
  search.mockResolvedValueOnce({ results: [{ url: 'https://retailer.example/product' }] })
  const response = await call('POST', '/v1/ask/evidence', {
    query: 'Acme X100 price',
    intent: 'product_offers',
  })
  expect(await response.json()).toMatchObject({
    results: [{ url: 'https://retailer.example/product' }],
    fallback_reason: 'Model-assisted retail discovery unavailable',
  })
  expect(publicFallback.mock.invocationCallOrder[0]).toBeLessThan(
    search.mock.invocationCallOrder[0] as number,
  )
})

it('keeps successful generic searches on the ordinary provider and validates retail intent', async () => {
  search.mockResolvedValueOnce({ results: [{ url: 'https://example.com/article' }] })
  await call('POST', '/v1/ask/evidence', { query: 'public article' })
  expect(publicFallback).not.toHaveBeenCalled()
  for (const payload of [
    { query: 'product', intent: 'unknown' },
    { url: 'https://retailer.example/product', intent: 'product_offers' },
  ])
    expect((await call('POST', '/v1/ask/evidence', payload)).status).toBe(422)
  expect(search).toHaveBeenCalledOnce()
  expect(page).not.toHaveBeenCalled()
})

it('reports exhausted retail discovery outages but does not turn a model refusal into a repair', async () => {
  const shopping = { request_id: '55555555-5555-4555-8555-555555555555', kind: 'item' }
  publicFallback.mockResolvedValueOnce({
    error: 'Public search fallback unavailable',
    detail: 'error',
  })
  search.mockResolvedValueOnce({ error: 'Shared search unavailable' })
  await call('POST', '/v1/ask/evidence', {
    query: 'public product',
    intent: 'product_offers',
    shopping,
  })
  expect(status.rows().find(({ row }) => row.id.endsWith(shopping.request_id))?.row).toMatchObject({
    state: 'failed',
    meaning: expect.stringContaining('evidence_search_failed'),
  })
  const refused = { ...shopping, request_id: '66666666-6666-4666-8666-666666666666' }
  publicFallback.mockResolvedValueOnce({
    error: 'Public search fallback unavailable',
    detail: 'model_refused',
  })
  search.mockResolvedValueOnce({ error: 'Shared search unavailable' })
  await call('POST', '/v1/ask/evidence', {
    query: 'public product',
    intent: 'product_offers',
    shopping: refused,
  })
  expect(status.rows().some(({ row }) => row.id.endsWith(refused.request_id))).toBe(false)
})

it('keeps shared results when a site-scoped search has an official result', async () => {
  search.mockResolvedValueOnce({ results: [{ url: 'https://www.costco.com/item' }] })
  await call('POST', '/v1/ask/evidence', { query: 'site:costco.com olive oil' })
  expect(publicFallback).not.toHaveBeenCalled()
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

it('routes migrated Portfolio defaults through models the subscription CLI serves', async () => {
  // Captured provider contract: agy models lists Gemini 3.8 Flash; the old Hub
  // API-only 3.1/3.5 Flash routes fail in that subscription CLI.
  run.mockImplementation(async (request) => ({
    outcome:
      request.model.startsWith('gemini-') && request.model !== 'gemini-3.8-flash'
        ? {
            kind: 'error',
            model: request.model,
            detail: 'Model not served by the subscription CLI',
          }
        : { kind: 'done', model: request.model, text: '{}' },
    tokens: { input: 0, output: 0 },
    wallMs: 0,
  }))
  server.closeAllConnections()
  await new Promise<void>((done) => server.close(() => done()))
  server = createServiceAppsServer({
    status,
    notify: { notifier: { receive } as never, store: notices, rowsWritten: vi.fn() },
    tether: { request: tether } as Pick<TetherClient, 'request'>,
    env,
    apps: SERVICE_APPS,
    ask: run,
    prompt: () => 'Synthetic app instructions.',
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  for (const slug of ['chat', 'equity-analyst', 'household-list-parser'])
    expect(
      (
        await call('POST', '/v1/ask', {
          agent_slug: slug,
          question: 'Synthetic model connection check.',
        })
      ).status,
    ).toBe(200)
})

describe('standby in front of the workstation', () => {
  let primary: Server
  let standby: Server
  let standbyBase: string
  const primaryUp = vi.fn()
  const rowsWritten = vi.fn()

  const startStandby = async (primaryUrl: string) => {
    standby = createServiceAppsServer({
      status,
      notify: { notifier: { receive } as never, store: notices, rowsWritten },
      tether: { request: tether } as Pick<TetherClient, 'request'>,
      env,
      primary: primaryUrl,
      apps,
      ask: run,
      prompt: () => 'Review carefully.',
    })
    await new Promise<void>((done) => standby.listen(0, '127.0.0.1', done))
    standbyBase = `http://127.0.0.1:${(standby.address() as AddressInfo).port}`
  }
  const ask = () =>
    fetch(`${standbyBase}/v1/ask`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ agent_slug: 'review', question: 'Hello' }),
    })

  beforeEach(async () => {
    rowsWritten.mockClear()
    primaryUp.mockReset()
    primaryUp.mockImplementation((req: IncomingMessage, res: ServerResponse) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(req.url === '/v1/asks/0123456789ab' ? 404 : 200, {
          'content-type': 'application/json',
        })
        res.end(JSON.stringify({ from: 'workstation' }))
      })
    })
    primary = createHttpServer((req, res) => primaryUp(req, res))
    await new Promise<void>((done) => primary.listen(0, '127.0.0.1', done))
    await startStandby(`http://127.0.0.1:${(primary.address() as AddressInfo).port}`)
  })
  afterEach(async () => {
    standby.closeAllConnections()
    await new Promise<void>((done) => standby.close(() => done()))
    primary.closeAllConnections()
    await new Promise<void>((done) => primary.close(() => done()))
  })

  it('passes a request to the workstation while it answers, and leaves the model call to it', async () => {
    const res = await ask()
    expect(await res.json()).toEqual({ from: 'workstation' })
    expect(run).not.toHaveBeenCalled()
  })

  it('answers here when the workstation does not, and does not ask it again right away', async () => {
    primary.closeAllConnections()
    await new Promise<void>((done) => primary.close(() => done()))
    const first = await ask()
    expect(first.status).toBe(200)
    expect(run).toHaveBeenCalledTimes(1)
    await ask()
    expect(run).toHaveBeenCalledTimes(2)
    expect(primaryUp).not.toHaveBeenCalled()
    await new Promise<void>((done) => primary.listen(0, '127.0.0.1', done))
  })

  it('refuses a token it does not know without passing it on', async () => {
    const res = await fetch(`${standbyBase}/v1/ask/config`, {
      headers: { authorization: `Bearer ${'x'.repeat(43)}` },
    })
    expect(res.status).toBe(401)
    expect(primaryUp).not.toHaveBeenCalled()
  })

  it('keeps a copy of rows the workstation took, without acting on them here', async () => {
    const row = {
      id: 'portfolio-ai/job',
      what: 'Job',
      kind: 'job',
      machine: apps['portfolio-ai']?.machine,
      project: 'portfolio-ai',
      state: 'ok',
      meaning: 'Fine.',
    }
    const res = await fetch(`${standbyBase}/v1/status/rows`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(row),
    })
    expect(res.status).toBe(200)
    await vi.waitFor(() =>
      expect(status.read({ project: ['portfolio-ai'] }).rows.map((r) => r.id)).toContain(
        'portfolio-ai/job',
      ),
    )
    expect(rowsWritten).not.toHaveBeenCalled()
  })

  it('keeps nothing of a row the workstation refused', async () => {
    primaryUp.mockImplementation((req: IncomingMessage, res: ServerResponse) => {
      req.resume()
      req.on('end', () => res.writeHead(400).end('{}'))
    })
    const res = await fetch(`${standbyBase}/v1/status/rows`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'portfolio-ai/refused',
        what: 'Job',
        kind: 'job',
        machine: apps['portfolio-ai']?.machine,
        project: 'portfolio-ai',
        state: 'ok',
        meaning: 'Fine.',
      }),
    })
    expect(res.status).toBe(400)
    await new Promise((done) => setTimeout(done, 20))
    expect(status.read({ project: ['portfolio-ai'] }).rows.map((r) => r.id)).not.toContain(
      'portfolio-ai/refused',
    )
  })

  it('looks here for an ask the workstation has never heard of', async () => {
    const res = await fetch(`${standbyBase}/v1/asks/0123456789ab`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ requester: 'portfolio-ai' })
  })
})

it('reports only exhausted Shopping provider failures and verifies the same request', async () => {
  const shopping = { request_id: '11111111-1111-4111-8111-111111111111', kind: 'item' }
  const payload = { agent_slug: 'review', question: 'private content', shopping }
  const id = `portfolio-ai/shopping-repair/aico/${shopping.request_id}`
  const failure: AskResult = {
    outcome: { kind: 'error', model: 'codex/gpt-6.1-sol', detail: 'private provider detail' },
    tokens: { input: 0, output: 0 },
    wallMs: 1,
  }
  run.mockReset()
  run.mockResolvedValue(failure)
  expect(
    (await call('POST', '/v1/ask', { ...payload, shopping: { ...shopping, actor: 'private' } }))
      .status,
  ).toBe(422)
  expect(run).not.toHaveBeenCalled()
  expect((await call('POST', '/v1/ask', payload)).status).toBe(502)
  const row = status.rows().find((x) => x.row.id === id)?.row
  expect(row).toMatchObject({
    project: 'portfolio-ai',
    state: 'failed',
    meaning: expect.stringContaining('ask_provider_failed'),
  })
  expect(JSON.stringify(row)).not.toContain('private')
  run.mockResolvedValue({
    outcome: { kind: 'bad_input', detail: 'invalid' },
    tokens: { input: 0, output: 0 },
    wallMs: 1,
  })
  await call('POST', '/v1/ask', payload)
  expect(status.rows().find((x) => x.row.id === id)?.row.state).toBe('failed')
  run.mockResolvedValue({
    outcome: { kind: 'done', model: 'codex/gpt-6.1-sol', text: 'ok' },
    tokens: { input: 0, output: 0 },
    wallMs: 1,
  })
  await call('POST', '/v1/ask', {
    ...payload,
    shopping: { ...shopping, request_id: '22222222-2222-4222-8222-222222222222' },
  })
  expect(status.rows().find((x) => x.row.id === id)?.row.state).toBe('failed')
  await call('POST', '/v1/ask', payload)
  expect(status.rows().find((x) => x.row.id === id)?.row.state).toBe('ok')
})

it('accepts automatic photo routing context before the photo type is known', async () => {
  const shopping = { request_id: '77777777-7777-4777-8777-777777777777', kind: 'auto' }
  run.mockResolvedValueOnce({
    outcome: { kind: 'done', model: 'gemini-3.8-flash', text: '{"kind":"list"}' },
    tokens: { input: 0, output: 0 },
    wallMs: 1,
  })
  expect(
    (
      await call('POST', '/v1/ask', {
        agent_slug: 'review',
        question: 'Classify this photo.',
        shopping,
      })
    ).status,
  ).toBe(200)
  expect(run).toHaveBeenCalledOnce()
})

it('reports evidence outages only after fallback failure, not empty results or a policy rejection', async () => {
  const shopping = { request_id: '33333333-3333-4333-8333-333333333333', kind: 'item' }
  const id = `portfolio-ai/shopping-repair/aico/${shopping.request_id}`
  search.mockReset()
  publicFallback.mockReset()
  search.mockResolvedValueOnce({ error: 'shared unavailable' })
  publicFallback.mockResolvedValueOnce({ results: [{ url: 'https://example.com/item' }] })
  await call('POST', '/v1/ask/evidence', { query: 'private query', shopping })
  expect(status.rows().find((x) => x.row.id === id)).toBeUndefined()
  search.mockResolvedValueOnce({ results: [] })
  publicFallback.mockResolvedValueOnce({ error: 'Public search fallback found no matching URLs' })
  await call('POST', '/v1/ask/evidence', { query: 'unknown product', shopping })
  expect(status.rows().find((x) => x.row.id === id)).toBeUndefined()
  search.mockResolvedValueOnce({ error: 'shared unavailable' })
  publicFallback.mockResolvedValueOnce({
    error: 'Public search fallback unavailable',
    detail: 'model_refused',
  })
  await call('POST', '/v1/ask/evidence', { query: 'private query', shopping })
  expect(status.rows().find((x) => x.row.id === id)).toBeUndefined()
  search.mockResolvedValueOnce({ error: 'shared unavailable' })
  publicFallback.mockResolvedValueOnce({ error: 'Public search fallback unavailable' })
  await call('POST', '/v1/ask/evidence', { query: 'private query', shopping })
  expect(status.rows().find((x) => x.row.id === id)?.row.state).toBe('failed')
  run.mockReset()
  run.mockResolvedValue({
    outcome: { kind: 'done', model: 'codex/gpt-6.1-sol', text: 'ok' },
    tokens: { input: 0, output: 0 },
    wallMs: 1,
  })
  await call('POST', '/v1/ask', { agent_slug: 'review', question: 'private', shopping })
  expect(status.rows().find((x) => x.row.id === id)?.row.state).toBe('failed')
  search.mockResolvedValueOnce({ results: [{ url: 'https://example.com/item' }] })
  await call('POST', '/v1/ask/evidence', { query: 'private query', shopping })
  expect(status.rows().find((x) => x.row.id === id)?.row.state).toBe('ok')
})

it('waits for Shopping model fallbacks before reporting and keeps independent faults', async () => {
  server.closeAllConnections()
  await new Promise<void>((done) => server.close(() => done()))
  server = await listen({
    ...apps,
    'portfolio-ai': {
      ...apps['portfolio-ai'],
      agents: {
        review: {
          model: 'codex/gpt-6.1-sol',
          prompts: ['review-prompt'],
          fallback_models: [{ model: 'local/qwen3-vl:8b-instruct' }],
        },
      },
    },
  })
  const shopping = { request_id: '44444444-4444-4444-8444-444444444444', kind: 'receipt' }
  const payload = { agent_slug: 'review', question: 'private', shopping }
  const id = `portfolio-ai/shopping-repair/aico/${shopping.request_id}`
  const failing: AskResult = {
    outcome: { kind: 'error', model: 'codex/gpt-6.1-sol', detail: 'unavailable' },
    tokens: { input: 0, output: 0 },
    wallMs: 1,
  }
  const success: AskResult = {
    outcome: { kind: 'done', model: 'local/qwen3-vl:8b-instruct', text: 'ok' },
    tokens: { input: 1, output: 1 },
    wallMs: 1,
  }
  run.mockReset()
  run.mockResolvedValueOnce(failing).mockResolvedValueOnce(success)
  expect((await call('POST', '/v1/ask', payload)).status).toBe(200)
  expect(status.rows().find((x) => x.row.id === id)).toBeUndefined()
  run.mockResolvedValueOnce(failing).mockResolvedValueOnce(failing)
  expect((await call('POST', '/v1/ask', payload)).status).toBe(502)
  page.mockResolvedValueOnce({ error: 'fetch_web_page jina request failed' })
  await call('POST', '/v1/ask/evidence', { url: 'https://example.com/item', shopping })
  expect(status.rows().find((x) => x.row.id === id)?.row.meaning).toContain(
    'ask_provider_failed,evidence_fetch_failed',
  )
  run.mockResolvedValueOnce(success)
  await call('POST', '/v1/ask', payload)
  expect(status.rows().find((x) => x.row.id === id)?.row).toMatchObject({
    state: 'failed',
    meaning: expect.stringContaining('evidence_fetch_failed'),
  })
  page.mockResolvedValueOnce({ status_code: 200, content: 'ok' })
  await call('POST', '/v1/ask/evidence', { url: 'https://example.com/item', shopping })
  expect(status.rows().find((x) => x.row.id === id)?.row.state).toBe('ok')
})
