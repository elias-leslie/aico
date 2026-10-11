// Ported from Aico electron/main/owner-control.test.ts. The desktop-view
// reconciliation cases stay in Aico (external-view-reconciliation.ts).
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Store } from '../store'
import {
  activateTmuxServer,
  bindCatalog,
  getWidget,
  insertProvisioningTmuxServer,
  insertWidget,
} from './catalog'
import { LifecycleOwnerLock } from './lifecycle-guard'
import { createOwnerServer, listenOwnerServer, ownerSocketPath } from './owner-control'
import {
  type RetirementOperations,
  retireOwnedSession,
  sessionGeneration,
} from './owner-retirement'

describe('headless owner control', () => {
  const root = mkdtempSync(join(tmpdir(), 'tether-owner-test-'))
  const socket = join(root, 'aico', 'control.sock')
  const store = new Store(':memory:')
  let verificationMutation: (() => void) | undefined
  const retirement: RetirementOperations = {
    sessionState: async (id) => (id === 'abcddcba' ? 'unknown' : 'absent'),
    verifiedCurrentPane: async (row) => {
      verificationMutation?.()
      return row.id === 'abcddcba'
    },
    stopTmuxSession: async () => {
      throw new Error('must not stop tmux')
    },
    settleServer: async () => {},
  }
  const owners = new LifecycleOwnerLock()
  const server = createOwnerServer({
    verifiedCurrentPane: retirement.verifiedCurrentPane,
    end: async (widgetId, generation) => {
      const owner = owners.acquire(widgetId)
      if (!owner) return { status: 'busy' }
      try {
        return await retireOwnedSession(widgetId, retirement, generation)
      } finally {
        owners.release(owner)
      }
    },
  })

  beforeAll(async () => {
    bindCatalog(store.db)
    await listenOwnerServer(server, socket)
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
    store.close()
  })

  function call(
    path: string,
    method = 'GET',
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      const client = request(
        { socketPath: socket, path, method, headers: { 'content-type': 'application/json' } },
        (response) => {
          let text = ''
          response.on('data', (part: Buffer) => {
            text += part.toString('utf8')
          })
          response.on('end', () =>
            resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) }),
          )
        },
      )
      client.once('error', reject)
      client.end(body === undefined ? undefined : JSON.stringify(body))
    })
  }

  it('uses a private per-user socket and validates its path', () => {
    expect(statSync(join(root, 'aico')).mode & 0o777).toBe(0o700)
    expect(statSync(socket).mode & 0o777).toBe(0o600)
    expect(ownerSocketPath(undefined, '/run/user/1000', 1000)).toBe(
      '/run/user/1000/aico/control.sock',
    )
    expect(() => ownerSocketPath('/tmp/../other.sock')).toThrow()
  })

  it('reports that root GUI controls require Electron main', async () => {
    expect(await call('/v1/roots')).toEqual({ status: 503, body: { error: 'gui_unavailable' } })
    expect(await call('/v1/roots/request/show', 'POST', {})).toEqual({
      status: 503,
      body: { error: 'gui_unavailable' },
    })
  })

  it('answers busy while another lifecycle operation holds the session', async () => {
    const row = insertWidget('1234dcba', 'shell')
    const held = owners.acquire(row.id)
    try {
      expect(
        await call(`/v1/sessions/${row.id}/end`, 'POST', { generation: sessionGeneration(row) }),
      ).toEqual({ status: 409, body: { error: 'busy' } })
    } finally {
      if (held) owners.release(held)
    }
    expect(
      await call(`/v1/sessions/${row.id}/end`, 'POST', { generation: sessionGeneration(row) }),
    ).toEqual({ status: 200, body: { status: 'ended' } })
  })

  it('rejects unauthoritative and stale End requests, then confirms guarded retirement', async () => {
    const row = insertWidget('1234abcd', 'shell')
    const path = `/v1/sessions/${row.id}`
    expect((await call(path)).status).toBe(404)
    expect((await call(`${path}/end`, 'POST', { generation: 'bad' })).status).toBe(400)
    expect((await call(`${path}/end`, 'POST', { generation: '0'.repeat(64) })).status).toBe(409)
    const generation = sessionGeneration(row)
    expect(await call(`${path}/end`, 'POST', { generation })).toEqual({
      status: 200,
      body: { status: 'ended' },
    })
    expect(getWidget(row.id)).toBeUndefined()
    expect((await call(`${path}/end`, 'POST', { generation })).status).toBe(404)
  })

  it('returns an owner-qualified managed descriptor and preserves blocked work', async () => {
    insertWidget('abcddcba', 'shell')
    insertProvisioningTmuxServer({
      id: 'abcdef12',
      socketPath: join(root, 'server.sock'),
      scopeUnit: 'aico-tmux-server-abcdef12.service',
    })
    activateTmuxServer('abcdef12', {
      controlGroup: '/aico-tmux-server-abcdef12.service',
      invocationId: 'a'.repeat(32),
      serverPid: 123,
      procStartTime: '456',
    })
    store.db
      .prepare(
        `UPDATE sessions SET lifecycle_version = 1, tmux_allocation_state = 'bound',
         tmux_server_id = 'abcdef12', tmux_session_id = '$5', pane_id = '%8'
         WHERE id = 'abcddcba'`,
      )
      .run()
    const descriptor = await call('/v1/sessions/abcddcba')
    expect(descriptor.status).toBe(200)
    expect(descriptor.body).toMatchObject({
      owner: 'aico',
      widgetId: 'abcddcba',
      tmuxSessionId: '$5',
      paneId: '%8',
      tmuxServerId: 'abcdef12',
      tmuxSocket: join(root, 'server.sock'),
      tool: 'shell',
    })
    const generation = (descriptor.body as { generation: string }).generation
    expect((await call('/v1/sessions/abcddcba/end', 'POST', { generation })).status).toBe(409)
    expect(getWidget('abcddcba')).toBeDefined()
  })

  it('rejects a catalog generation changed during asynchronous pane verification', async () => {
    verificationMutation = () => {
      store.db
        .prepare("UPDATE sessions SET session_id = 'changed-fixture' WHERE id = 'abcddcba'")
        .run()
    }
    try {
      expect(await call('/v1/sessions/abcddcba')).toEqual({
        status: 409,
        body: { error: 'identity_changed' },
      })
    } finally {
      verificationMutation = undefined
    }
  })
})
