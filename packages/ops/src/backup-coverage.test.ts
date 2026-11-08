import { requestExec } from '@aico/fleet/exec'
import { readSettings } from '@aico/fleet/settings'
import { readPins } from '@aico/fleet/trust'
import { afterEach, expect, it, vi } from 'vitest'
import { fleetBackupCoverage, localBackupCoverage } from './backup-coverage'
import { backupRows, config, copyKey, emptyState, entries } from './backup-plan'

vi.mock('@aico/fleet/exec', () => ({ requestExec: vi.fn() }))
vi.mock('@aico/fleet/settings', () => ({ readSettings: vi.fn() }))
vi.mock('@aico/fleet/trust', () => ({ readPins: vi.fn() }))
afterEach(() => vi.resetAllMocks())

const now = Date.parse('2026-11-08T20:00:00Z')
const source = 'pve-host-files'

it('keeps a moved source in its original repository only in the coverage read', () => {
  const cfg = config({ AICO_BACKUP_MACHINE: 'davion-sidarli' })
  const state = emptyState()
  state.copies[copyKey(source, 'drive')] = {
    source,
    target: 'drive',
    dataAt: new Date(now - 3600000).toISOString(),
    snapshot: 'a'.repeat(64),
    error: 'An old controller attempt failed after its last verified copy',
  }
  const before = structuredClone(state)
  const active = entries(state, cfg, cfg.workstation, now)
  expect(active.find((item) => item.source === source && item.target === 'drive')).toBeUndefined()
  expect(backupRows(active).find((row) => row.id.endsWith(`drive/${source}`))).toBeUndefined()
  const owner = localBackupCoverage(state, cfg, cfg.workstation, active, now)
  expect(owner.repository).not.toBe(cfg.driveClients.aico.repository)
  expect(owner.retained).toEqual([
    expect.objectContaining({
      source,
      machine: cfg.workstation,
      snapshot: 'a'.repeat(64),
      state: 'ok',
    }),
  ])
  const currentCfg = config({ AICO_BACKUP_MACHINE: 'aico' })
  const currentState = emptyState()
  const current = localBackupCoverage(
    currentState,
    currentCfg,
    'aico',
    entries(currentState, currentCfg, 'aico', now),
    now,
  )
  expect(current.entries.find((item) => item.source === source)?.snapshot).toBeNull()
  expect(current.retained).toEqual([])
  expect(state).toEqual(before)
})

function configuredFleet() {
  vi.mocked(readSettings).mockReturnValue({
    machine: 'davion-sidarli',
    stateDir: '/state',
    allowlist: '/pins',
    listen: { address: '127.0.0.1', port: 1 },
    peers: [{ name: 'aico', endpoint: { address: '127.0.0.1', port: 2 } }],
    controlSocket: '/control',
    syncSocket: '/sync',
    peerRoot: '/fleet',
    retryMinMs: 1,
    retryMaxMs: 1,
    deadMs: 1,
    statusMs: 1,
    statusUrl: 'http://127.0.0.1',
  })
  vi.mocked(readPins).mockReturnValue([{ name: 'aico', role: 'full', publicKey: 'fixture' }])
  const cfg = config({ AICO_BACKUP_MACHINE: 'davion-sidarli' })
  const state = emptyState()
  const local = localBackupCoverage(
    state,
    cfg,
    cfg.workstation,
    entries(state, cfg, cfg.workstation, now),
    now,
  )
  const peerCfg = config({ AICO_BACKUP_MACHINE: 'aico' })
  const peer = localBackupCoverage(
    state,
    peerCfg,
    'aico',
    entries(state, peerCfg, 'aico', now),
    now,
  )
  return { cfg, local, peer }
}

it('reads each configured owner once over the existing fleet exec route without federation recursion', async () => {
  const { cfg, local, peer } = configuredFleet()
  vi.mocked(requestExec).mockResolvedValue({
    ended: true,
    code: 0,
    stdout: JSON.stringify({ owners: [peer] }),
    output: '',
  })
  expect((await fleetBackupCoverage(local, cfg)).owners).toEqual([local, peer])
  expect(requestExec).toHaveBeenCalledExactlyOnceWith(
    '/fleet/aico/exec.sock',
    ['sh', '-c', expect.stringContaining('backups list --fleet --local --json')],
    Buffer.alloc(0),
  )
})

it.each(['unreachable', 'wrong-machine', 'wrong-repository', 'malformed'])(
  'reports an %s owner as unknown without moving its receipts',
  async (failure) => {
    const { cfg, local, peer } = configuredFleet()
    if (failure === 'wrong-machine') peer.machine = 'another-machine'
    if (failure === 'wrong-repository') peer.repository = 'another-repository'
    vi.mocked(requestExec).mockResolvedValue({
      ended: failure !== 'unreachable',
      code: failure === 'unreachable' ? 255 : 0,
      stdout: failure === 'malformed' ? 'invalid-json' : JSON.stringify({ owners: [peer] }),
      output: '',
    })
    expect((await fleetBackupCoverage(local, cfg)).owners[1]).toEqual({
      machine: 'aico',
      repository: cfg.driveClients.aico.repository,
      sources: peer.sources,
      state: 'unknown',
    })
  },
)
