import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Fleet } from '@aico/fleet/fleet'
import { machineName } from '@aico/fleet/identity'
import { resolvePaths } from '@aico/session-engine/paths'
import { expect, it, vi } from 'vitest'
import { callSocket } from './client'
import { startDaemon } from './daemon'

it('keeps serving locally, reports a failed link and retries after fleet start throws', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-fault-'))
  const env = {
    HOME: root,
    XDG_RUNTIME_DIR: join(root, 'run'),
    TETHER_STATE_DIR: join(root, 'state'),
    TETHER_RUNTIME_DIR: join(root, 'tether'),
    XDG_CONFIG_HOME: join(root, 'config'),
    AICO_FLEET_CONFIG: join(root, 'fleet.json'),
    TETHER_RECONCILE: 'off',
    AICO_TASKS_DB: '/nonexistent/tasks.db',
  }
  const paths = resolvePaths({ instance: 'test', env })
  writeFileSync(
    env.AICO_FLEET_CONFIG,
    JSON.stringify({
      machine: machineName(hostname()),
      stateDir: join(root, 'identity'),
      allowlist: join(root, 'pins'),
      listen: { address: '127.0.0.1', port: 7449 },
      peers: [{ name: 'test-peer', endpoint: { address: '127.0.0.1', port: 7450 } }],
      syncSocket: join(root, 'sync.sock'),
      peerRoot: join(env.XDG_RUNTIME_DIR, 'aico/fleet'),
      retryMinMs: 20,
      retryMaxMs: 100,
      statusMs: 20,
      deadMs: 300000,
      statusUrl: 'http://127.0.0.1:1/api/status/rows',
    }),
  )
  const start = vi
    .spyOn(Fleet.prototype, 'start')
    .mockRejectedValueOnce(new Error('fixture listener failed'))
    .mockResolvedValue(undefined)
  const rows: unknown[] = []
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    rows.push(JSON.parse(String(init?.body)))
    return new Response('', { status: 200 })
  })
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined
  try {
    daemon = await startDaemon(paths, env)
    expect((await callSocket(paths.socket, 'GET', '/v1/health')).status).toBe(200)
    expect(rows.flat()).toContainEqual(
      expect.objectContaining({
        id: `fleet/${machineName(hostname())}/test-peer`,
        state: 'failed',
      }),
    )
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2))
  } finally {
    await daemon?.close()
    start.mockRestore()
    fetch.mockRestore()
    rmSync(root, { recursive: true, force: true })
  }
})
