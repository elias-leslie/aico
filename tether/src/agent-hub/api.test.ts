// The agent-hub session kind through the control socket, against a fake Agent
// Hub: create, lineage, state, follow-ups, tmux-only routes, End.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callSocket } from '../client'
import { resolvePaths, type TetherPaths } from '../config'
import { type RunningDaemon, startDaemon } from '../daemon'
import { getWidget, insertWidget, listWidgets } from '../lifecycle/catalog'
import { FakeHub } from './fake-hub'

let dir: string
let paths: TetherPaths
let daemon: RunningDaemon
let hub: FakeHub
let projectRoot: string

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tether-hub-api-'))
  projectRoot = join(dir, 'proj')
  mkdirSync(projectRoot)
  writeFileSync(join(dir, 'owner-token'), 'token-value\n')
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
  await daemon.close()
  await hub.close()
  rmSync(dir, { recursive: true, force: true })
})

const call = (method: string, path: string, body?: unknown) =>
  callSocket(paths.socket, method, path, body)

const create = (extra: Record<string, unknown> = {}) =>
  call('POST', '/v1/roots', {
    requestId: 'hub-1',
    tool: 'agent-hub',
    agentSlug: 'chat',
    projectId: 'sample-app',
    projectRoot,
    initialPrompt: 'Say hello.',
    role: 'lead',
    workRole: 'implementation',
    ...extra,
  })

// biome-ignore lint/suspicious/noExplicitAny: loosely typed JSON bodies in assertions
type Body = Record<string, any>

describe('agent-hub sessions over the control socket', () => {
  it('creates a root that holds an Agent Hub session, not a pane', async () => {
    const created = await create()
    expect(created.status).toBe(200)
    const root = created.body as Body
    expect(root.tool).toBe('agent-hub')
    const id = root.hostIdentity as string
    const session = (await call('GET', `/v1/sessions/${id}`)).body as Body
    expect(session).toMatchObject({
      id,
      tool: 'agent-hub',
      backend: 'agent-hub',
      status: 'running',
      projectId: 'sample-app',
      state: 'working',
      stateSource: 'agent-hub',
      agentHub: { agentSlug: 'chat', turnState: 'running' },
    })
    expect(session.tmux).toMatchObject({ socket: null })
    expect(JSON.stringify(session)).not.toContain('token-value')
    const [hubSession] = [...hub.sessions.values()]
    expect(hubSession).toMatchObject({
      agent_slug: 'chat',
      external_id: session.ownershipId,
      messages: ['Say hello.'],
    })
    // The same request again posts nothing more.
    expect((await create()).status).toBe(200)
    expect(hub.count('POST', /^\/api\/complete$/)).toBe(1)
    // tmux loops never see a hub row; the session list does.
    expect(listWidgets().map((w) => w.id)).not.toContain(id)
    const listed = (await call('GET', '/v1/sessions')).body as { items: Body[] }
    expect(listed.items.map((s) => s.id)).toContain(id)
  })

  it('refuses an unknown agent, an unknown model and a hub root without a slug', async () => {
    expect(await create({ requestId: 'x1', agentSlug: 'missing' })).toMatchObject({
      status: 422,
      body: { error: 'unknown_agent' },
    })
    expect(await create({ requestId: 'x2', model: 'nope' })).toMatchObject({
      status: 422,
      body: { error: 'unknown_model' },
    })
    expect((await create({ requestId: 'x3', agentSlug: undefined })).status).toBe(400)
    expect((await create({ requestId: 'x4', tool: 'codex' })).status).toBe(400)
    hub.down = 503
    expect(await create({ requestId: 'x5' })).toMatchObject({
      status: 503,
      body: { error: 'agent_hub_unavailable' },
    })
    expect(hub.sessions.size).toBe(0)
  })

  it('makes the launching session the coordinator, never the child', async () => {
    insertWidget('aabbcc01', 'claude-code', 1_000, { origin: 'cli' })
    const created = await create({ launchedBy: 'aabbcc01' })
    expect(created.status).toBe(200)
    const id = (created.body as Body).hostIdentity as string
    expect(getWidget('aabbcc01')?.coordinator).toBe(true)
    expect(getWidget(id)?.coordinatorId).toBe('aabbcc01')
    expect(getWidget(id)?.coordinator).toBe(false)
  })

  it('queues a follow-up while a turn runs and delivers it once idle', async () => {
    const id = ((await create()).body as Body).hostIdentity as string
    const generation = ((await call('GET', `/v1/sessions/${id}`)).body as Body).generation
    const send = (text: string) =>
      call('POST', `/v1/sessions/${id}/inject`, {
        generation,
        text,
        mode: 'paste',
        submit: true,
      })
    expect((await send('Second.')).body).toMatchObject({ delivered: true, queued: true })
    const [hubSession] = [...hub.sessions.values()]
    expect(hubSession.messages).toEqual(['Say hello.'])
    hub.finishTurn(hubSession.id)
    await daemon.agentHub.tick()
    expect(hubSession.messages).toEqual(['Say hello.', 'Second.'])
    expect(((await call('GET', `/v1/sessions/${id}`)).body as Body).state).toBe('working')
    hub.finishTurn(hubSession.id)
    await daemon.agentHub.tick()
    expect(((await call('GET', `/v1/sessions/${id}`)).body as Body).state).toBe('idle')
    expect((await send('Third.')).body).toMatchObject({ delivered: true, queued: false })
    expect(hubSession.messages.at(-1)).toBe('Third.')
    // A stale generation changes nothing.
    expect(
      (
        await call('POST', `/v1/sessions/${id}/inject`, {
          generation: 'f'.repeat(64),
          text: 'x',
          mode: 'paste',
          submit: true,
        })
      ).status,
    ).toBe(409)
    // Only a pasted, submitted message makes sense for a chat session.
    expect(
      (
        await call('POST', `/v1/sessions/${id}/inject`, {
          generation,
          text: 'x',
          mode: 'paste',
          submit: false,
        })
      ).status,
    ).toBe(400)
  })

  it('takes a model with a follow-up, and refuses a bad or unroutable one', async () => {
    hub.models.push({ id: 'other-model', provider: 'fake', routable: true })
    const id = ((await create()).body as Body).hostIdentity as string
    const generation = ((await call('GET', `/v1/sessions/${id}`)).body as Body).generation
    const send = (extra: Record<string, unknown>) =>
      call('POST', `/v1/sessions/${id}/inject`, {
        generation,
        text: 'Next.',
        mode: 'paste',
        submit: true,
        ...extra,
      })
    const [hubSession] = [...hub.sessions.values()]
    hub.finishTurn(hubSession.id)
    expect((await send({ model: 'other-model' })).body).toMatchObject({ queued: false })
    const last = hub.requests.filter((r) => r.path === '/api/complete').at(-1)
    expect(last?.body).toMatchObject({ model: 'other-model' })
    expect(((await call('GET', `/v1/sessions/${id}`)).body as Body).agentHub).toMatchObject({
      requestedModel: 'other-model',
    })
    expect((await send({ model: 'nope' })).body).toMatchObject({ error: 'unknown_model' })
    expect((await send({ model: 5 })).status).toBe(400)
    expect((await send({ model: '' })).status).toBe(400)
  })

  it('takes a thinking level with a follow-up and refuses a malformed one', async () => {
    const id = ((await create()).body as Body).hostIdentity as string
    const generation = ((await call('GET', `/v1/sessions/${id}`)).body as Body).generation
    const send = (extra: Record<string, unknown>) =>
      call('POST', `/v1/sessions/${id}/inject`, {
        generation,
        text: 'Next.',
        mode: 'paste',
        submit: true,
        ...extra,
      })
    const [hubSession] = [...hub.sessions.values()]
    hub.finishTurn(hubSession.id)
    expect((await send({ thinkingLevel: 'high' })).body).toMatchObject({ queued: false })
    const last = hub.requests.filter((r) => r.path === '/api/complete').at(-1)
    expect(last?.body).toMatchObject({ thinking_level: 'high' })
    expect((await send({ thinkingLevel: 5 })).status).toBe(400)
    expect((await send({ thinkingLevel: '' })).status).toBe(400)
    expect((await send({ thinkingLevel: 'High; drop' })).status).toBe(400)
  })

  it('refuses the pane-only routes and keeps naming and wakes working', async () => {
    const id = ((await create()).body as Body).hostIdentity as string
    const generation = ((await call('GET', `/v1/sessions/${id}`)).body as Body).generation
    for (const route of ['attach', 'capture', 'scrollback', 'pane-mode'])
      expect((await call('GET', `/v1/sessions/${id}/${route}`)).body, route).toMatchObject({
        error: 'workload_unavailable',
      })
    // Its view is a chat window the desktop opens; with no desktop connected
    // there is nothing to show.
    expect((await call('POST', `/v1/sessions/${id}/show`, { generation })).body).toMatchObject({
      error: 'gui_unavailable',
    })
    const extra: Record<string, Record<string, unknown>> = {
      respawn: {},
      'load-tui': { tool: 'codex' },
      'switch-project': { projectId: 'sample-app' },
    }
    for (const route of ['respawn', 'load-tui', 'switch-project'])
      expect(
        (await call('POST', `/v1/sessions/${id}/${route}`, { generation, ...extra[route] })).body,
        route,
      ).toMatchObject({ error: 'unsupported_backend' })
    const renamed = await call('PATCH', `/v1/sessions/${id}`, { generation, name: 'helper' })
    expect(renamed.status).toBe(200)
    expect(getWidget(id)?.name).toBe('helper')
    const wake = await call('POST', `/v1/sessions/${id}/wakes`, {
      dueAt: Date.now() + 3600_000,
      note: 'check the helper',
    })
    expect(wake.status).toBe(201)
  })

  it('asks the desktop to open the chat window, on create and on show', async () => {
    const commands: Array<Record<string, unknown>> = []
    const channel = request({
      socketPath: paths.socket,
      path: '/v1/gui/channel',
      headers: { 'x-tether-client': 'aico-gui' },
    })
    await new Promise<void>((resolve) => {
      channel.on('response', (res) => {
        let tail = ''
        res.on('data', (chunk) => {
          tail += chunk.toString()
          const lines = tail.split('\n')
          tail = lines.pop() ?? ''
          for (const line of lines) {
            const value = JSON.parse(line)
            if (value.type === 'hello') resolve()
            if (value.type === 'command') {
              commands.push(value)
              void call('POST', `/v1/gui/results/${value.commandId}`, { applied: true })
            }
          }
        })
      })
      channel.end()
    })
    try {
      const id = ((await create()).body as Body).hostIdentity as string
      await vi.waitFor(() => expect(commands).toHaveLength(1))
      expect(commands[0]).toMatchObject({ kind: 'show', sessionId: id })
      const generation = ((await call('GET', `/v1/sessions/${id}`)).body as Body).generation
      expect((await call('POST', `/v1/sessions/${id}/show`, { generation })).body).toEqual({
        shown: true,
      })
      expect(commands).toHaveLength(2)
    } finally {
      channel.destroy()
    }
  })

  it('ends by cancelling the turn, closing the Agent Hub session and dropping the row', async () => {
    const id = ((await create()).body as Body).hostIdentity as string
    const generation = ((await call('GET', `/v1/sessions/${id}`)).body as Body).generation
    const ended = await call('POST', `/v1/sessions/${id}/end`, { generation })
    expect(ended.status).toBe(200)
    expect(ended.body).toMatchObject({ status: 'ended' })
    expect(hub.count('POST', /^\/api\/complete\/cancel$/)).toBe(1)
    expect([...hub.sessions.values()][0]).toMatchObject({ status: 'completed', turnRunning: false })
    expect(getWidget(id)).toBeUndefined()
    expect((await call('GET', `/v1/sessions/${id}`)).status).toBe(404)
  })
})
