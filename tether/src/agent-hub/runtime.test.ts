import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentStateTracker } from '../agent-state'
import {
  agentHubQueueLength,
  allocateWidgetId,
  getAgentHubSession,
  getWidget,
  reserveRootRequest,
  type WidgetRow,
} from '../lifecycle/catalog'
import { sessionGeneration } from '../lifecycle/owner-retirement'
import { initStore, registerBuiltinTuis } from '../lifecycle/testing'
import type { Store } from '../store'
import { createHubApi } from './client'
import { FakeHub } from './fake-hub'
import { AgentHubRuntime, HubError } from './runtime'

let dir: string
let hub: FakeHub
let store: Store
let runtime: AgentHubRuntime
let states: AgentStateTracker
let notified: string[]

function build(): AgentHubRuntime {
  return new AgentHubRuntime({
    api: () =>
      createHubApi({
        baseUrl,
        clientId: 'client-1',
        requestSource: 'aico-tether',
        ownerTokenFile: join(dir, 'owner-token'),
      }),
    states,
    notify: (id) => notified.push(id),
    verifyStatus: async (row) => runtime.verify(row),
    pollMs: 60_000,
    log: () => {},
  })
}

let baseUrl = ''

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tether-agent-hub-'))
  writeFileSync(join(dir, 'owner-token'), 'token-value\n')
  hub = new FakeHub()
  baseUrl = await hub.listen()
  registerBuiltinTuis()
  store = initStore(join(dir, 'catalog.db'))
  states = new AgentStateTracker()
  notified = []
  runtime = build()
})

afterEach(async () => {
  runtime.stop()
  await hub.close()
  rmSync(dir, { recursive: true, force: true })
})

function root(requestId = 'r1', model: string | null = null): WidgetRow {
  const widgetId = allocateWidgetId()
  reserveRootRequest(
    {
      requestId,
      digest: 'd',
      widgetId,
      logicalSessionId: `aico-root-${requestId}`,
      role: 'lead',
      workRole: 'implementation',
      workRoleDisplayName: null,
      leadRootReference: null,
      facetCapsuleRef: null,
      createdAt: Date.now(),
      origin: 'aico',
    },
    'agent-hub',
    'sample-app',
    dir,
    null,
    { hubSessionId: randomUUID(), agentSlug: 'chat', model },
  )
  return getWidget(widgetId) as WidgetRow
}

const hubId = (row: WidgetRow) => (getAgentHubSession(row.id)?.hubSessionId ?? '') as string
const stateOf = (row: WidgetRow) => runtime.stateOf(row.id)?.state

describe('AgentHubRuntime', () => {
  it('creates the Agent Hub session under its stored id and posts the first prompt once', async () => {
    const row = root()
    expect(row.backend).toBe('agent-hub')
    expect(await runtime.verify(row)).toBe('pending')
    await runtime.ensure(row.id, 'Say hello.')
    const session = hub.sessions.get(hubId(row))
    expect(session).toMatchObject({
      project_id: 'sample-app',
      provider: 'fake',
      model: 'cheap-model',
      agent_slug: 'chat',
      external_id: row.sessionId,
      cwd: dir,
      work_role: { id: 'implementation', source: 'aico-tether:r1' },
      messages: ['Say hello.'],
      turnRunning: true,
    })
    // Who is calling, and the owner token read from its file.
    const call = hub.requests.find((r) => r.method === 'POST' && r.path === '/api/complete')
    expect(call?.headers['x-client-id']).toBe('client-1')
    expect(call?.headers['x-request-source']).toBe('aico-tether')
    expect(call?.headers['x-agent-hub-owner-token']).toBe('token-value')
    expect(call?.body).toMatchObject({
      agent_slug: 'chat',
      session_id: hubId(row),
      working_dir: dir,
      execute_tools: true,
    })
    expect(getAgentHubSession(row.id)).toMatchObject({ created: true, promptSent: true })
    expect(await runtime.verify(row)).toBe('running')
    expect(stateOf(row)).toBe('working')
    // A repeat of the same create posts nothing more.
    await runtime.ensure(row.id, 'Say hello.')
    expect(hub.count('POST', /^\/api\/complete$/)).toBe(1)
    expect(hub.count('POST', /^\/api\/sessions$/)).toBe(1)
  })

  it('sends the requested model with each turn', async () => {
    hub.models.push({ id: 'other-model', provider: 'fake', routable: true })
    const row = root('r1', 'other-model')
    await runtime.ensure(row.id, 'Hi.')
    expect(hub.sessions.get(hubId(row))?.model).toBe('other-model')
    expect(hub.requests.find((r) => r.path === '/api/complete')?.body).toMatchObject({
      model: 'other-model',
    })
  })

  it('does not post the first prompt twice after a crash before it was recorded', async () => {
    const row = root()
    await runtime.ensure(row.id, 'Once.')
    store.db.exec('UPDATE agent_hub_sessions SET prompt_sent = 0')
    await runtime.ensure(row.id, 'Once.')
    expect(hub.count('POST', /^\/api\/complete$/)).toBe(1)
    expect(getAgentHubSession(row.id)?.promptSent).toBe(true)
  })

  it('keeps the root pending, with nothing posted, while Agent Hub is down', async () => {
    const row = root()
    hub.down = 503
    await runtime.ensure(row.id, 'Later.')
    expect(getAgentHubSession(row.id)).toMatchObject({ created: false, promptSent: false })
    expect(await runtime.verify(row)).toBe('pending')
    hub.down = null
    await runtime.ensure(row.id, 'Later.')
    expect(await runtime.verify(row)).toBe('running')
    expect(hub.sessions.get(hubId(row))?.messages).toEqual(['Later.'])
  })

  it('maps the turn state to working, idle and unknown', async () => {
    const row = root()
    await runtime.ensure(row.id, 'Go.')
    expect(stateOf(row)).toBe('working')
    expect(runtime.describe(row.id)).toMatchObject({ turnState: 'running', agentSlug: 'chat' })
    hub.finishTurn(hubId(row))
    await runtime.tick()
    expect(stateOf(row)).toBe('idle')
    expect(runtime.stateOf(row.id)).toMatchObject({ statePrevious: 'working' })
    hub.down = 503
    await runtime.tick()
    expect(stateOf(row)).toBe('unknown')
    expect(await runtime.verify({ ...row })).toBe('uncertain')
    hub.down = null
    await runtime.tick()
    expect(stateOf(row)).toBe('idle')
    expect(await runtime.verify(row)).toBe('running')
    // Closed in Agent Hub itself: nothing to talk to.
    const session = hub.sessions.get(hubId(row))
    if (session) session.status = 'completed'
    await runtime.tick()
    expect(stateOf(row)).toBe('unknown')
    expect(await runtime.verify(row)).toBe('uncertain')
  })

  it('posts a follow-up when idle and queues it while a turn runs', async () => {
    const row = root()
    await runtime.ensure(row.id, 'First.')
    const session = hub.sessions.get(hubId(row))
    expect(await runtime.send(row.id, 'Second.')).toEqual({ queued: true })
    expect(await runtime.send(row.id, 'Third.')).toEqual({ queued: true })
    expect(agentHubQueueLength(row.id)).toBe(2)
    expect(session?.messages).toEqual(['First.'])
    // Idle: one queued follow-up goes out per idle moment, oldest first.
    hub.finishTurn(hubId(row))
    await runtime.tick()
    expect(session?.messages).toEqual(['First.', 'Second.'])
    expect(agentHubQueueLength(row.id)).toBe(1)
    expect(stateOf(row)).toBe('working')
    await runtime.tick()
    expect(session?.messages).toEqual(['First.', 'Second.'])
    hub.finishTurn(hubId(row))
    await runtime.tick()
    expect(session?.messages).toEqual(['First.', 'Second.', 'Third.'])
    expect(agentHubQueueLength(row.id)).toBe(0)
    // Idle again: a follow-up goes straight out.
    hub.finishTurn(hubId(row))
    expect(await runtime.send(row.id, 'Fourth.')).toEqual({ queued: false })
    expect(session?.messages.at(-1)).toBe('Fourth.')
  })

  it('refuses a follow-up before the first prompt, or while Agent Hub is down', async () => {
    const row = root()
    await expect(runtime.send(row.id, 'Too early.')).rejects.toMatchObject({
      code: 'not_started',
    })
    await runtime.ensure(row.id, 'First.')
    hub.down = 503
    await expect(runtime.send(row.id, 'Nope.')).rejects.toMatchObject({
      code: 'agent_hub_unavailable',
    })
    expect(agentHubQueueLength(row.id)).toBe(0)
  })

  it('ends a session by cancelling its turn, closing it in Agent Hub and dropping the row', async () => {
    const row = root()
    await runtime.ensure(row.id, 'Work.')
    await runtime.send(row.id, 'Queued.')
    const generation = sessionGeneration(row)
    // A stale fence changes nothing.
    expect(await runtime.end(row.id, 'f'.repeat(64))).toEqual({ status: 'stale' })
    expect(hub.sessions.get(hubId(row))?.status).toBe('active')
    expect(await runtime.end(row.id, generation)).toEqual({ status: 'ended' })
    expect(hub.count('POST', /^\/api\/complete\/cancel$/)).toBe(1)
    expect([...hub.sessions.values()][0]).toMatchObject({ status: 'completed', turnRunning: false })
    expect(getWidget(row.id)).toBeUndefined()
    expect(getAgentHubSession(row.id)).toBeUndefined()
    expect(agentHubQueueLength(row.id)).toBe(0)
    expect(runtime.stateOf(row.id)).toBeNull()
    expect(await runtime.end(row.id, generation)).toEqual({ status: 'absent' })
  })

  it('keeps the row when Agent Hub cannot close the session, and ends when it is already gone', async () => {
    const row = root()
    await runtime.ensure(row.id, 'Work.')
    hub.down = 503
    expect(await runtime.end(row.id, undefined)).toMatchObject({ status: 'blocked' })
    expect(getWidget(row.id)).toBeDefined()
    hub.down = null
    hub.sessions.clear()
    expect(await runtime.end(row.id, undefined)).toEqual({ status: 'ended' })
    expect(getWidget(row.id)).toBeUndefined()
  })

  it('finds its sessions again after a restart, by the stored id', async () => {
    const row = root()
    await runtime.ensure(row.id, 'Work.')
    await runtime.send(row.id, 'Queued.')
    runtime.stop()
    states = new AgentStateTracker()
    runtime = build()
    expect(runtime.stateOf(row.id)).toBeNull()
    await runtime.tick()
    expect(stateOf(row)).toBe('working')
    hub.finishTurn(hubId(row))
    await runtime.tick()
    // The follow-up queued before the restart still goes out.
    expect(hub.sessions.get(hubId(row))?.messages).toEqual(['Work.', 'Queued.'])
  })

  it('refuses an unknown agent or model, and reports Agent Hub down', async () => {
    await expect(runtime.check('missing', null)).rejects.toMatchObject({ code: 'unknown_agent' })
    await expect(runtime.check('chat', 'nope')).rejects.toMatchObject({ code: 'unknown_model' })
    hub.models[0].routable = false
    await expect(runtime.check('chat', null)).rejects.toMatchObject({ code: 'unknown_model' })
    hub.models[0].routable = true
    await expect(runtime.check('chat', null)).resolves.toBeUndefined()
    hub.down = 500
    await expect(runtime.check('chat', null)).rejects.toBeInstanceOf(HubError)
    await expect(runtime.check('chat', null)).rejects.toMatchObject({
      code: 'agent_hub_unavailable',
    })
  })
})
