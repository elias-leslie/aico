import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { BackupDeferred, backupJob, driveBackup } from './backup-drive'
import { config, copyKey, emptyState } from './backup-plan'
import { execute, readState, saveRun, saveState } from './backup-runtime'
import { backups, runBackup } from './backups'

vi.mock('./backup-drive', async (original) => ({
  ...(await original<typeof import('./backup-drive')>()),
  driveBackup: vi.fn(),
}))
vi.mock('./backup-runtime', async (original) => ({
  ...(await original<typeof import('./backup-runtime')>()),
  execute: vi.fn(async () => ({ code: 0, out: '[]', err: '' })),
}))
const roots: string[] = []
const listeners = new Set(process.listeners('SIGINT'))
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  for (const listener of process.listeners('SIGINT'))
    if (!listeners.has(listener)) process.removeListener('SIGINT', listener)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const previous = {
  source: 'pve-vm-180-app-recovery',
  target: 'drive' as const,
  dataAt: '2026-11-01T00:00:00Z',
  snapshot: 'a'.repeat(64),
  observed: 'ok' as const,
}
const receipt = { started: '2026-11-01T00:00:00Z', finished: '2026-11-01T00:01:00Z', ok: true }
const when = new Date('2026-11-08T20:00:00Z')
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'aico-backup-busy-'))
  roots.push(root)
  vi.stubEnv('XDG_RUNTIME_DIR', root)
  const cfg = config({ AICO_BACKUP_MACHINE: 'aico' })
  cfg.stateDir = join(root, 'state')
  cfg.cacheDir = join(root, 'cache')
  cfg.rootCacheDir = join(root, 'cache-root')
  const state = emptyState()
  state.copies[copyKey(previous.source, 'drive')] = { ...previous }
  return { root, cfg, state }
}
it.each(['busy', 'hot', 'stale'])(
  'a %s guard refusal preserves source age and receipt instead of recording a failure',
  async (reason) => {
    const { cfg, state } = fixture()
    const run = vi.fn(async () => ({
      code: 1,
      out: '',
      err: `${reason}: backup guard paused\n${JSON.stringify({ message_type: 'error', error: { message: 'Fatal: command failed: exit status 75' } })}`,
    }))
    await expect(
      backupJob({ cfg, run, now: () => when }, state, {
        id: previous.source,
        paths: [],
        binds: [],
        dataAt: when.toISOString(),
        command: ['ssh', 'pve', 'capture'],
        filename: 'files-qemu-180.tar',
      }),
    ).rejects.toBeInstanceOf(BackupDeferred)
    expect(state.copies[copyKey(previous.source, 'drive')]).toEqual(previous)
  },
)
it('a real transport failure remains failed and retains its last good data', async () => {
  const { cfg, state } = fixture()
  const run = async () => ({
    code: 1,
    out: '',
    err: 'ssh: connection reset; Fatal: command failed: exit status 255',
  })
  const copy = await backupJob({ cfg, run, now: () => when }, state, {
    id: previous.source,
    paths: [],
    binds: [],
    dataAt: when.toISOString(),
    command: ['ssh', 'pve', 'capture'],
    filename: 'files-qemu-180.tar',
  })
  expect(copy).toMatchObject({
    dataAt: previous.dataAt,
    snapshot: previous.snapshot,
    observed: 'failed',
  })
  expect(copy.error).toContain('copy failed')
})
it.each([true, false])(
  'a deferred run restores its previous run record (previous=%s)',
  async (hasPrevious) => {
    const { cfg, state } = fixture()
    if (hasPrevious) {
      state.runs.drive = { ...receipt }
      saveRun(cfg, 'drive', receipt)
    }
    saveState(cfg, state)
    vi.mocked(driveBackup).mockRejectedValueOnce(
      new BackupDeferred('Backup paused while gem cools.'),
    )
    await expect(
      runBackup({ cfg, run: execute, now: () => when }, state, 'drive', 'aico', true),
    ).rejects.toBeInstanceOf(BackupDeferred)
    expect(state.runs.drive).toEqual(hasPrevious ? receipt : undefined)
    expect(readState(cfg).runs.drive).toEqual(hasPrevious ? receipt : undefined)
    expect(readState(cfg).copies[copyKey(previous.source, 'drive')]).toEqual(previous)
  },
)
it('the command returns the existing busy exit for a guard pause and keeps the reason', async () => {
  const { root, cfg, state } = fixture()
  const path = join(root, 'config.json')
  writeFileSync(path, JSON.stringify(cfg))
  saveState(cfg, state)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ rows: [] }), { status: 200 })),
  )
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.mocked(driveBackup).mockRejectedValueOnce(new BackupDeferred('Backup paused while gem cools.'))
  expect(
    await backups(['run', 'drive', '--scheduled'], {
      AICO_BACKUPS_CONFIG: path,
      AICO_BACKUP_MACHINE: 'aico',
      AICO_BACKUPS_UNIT: '1',
      AICO_BACKUPS_LOCKED: '1',
    }),
  ).toBe(75)
  expect(log).toHaveBeenCalledWith('Backup paused while gem cools.')
  expect(readState(cfg).copies[copyKey(previous.source, 'drive')]).toEqual(previous)
})
it.each(['davion-sidarli', 'aico'])(
  'only the gem controller receives its actual Restic CPU ceiling (%s)',
  async (machine) => {
    const { root, cfg } = fixture()
    const selected = config({ AICO_BACKUP_MACHINE: machine })
    selected.stateDir = cfg.stateDir
    const path = join(root, 'config.json')
    writeFileSync(path, JSON.stringify(selected))
    const run = vi.mocked(execute)
    run.mockReset()
    run.mockImplementation(async (argv) => ({
      code: argv[0] === 'systemctl' ? 3 : 0,
      out: '',
      err: '',
    }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(
      await backups(['run', 'drive'], { AICO_BACKUPS_CONFIG: path, AICO_BACKUP_MACHINE: machine }),
    ).toBe(0)
    const command = run.mock.calls.find(([argv]) => argv[0] === 'systemd-run')?.[0]
    expect(command?.includes('CPUQuota=50%')).toBe(machine === 'aico')
  },
)
