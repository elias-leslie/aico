import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApi } from './api'
import { WebStore } from './db'
import { createWebServer } from './server'
import { Shows } from './shows'
import { TerminalHub } from './terminal'
import { FakeTether } from './testing'

let tether: FakeTether
let store: WebStore
let server: Server
let base: string

const guard = {
  allowedHostnames: ['localhost', '127.0.0.1'],
  allowedOrigins: ['http://127.0.0.1:3002'],
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    headers: response.headers,
  }
}

beforeEach(async () => {
  tether = new FakeTether()
  store = new WebStore(':memory:')
  const api = buildApi({
    tether: tether.client,
    store,
    config: { agentHubUrl: null, agentHubClientId: null },
    uploads: { dir: '/nonexistent/uploads', maxBytes: 1024, maxAgeMs: 1000 },
    shows: new Shows({
      exchangeRoot: '/nonexistent/exchange',
      publicHost: null,
      run: async () => {},
    }),
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

describe('guard and headers', () => {
  it('sets the security headers and refuses a foreign host or Origin', async () => {
    const ok = await call('GET', '/api/auth/session')
    expect(ok.status).toBe(200)
    expect(ok.body).toEqual({
      enabled: false,
      mode: 'none',
      authenticated: true,
      identity: 'local',
    })
    expect(ok.headers.get('x-frame-options')).toBe('DENY')
    expect(ok.headers.get('content-security-policy')).toContain("default-src 'none'")

    const foreign = await call('POST', '/api/reset-all', undefined, {
      Origin: 'https://evil.example',
    })
    expect(foreign).toMatchObject({ status: 403, body: { error: 'origin_not_allowed' } })
    expect(tether.calls).toEqual([])
  })

  it('answers unknown paths 404 and wrong methods 405', async () => {
    expect((await call('GET', '/api/nope')).status).toBe(404)
    expect((await call('DELETE', '/api/projects')).status).toBe(405)
    expect((await call('POST', '/api/auth/login', {})).status).toBe(404)
  })
})

describe('sessions', () => {
  it('lists every Tether session, linked ones with their tab', async () => {
    const pane = store.createPane({ projectId: null, name: 'Shell', activeMode: 'shell' })
    const linked = tether.add({ tool: 'shell' })
    store.link(linked.id, pane.id, 'shell')
    const other = tether.add({ tool: 'claude', origin: 'aico', statePrevious: 'working' } as never)
    const { body } = await call('GET', '/api/sessions?include_detached=true')
    expect(body.total).toBe(2)
    const byId = Object.fromEntries(body.items.map((s: { id: string }) => [s.id, s]))
    expect(byId[linked.id]).toMatchObject({ pane_id: pane.id, is_external: false, mode: 'shell' })
    expect(byId[other.id]).toMatchObject({
      pane_id: null,
      is_external: true,
      agent_state: 'running',
      activity_previous: 'working',
      source: 'tether',
    })
  })

  it('renames through Tether with the session generation, and reorders the link', async () => {
    const pane = store.createPane({ projectId: null, name: 'Shell', activeMode: 'shell' })
    const session = tether.add()
    store.link(session.id, pane.id, 'shell')
    const { status, body } = await call('PATCH', `/api/sessions/${session.id}`, {
      name: '  Build  ',
      display_order: 4,
    })
    expect(status).toBe(200)
    expect(tether.callsOf('rename')).toEqual([[session.id, 'g1', 'Build']])
    expect(body).toMatchObject({ task: 'Build', display_order: 4 })
  })

  it('404s a session Tether no longer has', async () => {
    const { status, body } = await call('GET', '/api/sessions/gone1234')
    expect(status).toBe(404)
    expect(body.detail).toBe('Session gone1234 not found')
  })

  it('closing an agent ends its shell companion and the tab', async () => {
    const pane = store.createPane({ projectId: 'aico', name: 'Aico', activeMode: 'claude' })
    const shell = tether.add({ tool: 'shell' })
    const agent = tether.add({ tool: 'claude' })
    store.link(shell.id, pane.id, 'shell')
    store.link(agent.id, pane.id, 'claude')
    const { body } = await call('DELETE', `/api/sessions/${agent.id}`)
    expect(body).toEqual({
      deleted: true,
      id: agent.id,
      next_session_id: null,
      pane_id: pane.id,
      pane_deleted: true,
      is_external: false,
    })
    expect(tether.sessions.size).toBe(0)
    expect(store.getPane(pane.id)).toBeNull()
  })

  it('closing a shell switches the tab to its agent', async () => {
    const pane = store.createPane({ projectId: 'aico', name: 'Aico', activeMode: 'shell' })
    const shell = tether.add({ tool: 'shell' })
    const agent = tether.add({ tool: 'claude' })
    store.link(shell.id, pane.id, 'shell')
    store.link(agent.id, pane.id, 'claude')
    const { body } = await call('DELETE', `/api/sessions/${shell.id}`)
    expect(body).toMatchObject({ next_session_id: agent.id, pane_deleted: false })
    expect(store.getPane(pane.id)?.active_mode).toBe('claude')
  })

  it('closing a session another app started only ends it', async () => {
    const session = tether.add()
    expect((await call('DELETE', `/api/sessions/${session.id}`)).body).toMatchObject({
      is_external: true,
    })
    // Already gone: still reported as deleted.
    expect((await call('DELETE', `/api/sessions/${session.id}`)).status).toBe(200)
  })

  it('resets by respawn, refusing a root', async () => {
    const session = tether.add({ tool: 'claude' })
    const root = tether.add({ tool: 'claude', rootRequestId: 'r1' })
    expect((await call('POST', `/api/sessions/${session.id}/reset`)).body.generation).toBe('g1+')
    expect((await call('POST', `/api/sessions/${root.id}/reset`)).status).toBe(409)
  })

  it('reset-all respawns linked sessions and skips refusals', async () => {
    const pane = store.createPane({ projectId: null, name: 'x', activeMode: 'shell' })
    const one = tether.add()
    const root = tether.add({ rootRequestId: 'r1' })
    store.link(one.id, pane.id, 'shell')
    store.link(root.id, pane.id, 'shell')
    store.link('vanished', pane.id, 'shell')
    expect((await call('POST', '/api/reset-all')).body).toEqual({ reset_count: 1 })
  })

  it('reports agent state and starts a stopped agent', async () => {
    const stopped = tether.add({ tool: 'claude', status: 'stopped' as never })
    const shell = tether.add({ tool: 'shell' })
    const root = tether.add({ tool: 'claude', rootRequestId: 'r' })
    expect((await call('GET', `/api/sessions/${stopped.id}/agent-state`)).body).toEqual({
      session_id: stopped.id,
      agent_state: 'not_started',
      claude_state: 'not_started',
    })
    expect((await call('POST', `/api/sessions/${stopped.id}/start-agent`)).body).toMatchObject({
      started: true,
      message: 'Agent restarted',
      agent_state: 'running',
    })
    expect((await call('POST', `/api/sessions/${stopped.id}/start-agent`)).body).toMatchObject({
      started: false,
      message: 'Agent is already running',
    })
    expect((await call('POST', `/api/sessions/${shell.id}/start-agent`)).status).toBe(400)
    expect((await call('POST', `/api/sessions/${root.id}/start-agent`)).body.started).toBe(false)
  })

  it('answers Tether being down as 503', async () => {
    tether.listSessions = async () => {
      const { TetherUnavailable } = await import('tether/client')
      throw new TetherUnavailable('down')
    }
    const { status, body } = await call('GET', '/api/sessions')
    expect(status).toBe(503)
    expect(body.detail).toMatch(/Tether is not reachable/)
  })
})

describe('panes', () => {
  it('creates a project tab with a shell and the default agent, and remembers the project', async () => {
    const { status, body } = await call('POST', '/api/panes', {
      pane_type: 'project',
      pane_name: 'Aico',
      project_id: 'aico',
      working_dir: '/srv/workspaces/projects/aico/',
    })
    expect(status).toBe(200)
    expect(body).toMatchObject({
      pane_type: 'project',
      project_id: 'aico',
      active_mode: 'claude',
      is_detached: false,
      pane_order: 0,
    })
    expect(body.sessions.map((s: { mode: string }) => s.mode)).toEqual(['claude', 'shell'])
    const creates = tether
      .callsOf('request')
      .filter(([method, path]) => method === 'POST' && path === '/v1/sessions')
      .map(([, , input]) => input)
    expect(creates).toEqual([
      expect.objectContaining({
        origin: 'a-term',
        tool: 'shell',
        projectId: 'aico',
        projectRoot: '/srv/workspaces/projects/aico',
      }),
      expect.objectContaining({ tool: 'claude' }),
    ])
    expect(store.allProjectSettings().get('aico')).toMatchObject({
      enabled: true,
      active_mode: 'claude',
    })

    const list = await call('GET', '/api/panes')
    expect(list.body.total).toBe(1)
    expect((await call('GET', '/api/panes/detached')).body).toMatchObject({ total: 0 })
  })

  it('ends what it created and drops the tab when Tether refuses a session', async () => {
    tether.failTool = 'claude'
    const { status } = await call('POST', '/api/panes', {
      pane_type: 'project',
      pane_name: 'Aico',
      project_id: 'aico',
    })
    expect(status).toBe(409)
    expect(tether.sessions.size).toBe(0)
    expect(store.listPanes()).toEqual([])
  })

  it('validates the request and the tool', async () => {
    expect(
      (await call('POST', '/api/panes', { pane_type: 'project', pane_name: 'x' })).status,
    ).toBe(400)
    expect(
      (
        await call('POST', '/api/panes', {
          pane_type: 'adhoc',
          pane_name: 'x',
          project_id: 'a',
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await call('POST', '/api/panes', {
          pane_type: 'project',
          pane_name: 'x',
          project_id: 'a',
          agent_tool_slug: 'codex',
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await call('POST', '/api/panes', {
          pane_type: 'project',
          pane_name: 'x',
          project_id: 'a',
          agent_tool_slug: 'nope',
        })
      ).status,
    ).toBe(404)
    expect((await call('POST', '/api/panes', { pane_type: 'grid', pane_name: 'x' })).status).toBe(
      422,
    )
  })

  it('creates an ad hoc shell tab named after the tab', async () => {
    const { body } = await call('POST', '/api/panes', {
      pane_type: 'adhoc',
      pane_name: 'Scratch',
    })
    expect(body.sessions).toHaveLength(1)
    expect(body.sessions[0]).toMatchObject({ mode: 'shell', task: 'Scratch' })
    expect((await call('PATCH', `/api/panes/${body.id}`, { active_mode: 'claude' })).status).toBe(
      400,
    )
  })

  it('switches mode, recreating a missing shell, and renames', async () => {
    const pane = store.createPane({ projectId: 'aico', name: 'Aico', activeMode: 'claude' })
    const agent = tether.add({ tool: 'claude', projectRoot: '/p' })
    store.link(agent.id, pane.id, 'claude')
    const { body } = await call('PATCH', `/api/panes/${pane.id}`, {
      active_mode: 'shell',
      pane_name: 'New',
    })
    expect(body).toMatchObject({ active_mode: 'shell', pane_name: 'New' })
    expect(body.sessions.map((s: { mode: string }) => s.mode)).toEqual(['claude', 'shell'])
    expect(
      (await call('PATCH', `/api/panes/${pane.id}`, { active_mode: 'codex' })).body.detail,
    ).toBe("Mode 'codex' not available on this pane")
  })

  it('switches the agent tool by loading it into the running session', async () => {
    const pane = store.createPane({ projectId: 'aico', name: 'Aico', activeMode: 'shell' })
    const agent = tether.add({ tool: 'codex' })
    store.link(agent.id, pane.id, 'codex')
    const { body } = await call('PUT', `/api/panes/${pane.id}/agent-tool`, {
      agent_tool_slug: 'cc',
    })
    expect(tether.callsOf('loadTui')).toEqual([[agent.id, 'g1', 'claude']])
    expect(store.getLink(agent.id)?.mode).toBe('claude')
    expect(body.active_mode).toBe('claude')
  })

  it('deletes a tab by ending its sessions', async () => {
    const pane = store.createPane({ projectId: null, name: 'x', activeMode: 'shell' })
    const shell = tether.add()
    store.link(shell.id, pane.id, 'shell')
    expect((await call('DELETE', `/api/panes/${pane.id}`)).body).toEqual({
      deleted: true,
      id: pane.id,
    })
    expect(tether.sessions.size).toBe(0)
    expect((await call('DELETE', `/api/panes/${pane.id}`)).status).toBe(404)
  })
})

describe('projects, tools, Agent Hub, health', () => {
  it('merges Tether projects with tab settings and sets a mode', async () => {
    tether.projectList.push({ id: 'zeta', name: 'Zeta', root: '/z' })
    store.upsertProjectSettings('zeta', { enabled: true, displayOrder: -1, activeMode: 'claude' })
    expect((await call('GET', '/api/projects')).body).toEqual([
      {
        id: 'zeta',
        name: 'Zeta',
        root_path: '/z',
        enabled: true,
        mode: 'claude',
        display_order: -1,
      },
      {
        id: 'aico',
        name: 'Aico',
        root_path: '/srv/workspaces/projects/aico',
        enabled: false,
        mode: 'shell',
        display_order: 0,
      },
    ])
    expect((await call('PUT', '/api/projects/aico/mode', { mode: 'codex' })).body).toMatchObject({
      id: 'aico',
      mode: 'codex',
    })
    expect((await call('PUT', '/api/projects/aico/mode', { mode: 'Bad Mode' })).status).toBe(422)
  })

  it('lists agent tools in the old shape', async () => {
    const all = (await call('GET', '/api/agent-tools')).body
    expect(all.map((t: { slug: string }) => t.slug)).toEqual(['shell', 'claude', 'codex'])
    expect(all[1]).toMatchObject({
      id: 'claude',
      name: 'Claude',
      is_default: true,
      aliases: ['cc'],
    })
    const enabled = (await call('GET', '/api/agent-tools?enabled_only=true')).body
    expect(enabled.map((t: { slug: string }) => t.slug)).toEqual(['shell', 'claude'])
  })

  it('answers 503 when Agent Hub is not configured', async () => {
    expect(await call('GET', '/api/agent-hub/models')).toMatchObject({
      status: 503,
      body: { detail: 'Agent Hub is not configured' },
    })
    expect((await call('GET', '/api/agent-hub/other')).status).toBe(404)
  })

  it('reports health from Tether', async () => {
    expect((await call('GET', '/health')).body).toMatchObject({
      status: 'healthy',
      tether: { status: 'healthy', apiVersion: 3 },
    })
    tether.version = async () => {
      throw new Error('down')
    }
    expect(await call('GET', '/health')).toMatchObject({
      status: 503,
      body: { status: 'unhealthy' },
    })
  })
})

describe('Agent Hub proxy', () => {
  it('forwards with the client id and hides upstream error bodies', async () => {
    const { proxyAgentHub } = await import('./agent-hub')
    const fetchImpl = vi.fn(async () => new Response('{"items":[]}', { status: 200 }))
    const res = { statusCode: 0, headers: {} as Record<string, unknown>, body: '' }
    const fake = {
      ...res,
      setHeader(name: string, value: unknown) {
        this.headers[name.toLowerCase()] = value
      },
      end(body: string) {
        this.body = body
      },
    }
    await proxyAgentHub(
      { agentHubUrl: 'http://hub.local/', agentHubClientId: 'client-1' },
      '/api/models',
      fake as never,
      fetchImpl as never,
    )
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://hub.local/api/models',
      expect.objectContaining({
        headers: { 'X-Request-Source': 'a-term', 'X-Client-Id': 'client-1' },
      }),
    )
    expect(fake.body).toBe('{"items":[]}')

    fetchImpl.mockResolvedValueOnce(new Response('secret detail', { status: 500 }))
    await proxyAgentHub(
      { agentHubUrl: 'http://hub.local', agentHubClientId: null },
      '/api/models',
      fake as never,
      fetchImpl as never,
    )
    expect(fake.statusCode).toBe(500)
    expect(JSON.parse(fake.body)).toEqual({ detail: 'Agent Hub is temporarily unavailable' })
  })
})
