import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FleetSettings } from './settings'

const mocks = vi.hoisted(() => ({
  settings: null as unknown,
  start: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  power: vi.fn(),
}))
vi.mock('./settings', () => ({ readSettings: () => mocks.settings }))
vi.mock('./fleet', () => ({
  Fleet: class {
    start = mocks.start
    close = mocks.close
  },
}))
vi.mock('./proxmox', () => ({ pveRequest: () => async () => ({}) }))
vi.mock('./power', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./power')>()),
  guestPower: mocks.power,
}))

import { FleetService } from './service'

function settings(peers: string[]): FleetSettings {
  return {
    machine: 'hub',
    stateDir: '/x',
    allowlist: '',
    listen: { address: '127.0.0.1', port: 7449 },
    peers: peers.map((name) => ({ name, endpoint: { address: '127.0.0.1', port: 7450 } })),
    proxmox: true,
    controlSocket: '/c',
    syncSocket: '/s',
    peerRoot: '/p',
    retryMinMs: 600_000,
    retryMaxMs: 600_000,
    deadMs: 5000,
    statusMs: 1000,
    statusUrl: 'http://127.0.0.1:1/api/status/rows',
  }
}

const open: FleetService[] = []
afterEach(async () => {
  for (const service of open.splice(0)) await service.close()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

/** Starts a service whose link fails, and returns the Status rows it wrote. */
async function failing(value: FleetSettings | null) {
  mocks.settings = value
  mocks.start.mockRejectedValueOnce(new Error('listener gone'))
  const posts: { method: string; body: unknown }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: URL, init: { method: string; body?: string }) => {
      posts.push({ method: init.method, body: init.body ? JSON.parse(init.body) : null })
      return new Response('{}', { status: 200 })
    }),
  )
  const service = new FleetService({}, '/control.sock', () => {})
  open.push(service)
  await service.start()
  return posts.find((post) => post.method === 'POST')?.body as Record<string, unknown>[]
}

describe('FleetService failed()', () => {
  it('writes off for a peer read as stopped and failed for a running or unread peer', async () => {
    mocks.power.mockResolvedValue(
      new Map([
        ['asleep', 'stopped'],
        ['busy', 'running'],
      ]),
    )
    const rows = await failing(settings(['asleep', 'busy', 'unread']))
    expect(rows.map((row) => [row.machine, row.state])).toEqual([
      ['asleep', 'off'],
      ['busy', 'failed'],
      ['unread', 'failed'],
    ])
    expect(rows[1]?.meaning).toContain('Link failed: listener gone')
    expect(rows[0]?.id).toBe('fleet/hub/asleep')
  })

  it('writes failed for every peer when guest power cannot be read', async () => {
    mocks.power.mockRejectedValue(new Error('Proxmox unavailable'))
    const rows = await failing(settings(['asleep', 'busy']))
    expect(rows.map((row) => row.state)).toEqual(['failed', 'failed'])
  })

  it('writes one machine-wide failure row when there are no peers', async () => {
    const rows = await failing(settings([]))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'fleet/hub', state: 'failed', kind: 'service' })
  })
})
