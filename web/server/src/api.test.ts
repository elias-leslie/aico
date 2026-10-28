import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { TetherError, wakeChoices } from 'tether/client'
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
      tether: tether.client,
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

describe('check-ins', () => {
  const agent = () => tether.add({ tool: 'claude', state: 'idle' } as never)
  const wakeRow = (id: string, sessionId: string | null, dueAt: number, extra = {}) => ({
    id,
    sessionId,
    dueAt,
    note: 'n',
    createdBy: 'owner' as const,
    createdAt: 1,
    kept: sessionId === null,
    attempts: 0,
    lastError: null,
    ...extra,
  })

  it("carries a session's check-ins in the session list", async () => {
    const at = Date.now() + 3_600_000
    const session = tether.add({
      tool: 'claude',
      wakes: [{ id: 'aaaaaaaaaaaa', dueAt: at, note: 'n', createdBy: 'agent' }],
    } as never)
    const { body } = await call('GET', `/api/sessions/${session.id}`)
    expect(body.check_ins).toEqual([{ id: 'aaaaaaaaaaaa', due_at: at, time: expect.any(String) }])
    const plain = tether.add()
    expect((await call('GET', `/api/sessions/${plain.id}`)).body.check_ins).toEqual([])
  })

  it('offers the quick choices and the pending check-ins', async () => {
    const session = agent()
    const at = Date.now() + 7_200_000
    tether.wakeRows = [
      wakeRow('aaaaaaaaaaaa', session.id, at),
      wakeRow('bbbbbbbbbbbb', 'other000', at),
    ]
    const { status, body } = await call('GET', `/api/sessions/${session.id}/check-ins`)
    expect(status).toBe(200)
    expect(body.status).toBe('ready')
    // Worded on the server's clock ('Tonight' or 'Tomorrow night' depends on the hour).
    expect(body.choices.map((choice: { label: string }) => choice.label)).toEqual(
      wakeChoices(tether.wakePolicy, Date.now()).map((choice) => choice.label),
    )
    expect(body.choices[0].label).toBe('In 1 hour')
    expect(body.choices[0]).toMatchObject({ dueAt: expect.any(Number), time: expect.any(String) })
    expect(body.pending).toEqual([{ id: 'aaaaaaaaaaaa', dueAt: at, time: expect.any(String) }])
  })

  it('says a session whose state Tether cannot read is unsupported', async () => {
    const shell = tether.add({ tool: 'shell' })
    const { body } = await call('GET', `/api/sessions/${shell.id}/check-ins`)
    expect(body.status).toBe('unsupported')
    expect((await call('GET', '/api/sessions/gone1234/check-ins')).status).toBe(404)
  })

  it('sets an owner check-in with the owner note', async () => {
    const session = agent()
    const dueAt = Date.now() + 600_000
    const { status, body } = await call('POST', `/api/sessions/${session.id}/check-ins`, {
      dueAt,
    })
    expect(status).toBe(200)
    expect(body).toMatchObject({ dueAt, time: expect.any(String) })
    expect(tether.callsOf('addWake')).toEqual([
      [session.id, { dueAt, note: expect.stringContaining('owner asked'), createdBy: 'owner' }],
    ])
    expect((await call('POST', `/api/sessions/${session.id}/check-ins`, {})).status).toBe(422)
    expect(
      (await call('POST', `/api/sessions/${session.id}/check-ins`, { dueAt: 'soon' })).status,
    ).toBe(422)
  })

  it("words Tether's refusals plainly", async () => {
    const session = agent()
    const dueAt = Date.now() + 600_000
    tether.failWake = new TetherError(409, 'wake_unsupported', {})
    expect(await call('POST', `/api/sessions/${session.id}/check-ins`, { dueAt })).toMatchObject({
      status: 409,
      body: { detail: "Aico can't tell when this session is idle, so it can't take check-ins" },
    })
    tether.failWake = new TetherError(409, 'too_many_wakes', { max: 5 })
    expect(await call('POST', `/api/sessions/${session.id}/check-ins`, { dueAt })).toMatchObject({
      status: 409,
      body: { detail: 'This session has as many check-ins as it can take' },
    })
    tether.failWake = new TetherError(400, 'invalid_body', {})
    expect(await call('POST', `/api/sessions/${session.id}/check-ins`, { dueAt })).toMatchObject({
      status: 400,
      body: { detail: 'Pick a time from now to a year ahead' },
    })
  })

  it('cancels only a check-in Tether lists', async () => {
    tether.wakeRows = [wakeRow('aaaaaaaaaaaa', 's1', Date.now() + 1000)]
    expect((await call('DELETE', '/api/check-ins/bbbbbbbbbbbb')).status).toBe(404)
    expect((await call('DELETE', '/api/check-ins/not-an-id')).status).toBe(404)
    expect(tether.callsOf('cancelWake')).toEqual([])
    expect((await call('DELETE', '/api/check-ins/aaaaaaaaaaaa')).body).toEqual({
      deleted: true,
      id: 'aaaaaaaaaaaa',
    })
    expect(tether.callsOf('cancelWake')).toEqual([['aaaaaaaaaaaa']])
  })

  it('lists check-ins kept past an End', async () => {
    const at = Date.now() + 86_400_000
    tether.wakeRows = [
      wakeRow('aaaaaaaaaaaa', 's1', at),
      wakeRow('bbbbbbbbbbbb', null, at, {
        endedSession: { id: 's0', name: 'Fix login', tool: 'claude', projectId: 'aico' },
      }),
      wakeRow('cccccccccccc', null, at, {
        endedSession: { id: 's2', name: null, tool: 'codex', projectId: null },
        lastError: 'admission refused',
      }),
    ]
    const { body } = await call('GET', '/api/check-ins/kept')
    expect(body.items).toEqual([
      {
        id: 'bbbbbbbbbbbb',
        dueAt: at,
        time: expect.any(String),
        session: 'Aico — Fix login',
        failed: false,
      },
      {
        id: 'cccccccccccc',
        dueAt: at,
        time: expect.any(String),
        session: 'codex',
        failed: true,
      },
    ])
  })

  it('ends a session keeping its check-ins only when asked', async () => {
    const first = agent()
    await call('DELETE', `/api/sessions/${first.id}`)
    expect(tether.callsOf('end')).toEqual([[first.id, 'g1']])
    const second = agent()
    await call('DELETE', `/api/sessions/${second.id}?keepWakes=true`)
    expect(tether.callsOf('end')[1]).toEqual([second.id, 'g1', { keepWakes: true }])
  })
})

describe('workflow runs', () => {
  it('lists the runs Tether follows', async () => {
    tether.runsAnswer = {
      status: 'stale',
      error: 'Agent Hub is not reachable',
      updatedAt: 5,
      items: [],
    }
    expect(await call('GET', '/api/runs')).toMatchObject({
      status: 200,
      body: { status: 'stale', error: 'Agent Hub is not reachable', items: [] },
    })
  })

  it('answers a waiting step, cancels a run or a step, and dismisses an ended run', async () => {
    expect(
      (await call('POST', '/api/runs/r1/resume', { action: 'retry', stepKey: 'build' })).body,
    ).toEqual({ ok: true })
    expect((await call('POST', '/api/runs/r1/cancel', {})).status).toBe(200)
    expect((await call('POST', '/api/runs/r1/cancel', { stepKey: 'build' })).status).toBe(200)
    expect((await call('POST', '/api/runs/r1/dismiss')).status).toBe(200)
    expect(tether.callsOf('resumeRun')).toEqual([['r1', 'retry', 'build']])
    expect(tether.callsOf('cancelRun')).toEqual([
      ['r1', null],
      ['r1', 'build'],
    ])
    expect(tether.callsOf('dismissRun')).toEqual([['r1']])
  })

  it('refuses a decision it does not know or an id that is not a run id', async () => {
    expect((await call('POST', '/api/runs/r1/resume', { action: 'destroy' })).status).toBe(422)
    expect((await call('POST', '/api/runs/r1/resume', {})).status).toBe(422)
    expect(
      (await call('POST', '/api/runs/r1/resume', { action: 'skip', stepKey: '../x' })).status,
    ).toBe(422)
    expect((await call('POST', `/api/runs/${'x'.repeat(100)}/dismiss`)).status).toBe(404)
    expect(tether.callsOf('resumeRun')).toEqual([])
  })

  it("words Tether's and Agent Hub's refusals plainly", async () => {
    tether.failRun = new TetherError(404, 'unknown_run', {})
    expect(await call('POST', '/api/runs/r1/dismiss')).toMatchObject({
      status: 404,
      body: { detail: 'That run is no longer listed; it may have ended' },
    })
    tether.failRun = new TetherError(409, 'agent_hub_refused', { reason: 'step is running' })
    expect(await call('POST', '/api/runs/r1/cancel', {})).toMatchObject({
      status: 409,
      body: { detail: 'Agent Hub did not accept it (step is running)' },
    })
    tether.failRun = new TetherError(503, 'agent_hub_unavailable', {})
    expect(await call('POST', '/api/runs/r1/dismiss')).toMatchObject({
      status: 503,
      body: { detail: 'Agent Hub is not reachable' },
    })
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
