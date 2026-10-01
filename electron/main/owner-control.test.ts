import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  reconcileRetiredViews,
  reconcileSessionViews,
  watchSessionCatalog,
} from './external-view-reconciliation'
import { LifecycleOwnerLock } from './lifecycle-guard'
import { createOwnerServer, listenOwnerServer, ownerSocketPath } from './owner-control'
import { sessionGeneration } from './owner-retirement'
import { getWidget, initStore, insertWidget, listWidgets } from './store'

describe('headless owner control', () => {
  const root = mkdtempSync(join(tmpdir(), 'aico-owner-test-'))
  const socket = join(root, 'aico', 'control.sock')
  const server = createOwnerServer({
    sessionState: async (id) => (id === 'abcddcba' ? 'unknown' : 'absent'),
    verifiedCurrentPane: async (row) => row.id === 'abcddcba',
    stopTmuxSession: async () => {
      throw new Error('must not stop tmux')
    },
    settleServer: async () => {},
  })

  beforeAll(async () => {
    initStore(join(root, 'aico.db'))
    await listenOwnerServer(server, socket)
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
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

  it('reads committed ownership while the desktop connection is writing', () => {
    const row = insertWidget('1234ba98', true, 'shell')
    const desktop = new DatabaseSync(join(root, 'aico.db'))
    try {
      desktop.exec('BEGIN EXCLUSIVE')
      desktop.prepare('UPDATE widgets SET open = 0 WHERE id = ?').run(row.id)
      expect(getWidget(row.id)?.open).toBe(true)
    } finally {
      desktop.exec('ROLLBACK')
      desktop.close()
    }
  })

  it('closes the desktop view after the headless owner confirms End', async () => {
    const row = insertWidget('1234dcba', true, 'shell')
    const open = new Set([row.id])
    const locks = new LifecycleOwnerLock()
    const close = vi.fn((id: string) => open.delete(id))
    expect(
      await call(`/v1/sessions/${row.id}/end`, 'POST', {
        generation: sessionGeneration(row),
      }),
    ).toEqual({ status: 200, body: { status: 'ended' } })

    await reconcileSessionViews([], {
      list: listWidgets,
      openViews: () => [...open],
      close,
      acquire: (id) => locks.acquire(id),
      release: (_id, owner) => {
        locks.release(owner)
      },
      probe: async () => 'unknown',
      forget: () => false,
    })

    expect(close).toHaveBeenCalledExactlyOnceWith(row.id)
    expect(open.size).toBe(0)
  })

  it('observes retirement committed after the terminal client has exited', async () => {
    const row = insertWidget('1234fedc', true, 'shell')
    const open = new Set([row.id])
    const close = vi.fn((id: string) => open.delete(id))
    const operations = { list: listWidgets, openViews: () => [...open], close }
    const onError = vi.fn()
    const watcher = watchSessionCatalog(
      join(root, 'aico.db'),
      () => {
        reconcileRetiredViews(operations)
      },
      onError,
    )
    try {
      // The exited/detached client still has a catalog row. Keep its view until
      // the owner's later transaction confirms complete retirement.
      expect(reconcileRetiredViews(operations)).toBe(0)
      expect(close).not.toHaveBeenCalled()
      expect(
        await call(`/v1/sessions/${row.id}/end`, 'POST', {
          generation: sessionGeneration(row),
        }),
      ).toEqual({ status: 200, body: { status: 'ended' } })

      await vi.waitFor(() => expect(open.size).toBe(0))
      expect(close).toHaveBeenCalledExactlyOnceWith(row.id)
      expect(onError).not.toHaveBeenCalled()
    } finally {
      watcher.close()
    }
  })

  it('rejects unauthoritative and stale End requests, then confirms guarded retirement', async () => {
    const row = insertWidget('1234abcd', false, 'shell')
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
    insertWidget('abcddcba', false, 'shell')
    const db = new DatabaseSync(join(root, 'aico.db'))
    try {
      db.prepare(
        `UPDATE widgets SET lifecycle_version = 1, tmux_allocation_state = 'bound',
         tmux_server_id = 'abcdef12', tmux_session_id = '$5', pane_id = '%8'
         WHERE id = 'abcddcba'`,
      ).run()
    } finally {
      db.close()
    }
    const descriptor = await call('/v1/sessions/abcddcba')
    expect(descriptor.status).toBe(200)
    expect(descriptor.body).toMatchObject({
      owner: 'aico',
      widgetId: 'abcddcba',
      tmuxSessionId: '$5',
      paneId: '%8',
    })
    const generation = (descriptor.body as { generation: string }).generation
    expect((await call('/v1/sessions/abcddcba/end', 'POST', { generation })).status).toBe(409)
    expect(getWidget('abcddcba')).toBeDefined()
  })
})
