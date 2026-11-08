import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '@aico/store'
import { afterEach, expect, it, vi } from 'vitest'
import { driveBackup } from './backup-drive'
import {
  config,
  copyKey,
  driveSourceOwner,
  driveSources,
  emptyState,
  migrated,
} from './backup-plan'
import type { Runtime } from './backup-runtime'

const roots: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
it('assigns every enabled source to exactly one controller using the existing client source lists', () => {
  const cfg = config({})
  const machines = [cfg.workstation, ...Object.keys(cfg.driveClients)]
  const selections = machines.flatMap((machine) => driveSources(cfg, machine).map((s) => s.id))
  expect(new Set(selections).size).toBe(selections.length)
  expect(selections.sort()).toEqual(
    migrated.sources
      .filter((s) => s.enabled)
      .map((s) => s.id)
      .sort(),
  )
  for (const source of migrated.sources.filter((s) => s.enabled && s.path.startsWith('proxmox://')))
    expect(driveSourceOwner(cfg, source.id)).toBe('aico')
  Object.assign(cfg.driveClients, { conflicting: structuredClone(cfg.driveClients.aico) })
  expect(() => driveSources(cfg, cfg.workstation)).toThrow('more than one owner')
})
it('two controller runs select disjoint jobs and preserve the other controller’s old receipts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aico-backup-owners-'))
  roots.push(root)
  const data = join(root, 'data')
  mkdirSync(data)
  const db = openDatabase(join(data, 'notes.db'), [])
  db.exec("CREATE TABLE synthetic(value TEXT); INSERT INTO synthetic VALUES ('saved')")
  db.close()
  vi.stubEnv('AICO_DATA_DIR', data)
  vi.stubEnv('XDG_RUNTIME_DIR', root)
  const when = new Date('2026-11-08T20:00:00Z')
  const jobs = new Map<string, string[]>()
  const controllers = ['davion-sidarli', 'aico'].map((machine) => {
    const cfg = config({ AICO_BACKUP_MACHINE: machine })
    // The unrelated removable archive is outside this two-controller transport scenario.
    Object.assign(cfg.driveClients, {
      archive: { ...cfg.driveClients.aico, guests: ['blackbox-vault-archive'] },
    })
    cfg.cacheDir = join(root, machine, 'cache')
    cfg.rootCacheDir = join(root, machine, 'root-cache')
    // Native bind construction is covered separately; this fixture never opens real host auth.
    for (const spec of Object.values(cfg.subvolumes)) spec.paths = []
    cfg.sqlite.stagingDir = join(root, machine, 'stage')
    cfg.sqlite.otherDirs = []
    cfg.sqlite.recoveryPaths = []
    cfg.sqlite.standbyWork = []
    const state = emptyState()
    state.points = Object.values(cfg.subvolumes).map((spec) => ({
      source: spec.mount,
      snapshot: `/frozen${spec.mount}`,
      target: '/target',
      dataAt: when.toISOString(),
    }))
    const unowned =
      machine === cfg.workstation ? 'pve-vm-180-app-recovery' : 'blackbox-vault-archive'
    const key = copyKey(unowned, 'drive')
    state.copies[key] = {
      source: unowned,
      target: 'drive',
      snapshot: 'a'.repeat(64),
      error: 'Old unrelated failure',
    }
    const previous = structuredClone(state.copies[key])
    const selected: string[] = []
    const called: string[][] = []
    jobs.set(machine, selected)
    const run: Runtime['run'] = async (argv) => {
      called.push(argv)
      if (argv.includes('backup')) {
        const tag = argv.find((arg) => arg.startsWith('job:'))
        selected.push(tag?.slice(4) ?? '')
        return {
          code: 0,
          out: JSON.stringify({
            message_type: 'summary',
            snapshot_id: 'b'.repeat(64),
            total_bytes_processed: 32,
          }),
          err: '',
        }
      }
      if (argv.includes('--request')) {
        const request = JSON.parse(argv.at(-1) as string)
        return {
          code: 0,
          out: JSON.stringify({
            source_id: request.source_id,
            backup_id: request.backup_id,
            status: 'skipped',
            reason: 'guest_stopped',
          }),
          err: '',
        }
      }
      if (argv.at(-1) === 'thinpool') return { code: 0, out: '15', err: '' }
      if (argv.includes('-G')) return { code: 0, out: 'hostname pve.test\nuser root\n', err: '' }
      if (argv.at(-1) === 'guests')
        return {
          code: 0,
          out: JSON.stringify(
            [190, 191, 100, 180, 210].map((vmid) => ({
              vmid,
              type: vmid < 200 && vmid >= 190 ? 'lxc' : 'qemu',
              status: 'running',
              node: 'gem',
            })),
          ),
          err: '',
        }
      if (argv.at(-1)?.endsWith('notes.db'))
        return { code: 0, out: String(when.getTime() / 1000), err: '' }
      return { code: 0, out: '', err: '' }
    }
    return { machine, cfg, state, previous, key, run, called }
  })
  const outcomes = await Promise.all(
    controllers.map(async ({ machine, cfg, state, run }) =>
      driveBackup({ cfg, run, now: () => when }, state, machine, () => {}),
    ),
  )
  expect(
    controllers.flatMap(({ state, key }) =>
      Object.entries(state.copies).filter(([id, copy]) => id !== key && copy.error),
    ),
  ).toEqual([])
  expect(outcomes).toEqual([true, true])
  const workstationJobs = jobs.get('davion-sidarli') ?? []
  const gemJobs = jobs.get('aico') ?? []
  expect(workstationJobs.some((id) => id.startsWith('pve-'))).toBe(false)
  expect(gemJobs).toEqual(
    expect.arrayContaining(
      migrated.sources.filter((s) => s.enabled && s.path.startsWith('proxmox://')).map((s) => s.id),
    ),
  )
  expect(workstationJobs.filter((id) => gemJobs.includes(id))).toEqual([])
  for (const { state, key, previous } of controllers) expect(state.copies[key]).toEqual(previous)
  const gem = controllers.find(
    (controller) => controller.machine === 'aico',
  ) as (typeof controllers)[number]
  expect(gem.called).not.toContainEqual(gem.cfg.remoteSqlite.snapshotCommand)
  expect(gem.called).not.toContainEqual(gem.cfg.remoteSqlite.timeCommand)
  const archives = gem.called
    .filter((argv) => argv.includes('--stdin-filename'))
    .map((argv) => argv[argv.indexOf('--stdin-filename') + 1])
  expect(archives).toEqual(
    expect.arrayContaining(['files-qemu-100.tar', 'files-qemu-180.tar', 'files-qemu-210.tar']),
  )
  expect(archives.some((name) => name?.endsWith('.gz'))).toBe(false)
  expect(gem.called.filter((argv) => argv.at(-1) === 'thinpool')).toHaveLength(3)
})

it('a later guard pause does not hide an earlier genuine source failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aico-backup-partial-'))
  roots.push(root)
  const cfg = config({ AICO_BACKUP_MACHINE: 'aico' })
  cfg.driveClients.aico.guests = ['pve-cluster-config', 'pve-ct-191-jobinator-data']
  cfg.schedule.copyFailSettleSeconds = 0
  cfg.cacheDir = join(root, 'cache')
  cfg.sqlite.stagingDir = join(root, 'stage')
  cfg.sqlite.otherDirs = []
  cfg.sqlite.recoveryPaths = []
  cfg.sqlite.standbyWork = []
  const data = join(root, 'data')
  mkdirSync(data)
  const db = openDatabase(join(data, 'notes.db'), [])
  db.exec('CREATE TABLE synthetic(value TEXT)')
  db.close()
  vi.stubEnv('AICO_DATA_DIR', data)
  vi.stubEnv('XDG_RUNTIME_DIR', root)
  const state = emptyState(),
    id = 'pve-ct-191-jobinator-data'
  const previous = {
    source: id,
    target: 'drive' as const,
    snapshot: 'a'.repeat(64),
    dataAt: '2026-11-01T00:00:00Z',
    observed: 'ok' as const,
  }
  state.copies[copyKey(id, 'drive')] = previous
  let copies = 0
  const run: Runtime['run'] = async (argv) => {
    if (argv.includes('backup')) {
      copies++
      return {
        code: 1,
        out: '',
        err: copies === 1 ? 'real network problem' : 'Fatal: command failed: exit status 75',
      }
    }
    if (argv.includes('-G')) return { code: 0, out: 'hostname pve.test\nuser root\n', err: '' }
    if (argv.at(-1) === 'guests')
      return {
        code: 0,
        out: JSON.stringify([{ vmid: 191, type: 'lxc', status: 'running' }]),
        err: '',
      }
    return { code: 0, out: '', err: '' }
  }
  expect(
    await driveBackup(
      { cfg, run, now: () => new Date('2026-11-08T20:00:00Z') },
      state,
      'aico',
      () => {},
    ),
  ).toBe(false)
  expect(state.copies['drive/pve-cluster-config']?.error).toContain('real network problem')
  expect(state.copies[copyKey(id, 'drive')]).toEqual(previous)
  expect(copies).toBe(2)
})
