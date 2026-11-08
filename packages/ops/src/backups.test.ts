import { createHash } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseRow } from '@aico/status'
import { openDatabase, snapshotDatabase } from '@aico/store'
import { afterEach, expect, it, vi } from 'vitest'
import {
  backupJob,
  copiedDataTime,
  hostReadsStoppedDisk,
  payloadTime,
  prepareFolder,
  volumeJobs,
} from './backup-drive'
import { observeExternal } from './backup-external'
import { beginBootCapture, expiredCapture, nativeOperation, preserveNative } from './backup-native'
import {
  backupRows,
  config,
  copyKey,
  emptyState,
  entries,
  entry,
  homePath,
  markUnplugged,
  migrated,
} from './backup-plan'
import {
  captureWorkspace,
  deleteWorkPoint,
  type RetentionView,
  retentionSelection,
  snapshotSweep,
} from './backup-retention'
import { copyRootAuth, type Runtime, readState, restic, saveState } from './backup-runtime'
import {
  nativePath,
  report,
  requestBackup,
  restoreFiles,
  runBackup,
  scheduledEntries,
  scratchDestination,
  snapshotLines,
  snapshotsFor,
  validateScheduledTarget,
} from './backups'

const dirs: string[] = []
const temp = () => {
  const p = mkdtempSync(join(tmpdir(), 'aico-backups-'))
  dirs.push(p)
  return p
}
afterEach(() => {
  for (const p of dirs.splice(0)) rmSync(p, { recursive: true, force: true })
})
const now = Date.parse('2026-11-04T20:00:00Z')
const cfg = () => {
  const c = config({})
  c.stateDir = temp()
  c.scratchRoot = temp()
  return c
}
const ok = (_argv: string[]) => Promise.resolve({ code: 0, out: '', err: '' })
it('migrates all 67 source records, both backend records and the three external checks, preserving paths and excludes', () => {
  expect(migrated.sources).toHaveLength(67)
  expect(migrated.backends).toHaveLength(2)
  expect(migrated.external).toHaveLength(3)
  expect(migrated.sources.find((s) => s.id === 'pve-ct-190-aico-data')?.path).toContain(
    'aico-snapshot',
  )
  const excludes = readFileSync(new URL('../data/backup.excludes', import.meta.url), 'utf8')
  for (const line of [
    'node_modules',
    '.venv',
    '/srv/workspaces/.snapshots',
    '/home/*/.summitflow/services',
    '.cache',
  ])
    expect(excludes.split('\n')).toContain(line)
  expect(config({}).retention.drive).toEqual({
    daily: 7,
    weekly: 4,
    monthly: 3,
    legacyDays: 30,
    legacyAfterGoodRuns: 3,
  })
})
it('plans host reads from verified frozen points at their real paths', () => {
  const c = cfg(),
    s = emptyState()
  s.points = Object.values(c.subvolumes).map((spec) => ({
    source: spec.mount,
    snapshot: `/frozen${spec.mount}`,
    target: `/target${spec.mount}`,
    dataAt: new Date(now).toISOString(),
  }))
  const jobs = volumeJobs(c, s)
  expect(jobs.find((j) => j.id === 'workspaces')?.binds).toEqual([
    ['/frozen/srv/workspaces', '/srv/workspaces'],
  ])
  expect(jobs.find((j) => j.id === 'root')?.paths).toContain('/etc')
  expect(() => volumeJobs(c, emptyState())).toThrow('No verified native snapshot')
})
it('freshness uses saved payload age, even after a successful upload today', () => {
  const p = temp()
  writeFileSync(join(p, 'old.sql'), 'backup')
  const old = new Date(now - 5 * 86400000)
  utimesSync(join(p, 'old.sql'), old, old)
  expect(payloadTime(p)).toBe(old.toISOString())
  const dataAt = copiedDataTime(new Date(now).toISOString(), payloadTime(p))
  expect(dataAt).toBe(old.toISOString())
  const row = entry(
    'db',
    'Database',
    'drive',
    { source: 'db', target: 'drive', dataAt, attemptedAt: new Date(now).toISOString() },
    config({}),
    'test',
    now,
  )
  expect(row.state).toBe('warn')
  expect(row.meaning).toContain('5 days')
  writeFileSync(
    join(p, 'manifest.json'),
    JSON.stringify({ completed_at: new Date(now - 2 * 86400000).toISOString() }),
  )
  expect(payloadTime(p)).toBe(new Date(now - 2 * 86400000).toISOString())
})
it('never treats a failed run or a job timestamp as new restorable data', () => {
  const c = cfg(),
    s = emptyState()
  s.copies[copyKey('workspaces', 'drive')] = {
    source: 'workspaces',
    target: 'drive',
    dataAt: new Date(now - 5 * 86400000).toISOString(),
    error: 'Copy failed',
    attemptedAt: new Date(now).toISOString(),
  }
  const rows = backupRows(entries(s, c, c.workstation, now))
  expect(rows.every((r) => parseRow(r))).toBe(true)
  const aico = rows.find((r) => r.id.endsWith('/drive/aico'))
  expect(aico?.state).toBe('failed')
  expect(aico?.last_run).toBe(new Date(now - 5 * 86400000).toISOString())
  expect(rows.every((r) => r.actions?.every((a) => !a.owner_only))).toBe(true)
})
it('shows the T7 rows off while the drive is unplugged, never late or failed', () => {
  const c = cfg(),
    s = emptyState()
  s.copies[copyKey('/', 'native')] = {
    source: '/',
    target: 'native',
    dataAt: new Date(now - 30 * 3600000).toISOString(),
    error: 'The T7 Btrfs backup drive is not mounted.',
    attemptedAt: new Date(now).toISOString(),
  }
  const items = entries(s, c, c.workstation, now)
  markUnplugged(items, false)
  const native = items.filter((e) => e.target === 'native')
  expect(native.length).toBeGreaterThan(0)
  expect(native.every((e) => e.state === 'off' && e.nextRun === null)).toBe(true)
  expect(items.filter((e) => e.target !== 'native').every((e) => e.state !== 'off' || e.gone)).toBe(
    true,
  )
  const plugged = entries(s, c, c.workstation, now)
  markUnplugged(plugged, true)
  expect(plugged.some((e) => e.target === 'native' && e.state === 'failed')).toBe(true)
})
it('gets next-run and running state from the real scheduler; unavailable is unknown', async () => {
  const c = cfg(),
    s = emptyState()
  const run = vi.fn(async (_argv: string[]) => ({
    code: 0,
    out: JSON.stringify([
      {
        kind: 'backups-drive',
        state: { nextRun: now, leaseId: 'a', leaseExpires: Date.now() + 100000 },
      },
    ]),
    err: '',
  }))
  const before = Date.now()
  const list = await scheduledEntries(s, c, c.workstation, run)
  // A running job's due time is the one it started at; the row is due a period after now instead.
  const drive = list.find((r) => r.target === 'drive')
  expect(Date.parse(drive?.nextRun as string)).toBeGreaterThanOrEqual(before + 1440 * 60000)
  expect(drive?.running).toBe(true)
  expect(list.find((r) => r.target === 'append')?.nextRun).toBeNull()
  const idleRun = async (_argv: string[]) => ({
    code: 0,
    out: JSON.stringify([
      { kind: 'backups-drive', state: { nextRun: now, leaseId: null, leaseExpires: null } },
    ]),
    err: '',
  })
  const idle = (await scheduledEntries(s, c, c.workstation, idleRun)).find(
    (r) => r.target === 'drive',
  )
  expect(idle?.nextRun).toBe(new Date(now).toISOString())
  expect(idle?.running).toBe(false)
})
const view = (id: string, hours: number, extra: Partial<RetentionView> = {}): RetentionView => ({
  id,
  name: null,
  project_id: 'aico',
  repo_root: '/some/project',
  scope_path: '/some/project',
  scope_type: 'project',
  scope_name: 'aico',
  snapshot_path: `/points/${id}`,
  branch: 'main',
  head_oid: 'a',
  head_ref: 'refs/heads/main',
  git_dir: '/some/project/.git',
  index_artifact_path: null,
  created_at: new Date(now - hours * 3600000).toISOString(),
  backend: 'btrfs',
  source: 'auto-periodic',
  last_restored_at: null,
  capture_root: '/some',
  project_relative_path: 'project',
  unfinished: false,
  ...extra,
})
it('keeps recent/hourly/daily points, pins, unclassified work, recovery copies, and every shared view hold', () => {
  const c = config({})
  const points = [
    view('latest', 1),
    view('recent', 5),
    view('hour', 10.1),
    view('same-hour', 10.2),
    view('day', 30),
    view('old', 200),
    view('pin', 200, { pin_reason: 'owner' }),
    view('unknown', 200, { unfinished: null }),
    view('recovery', 200, { recovery_copies: [{}] }),
    view('unfinished', 20, { unfinished: true }),
  ]
  expect(retentionSelection(points, c.retention.snapshot, now)).toEqual([
    '/points/old',
    '/points/same-hour',
  ])
  expect(
    retentionSelection(
      [...points, view('old', 200, { project_id: 'another', pin_reason: 'owner' })],
      c.retention.snapshot,
      now,
    ),
  ).not.toContain('/points/old')
})
it('disk pressure keeps only the newest few points plus held ones, and takes no new point', async () => {
  const c = config({})
  const points = [
    view('latest', 1),
    view('recent', 2),
    view('hour', 3),
    view('day', 30),
    view('old', 200),
    view('pin', 300, { pin_reason: 'owner' }),
  ]
  expect(c.retention.snapshot.pressureKeep).toBe(3)
  expect(retentionSelection(points, c.retention.snapshot, now, true)).toEqual([
    '/points/old',
    '/points/day',
  ])
  vi.stubEnv('HOME', mkdtempSync(join(tmpdir(), 'aico-pressure-')))
  const run = vi.fn(ok)
  expect(await snapshotSweep({ cfg: cfg(), run, now: () => new Date(now) }, true, true)).toBe(0)
  expect(run).not.toHaveBeenCalled()
  vi.unstubAllEnvs()
})
it('retention safeguards keep unexpected large native expiry plans untouched', () => {
  const existing = Array.from({ length: 14 }, (_, i) => `home.${i}`)
  expect(preserveNative(existing, existing.slice(0, 2))).toBe(false)
  expect(preserveNative(existing, existing.slice(0, 8))).toBe(true)
})
it('restores only to a new scratch path, refusing traversal, symlinks and existing destinations', () => {
  const root = temp(),
    outside = temp()
  expect(scratchDestination(root, join(root, 'new'))).toBe(join(root, 'new'))
  for (const p of [root, outside, join(root, '..', 'escape')])
    expect(() => scratchDestination(root, p)).toThrow()
  symlinkSync(outside, join(root, 'link'))
  expect(() => scratchDestination(root, join(root, 'link', 'new'))).toThrow()
  mkdirSync(join(root, 'used'))
  expect(() => scratchDestination(root, join(root, 'used'))).toThrow()
})
it('maps a registered project back to its containing Drive snapshot, and refuses an unrelated snapshot', async () => {
  const c = cfg(),
    id = 'a'.repeat(64),
    run = vi.fn(async (_argv: string[]) => ({
      code: 0,
      out: JSON.stringify([{ id, time: new Date(now).toISOString(), paths: ['/srv/workspaces'] }]),
      err: '',
    })),
    rt: Runtime = { cfg: c, run, now: () => new Date(now) }
  expect(await snapshotsFor(rt, 'drive', 'aico')).toHaveLength(1)
  expect(run.mock.calls[0]?.[0]).toContain('source:workspaces')
  await expect(
    restoreFiles(
      rt,
      'drive',
      'aico',
      'b'.repeat(64),
      '/srv/workspaces/projects/aico',
      join(c.restoreRoot, 'unused'),
    ),
  ).rejects.toThrow('does not belong')
})
it('takes consistent copies of uncheckpointed SQLite WAL without changing the source schema', () => {
  const root = temp(),
    source = join(root, 'notes.db'),
    dest = join(root, 'snapshot.db')
  const db = openDatabase(source, ['CREATE TABLE notes (body TEXT)'])
  db.exec("INSERT INTO notes VALUES ('saved in WAL')")
  snapshotDatabase(source, dest)
  const copy = openDatabase(dest, ['CREATE TABLE notes (body TEXT)'])
  expect(copy.prepare('SELECT body FROM notes').get()?.body).toBe('saved in WAL')
  copy.close()
  expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(1)
  db.close()
})

it('the scheduled verification job can enter its standalone unit before disabling the old verification timer', () => {
  expect(() => validateScheduledTarget('verify')).not.toThrow()
  const jobs = JSON.parse(
    readFileSync(new URL('../../jobs/data/jobs.json', import.meta.url), 'utf8'),
  ) as { jobs: { kind: string; run: { command?: string[] } }[] }
  expect(jobs.jobs.find((j) => j.kind === 'backups-verify')?.run.command).toContain('verify')
})
it('Run now on gem selects its own append-only lease even with the workstation unavailable', async () => {
  const c = cfg(),
    run = vi.fn(async (_argv: string[]) => ({ code: 0, out: '', err: '' })),
    rt: Runtime = { cfg: c, run, now: () => new Date(now) }
  await requestBackup(rt, 'aico', 'append')
  expect(run.mock.calls[0]?.[0]).toEqual(['aico', 'jobs', 'run', 'backups-append-aico'])
})

it('migration does not call a newly uploaded stale folder fresh', () => {
  const c = cfg(),
    legacy = temp()
  c.legacyDriveState = legacy
  c.legacyHostState = temp()
  writeFileSync(
    join(legacy, 'state.json'),
    JSON.stringify({
      jobs: {
        'ominull-production-state': {
          time: new Date(now).toISOString(),
          snapshot_id: 'a'.repeat(64),
        },
      },
    }),
  )
  const imported = readState(c).copies[copyKey('ominull-production-state', 'drive')]
  expect(imported?.dataAt).toBeUndefined()
})
it('all aliases of one physical point share pinned and recovery holds', () => {
  const root = temp(),
    physical = join(root, 'physical'),
    alias = join(root, 'alias')
  mkdirSync(physical)
  symlinkSync(physical, alias)
  const old = view('old', 200, { snapshot_path: physical }),
    pinned = view('alias', 200, { snapshot_path: alias, pin_reason: 'owner' }),
    latest = view('latest', 1)
  expect(
    retentionSelection([latest, old, pinned], config({}).retention.snapshot, now),
  ).not.toContain(physical)
})
it('an independent guard cannot overwrite a concurrently completed data copy', async () => {
  const c = cfg(),
    old = emptyState()
  saveState(c, old)
  let finish: (value: { code: number; out: string; err: string }) => void = () => {}
  const waiting = new Promise<{ code: number; out: string; err: string }>((resolve) => {
    finish = resolve
  })
  const rt: Runtime = { cfg: c, run: () => waiting, now: () => new Date(now) }
  const running = runBackup(rt, old, 'guard', c.workstation, false)
  const fresh = readState(c)
  fresh.copies['drive/new'] = {
    source: 'new',
    target: 'drive',
    dataAt: new Date(now).toISOString(),
  }
  saveState(c, fresh)
  finish({ code: 0, out: '', err: '' })
  await running
  expect(readState(c).copies['drive/new']?.dataAt).toBe(new Date(now).toISOString())
})
it('Proxmox snapshots keep the restorable archive path instead of the source URI', async () => {
  const c = cfg(),
    id = 'a'.repeat(64),
    run = vi.fn(async (_argv: string[]) => ({
      code: 0,
      out: JSON.stringify([
        { id, time: new Date(now).toISOString(), paths: ['/files-lxc-190.tar'] },
      ]),
      err: '',
    })),
    rt: Runtime = { cfg: c, run, now: () => new Date(now) }
  expect((await snapshotsFor(rt, 'drive', 'pve-ct-190-aico-data'))[0]?.paths).toEqual([
    '/files-lxc-190.tar',
  ])
})
it('source refresh qualifies its previous generation only against a confirmed Drive copy', async () => {
  const c = cfg(),
    folder = temp(),
    source = 'ominull-production-state',
    completed = new Date(now - 3600000).toISOString()
  writeFileSync(
    join(folder, 'manifest.json'),
    JSON.stringify({
      completed_at: completed,
      source_id: source,
      backup_id: 'bkp-previous',
      sha256: 'b'.repeat(64),
    }),
  )
  const state = emptyState()
  state.copies[copyKey(source, 'drive')] = {
    source,
    target: 'drive',
    snapshot: 'a'.repeat(64),
    dataAt: completed,
    attemptedAt: completed,
    copiedAt: new Date(now - 1800000).toISOString(),
  } as (typeof state.copies)[string]
  const run = vi.fn(async (argv: string[]) => {
    const req = JSON.parse(argv.at(-1) as string)
    return {
      code: 0,
      out: JSON.stringify({
        status: 'skipped',
        reason: 'guest_stopped',
        source_id: source,
        backup_id: req.backup_id,
      }),
      err: '',
    }
  })
  const rt: Runtime = { cfg: c, run, now: () => new Date(now) }
  await prepareFolder(rt, { id: source, paths: [folder], binds: [], dataAt: completed }, state)
  const req = JSON.parse(run.mock.calls[0]?.[0].at(-1) as string)
  expect(req.qualified_previous).toMatchObject({
    backup_id: 'bkp-previous',
    sha256: 'b'.repeat(64),
    snapshot_id: 'a'.repeat(64),
  })
})

it('gem has one append copy and the workstation owns its single real Drive receipt', () => {
  const c = cfg(),
    s = emptyState()
  s.copies[copyKey(c.remoteSqlite.source, 'drive')] = {
    source: c.remoteSqlite.source,
    target: 'drive',
    dataAt: new Date(now).toISOString(),
  }
  expect(entries(s, c, 'aico', now).filter((e) => e.target === 'drive')).toHaveLength(0)
  expect(
    entries(s, c, c.workstation, now).filter(
      (e) => e.source === c.remoteSqlite.source && e.target === 'drive',
    ),
  ).toHaveLength(1)
})
it('gem backs itself up to its own Drive repository with its own login, reported from gem', async () => {
  const c = config({ AICO_BACKUP_MACHINE: 'aico' })
  c.stateDir = temp()
  c.scratchRoot = temp()
  expect(c.drive?.repository).toBe('rclone:aico-notes-drive:SummitFlow-Aico-gem-backup')
  const drive = entries(emptyState(), c, 'aico', now).filter((e) => e.target === 'drive')
  expect(drive.map((e) => [e.id, e.name])).toEqual([
    ['drive/aico-aico', 'Aico databases and photos'],
  ])
  // The workstation's Drive repository is not touched by gem's config, and gem's is not the workstation's.
  expect(config({ AICO_BACKUP_MACHINE: 'davion-sidarli' }).drive).toBeUndefined()
  const run = vi.fn(async (_argv: string[], _options?: { env?: NodeJS.ProcessEnv }) => ({
    code: 0,
    out: '[]',
    err: '',
  }))
  await restic({ cfg: c, run, now: () => new Date(now) }, 'drive', ['snapshots'])
  const argv = run.mock.calls[0]?.[0] as string[]
  expect(argv[argv.indexOf('--repo') + 1]).toBe(c.drive?.repository)
  expect(argv[argv.indexOf('--password-file') + 1]).toBe(homePath(c.drive?.passwordFile as string))
  expect(run.mock.calls[0]?.[1]?.env?.RCLONE_CONFIG).toBe(homePath(c.drive?.rcloneConfig as string))
})
it('a native volume root restores into scratch and success includes a byte comparison', async () => {
  const c = cfg(),
    source = temp(),
    target = temp(),
    to = join(target, 'restore')
  c.restoreRoot = target
  writeFileSync(join(source, 'proof.txt'), 'saved data')
  const state = emptyState()
  state.points = [
    { source: '/home', snapshot: source, target: source, dataAt: new Date(now).toISOString() },
  ]
  saveState(c, state)
  const run = vi.fn(async (argv: string[]) => {
    if (argv.includes('realpath')) return { code: 0, out: `${argv.at(-1)}\n`, err: '' }
    if (argv.includes('mkdir')) mkdirSync(argv.at(-1) as string, { recursive: true })
    if (argv.includes('cp'))
      cpSync(argv.at(-2) as string, argv.at(-1) as string, { recursive: true })
    return { code: 0, out: '', err: '' }
  })
  await restoreFiles(
    { cfg: c, run, now: () => new Date(now) },
    'native',
    'home',
    source.split('/').at(-1) as string,
    '/home',
    to,
  )
  expect(readFileSync(join(to, 'home', 'proof.txt'), 'utf8')).toBe('saved data')
  expect(run.mock.calls.some(([argv]) => argv.includes('diff'))).toBe(true)
})
it('a refreshed read-only runtime auth copy is replaced without changing its source', () => {
  const root = temp(),
    from = join(root, 'fixture'),
    to = join(root, 'runtime')
  writeFileSync(from, 'fixture only')
  copyRootAuth(from, to)
  chmodSync(to, 0o400)
  expect(() => copyRootAuth(from, to)).not.toThrow()
  expect(readFileSync(from, 'utf8')).toBe('fixture only')
})
it('the package proof starts before boot copying can change the package state', async () => {
  const c = cfg(),
    path = join(temp(), 'package-status')
  c.packageStatusPath = path
  writeFileSync(path, 'before')
  const run = vi.fn(async (_argv: string[]) => {
    writeFileSync(path, 'after')
    return { code: 0, out: '', err: '' }
  })
  const digest = await beginBootCapture({ cfg: c, run, now: () => new Date(now) }, 'fixture')
  expect(digest).toBe(createHash('sha256').update('before').digest('hex'))
})
it('a registered ordinary project without a manifest receives a first frozen view', async () => {
  const root = temp(),
    project = join(root, 'projects', 'ordinary'),
    catalogue = temp()
  mkdirSync(join(project, '.git'), { recursive: true })
  const all: { path: string; entries: RetentionView[] }[] = []
  const run = vi.fn(async (argv: string[]) => {
    if (argv[0] === 'aico')
      return { code: 0, out: JSON.stringify([{ id: 'ordinary', root_path: project }]), err: '' }
    if (argv[0] === 'btrfs' && argv.includes('snapshot')) {
      mkdirSync(join(argv.at(-1) as string, 'projects/ordinary/.git'), { recursive: true })
    }
    return { code: 0, out: argv.includes('rev-parse') ? 'a'.repeat(40) : '', err: '' }
  })
  await captureWorkspace({ cfg: cfg(), run, now: () => new Date(now) }, all, { root, catalogue })
  expect(
    all.some((m) =>
      m.entries.some((e) => e.project_id === 'ordinary' && e.source === 'auto-periodic'),
    ),
  ).toBe(true)
})
it('saved edits arriving at capture are classified from the frozen tree', async () => {
  const root = temp(),
    project = join(root, 'projects', 'ordinary'),
    catalogue = temp()
  mkdirSync(join(project, '.git'), { recursive: true })
  const previous = view('prior', 30, {
    project_id: 'ordinary',
    repo_root: project,
    scope_path: project,
  })
  const all = [
    { path: join(catalogue, 'ordinary', 'project-ordinary', 'manifest.json'), entries: [previous] },
  ]
  mkdirSync(join(catalogue, 'ordinary', 'project-ordinary'), { recursive: true })
  writeFileSync(all[0]?.path as string, JSON.stringify([previous]))
  const run = vi.fn(async (argv: string[]) => {
    if (argv[0] === 'aico')
      return { code: 0, out: JSON.stringify([{ id: 'ordinary', root_path: project }]), err: '' }
    if (argv[0] === 'btrfs' && argv.includes('snapshot'))
      mkdirSync(join(argv.at(-1) as string, 'projects/ordinary/.git'), { recursive: true })
    return {
      code: 0,
      out:
        argv.includes('status') && argv.some((p) => p.includes('aico-autosnap'))
          ? ' M saved.txt'
          : argv.includes('rev-parse')
            ? 'a'.repeat(40)
            : '',
      err: '',
    }
  })
  await captureWorkspace({ cfg: cfg(), run, now: () => new Date(now) }, all, { root, catalogue })
  expect(all[0]?.entries.at(-1)?.unfinished).toBe(true)
})
it('an omitted nested project cannot be published as a completed snapshot view', async () => {
  const root = temp(),
    project = join(root, 'projects', 'nested'),
    catalogue = temp()
  mkdirSync(join(project, '.git'), { recursive: true })
  const previous = view('prior', 30, {
    project_id: 'nested',
    repo_root: project,
    scope_path: project,
  })
  const all = [
    { path: join(catalogue, 'nested', 'project-nested', 'manifest.json'), entries: [previous] },
  ]
  mkdirSync(join(catalogue, 'nested', 'project-nested'), { recursive: true })
  writeFileSync(all[0]?.path as string, JSON.stringify([previous]))
  const run = vi.fn(async (argv: string[]) => {
    if (argv[0] === 'aico')
      return { code: 0, out: JSON.stringify([{ id: 'nested', root_path: project }]), err: '' }
    if (argv[0] === 'btrfs' && argv.includes('snapshot'))
      mkdirSync(argv.at(-1) as string, { recursive: true })
    return { code: 0, out: argv.includes('rev-parse') ? 'a'.repeat(40) : '', err: '' }
  })
  await captureWorkspace({ cfg: cfg(), run, now: () => new Date(now) }, all, {
    root,
    catalogue,
  }).catch(() => {})
  expect(all[0]?.entries.slice(1).some((e) => e.source === 'auto-periodic')).toBe(false)
})

it('a proven unchanged offline guest keeps its old data age without becoming late', () => {
  const dataAt = new Date(now - 200 * 3600000).toISOString(),
    since = new Date(now - 199 * 3600000).toISOString()
  const row = entry(
    'guest',
    'Guest data',
    'drive',
    { source: 'guest', target: 'drive', dataAt, offlineSince: since },
    config({}),
    'host',
    now,
  )
  expect(row.state).toBe('ok')
  expect(row.dataAt).toBe(dataAt)
  expect(row.meaning).toContain('off')
})
it('offline freshness proof is carried only from a successful copy, never a failed observation', async () => {
  const c = cfg(),
    state = emptyState(),
    id = 'guest',
    rt: Runtime = {
      cfg: c,
      run: async () => ({ code: 0, out: '', err: '' }),
      now: () => new Date(now),
    }
  state.copies[copyKey(id, 'drive')] = {
    source: id,
    target: 'drive',
    dataAt: new Date(now - 3600000).toISOString(),
    snapshot: 'a'.repeat(64),
    error: 'Last capture failed',
  }
  expect(
    (
      await backupJob(rt, state, {
        id,
        paths: [],
        binds: [],
        dataAt: new Date(now).toISOString(),
        offline: true,
      })
    ).offlineSince,
  ).toBeUndefined()
})
it('a stale restic lock is recovered using the existing safe unlock protocol', async () => {
  const c = cfg(),
    run = vi.fn(async (argv: string[]) => ({
      code: argv.includes('snapshots') && run.mock.calls.length === 1 ? 11 : 0,
      out: '[]',
      err: '',
    }))
  const result = await restic({ cfg: c, run, now: () => new Date(now) }, 'append', ['snapshots'])
  expect(result.code).toBe(0)
  expect(run.mock.calls.some(([argv]) => argv.includes('unlock'))).toBe(true)
  expect(run).toHaveBeenCalledTimes(3)
})
it('native metadata expires only after every referenced retained point is gone', () => {
  const c = cfg(),
    id = '20261101T010000Z-1234abcd',
    target = join(c.nativeTarget, 'root.old')
  const receipt = {
    adapter: 'summitflow-btrbk-v1',
    run_id: id,
    status: 'completed',
    target: c.nativeTarget,
    boot_path: join(c.nativeTarget, '..', 'summitflow-host-recovery', 'captures', id, 'boot'),
    points: [{ target }],
  }
  expect(expiredCapture(receipt, c, new Set(), id)).toBe(false)
  expect(expiredCapture(receipt, c, new Set([target]), 'other')).toBe(false)
  expect(expiredCapture(receipt, c, new Set(), 'other')).toBe(true)
  expect(expiredCapture({ ...receipt, points: [] }, c, new Set(), 'other')).toBe(false)
  expect(expiredCapture({ ...receipt, adapter: 'unknown' }, c, new Set(), 'other')).toBe(false)
})
it('retired and unregistered scopes follow the existing released-project retention rule', () => {
  const points = [
    view('latest', 1),
    view('retired', 200, { project_id: 'retired', source: 'manual' }),
  ]
  expect(
    retentionSelection(points, config({}).retention.snapshot, now, false, new Set(['retired'])),
  ).toContain('/points/retired')
})

it('scheduled work expiry uses the installed identity-checking helper and refuses recovery trees', async () => {
  const root = temp(),
    point = join(root, '.snapshots', 'p', 'projects', 'p', 'id'),
    c = cfg()
  mkdirSync(point, { recursive: true })
  const run = vi.fn(async (_argv: string[]) => ({ code: 0, out: 'ro=true', err: '' })),
    rt: Runtime = { cfg: c, run, now: () => new Date(now) }
  await deleteWorkPoint(rt, point, root)
  expect(run.mock.calls.some(([argv]) => argv.includes(c.workSnapshotDeleteHelper))).toBe(true)
  await expect(
    deleteWorkPoint(rt, join(root, '.snapshots', 'recoveries', 'p', 'id'), root),
  ).rejects.toThrow()
})
it('a removed legacy path is archived rather than borrowing a fresh whole-volume timestamp', () => {
  const c = cfg(),
    state = emptyState()
  state.copies['drive/workspaces'] = {
    source: 'workspaces',
    target: 'drive',
    dataAt: new Date(now).toISOString(),
    snapshot: 'a'.repeat(64),
  }
  const rows = entries(state, c, c.workstation, now, (source) => source.id !== 'a-term')
  const archived = rows.find((e) => e.source === 'a-term' && e.target === 'drive')
  expect(archived?.state).toBe('off')
  expect(archived?.dataAt).toBeNull()
  expect(
    backupRows(rows)
      .find((e) => e.id.endsWith('/drive/a-term'))
      ?.actions?.map((a) => a.kind),
  ).toEqual(['detail'])
})

it('native publication uses the installed helper staging contract', () => {
  const c = cfg(),
    id = '20261105T010000Z-1234abcd'
  expect(nativeOperation(c, id)).toBe(join(homePath(c.legacyHostState), 'operations', id))
})
it('legacy retirement keeps the already qualified successful-run count across migration', () => {
  const c = cfg()
  c.legacyDriveState = temp()
  c.legacyHostState = temp()
  writeFileSync(
    join(c.legacyDriveState, 'state.json'),
    JSON.stringify({
      runs: [{ status: 'ok' }, { status: 'failed' }, { status: 'ok' }, { status: 'ok' }],
    }),
  )
  expect(readState(c)).toMatchObject({ goodDriveRuns: 3 })
})
it('publishes receipts when the local web service is still starting', async () => {
  const c = cfg()
  c.statusPublish.waitMs = 0
  const send = vi
    .fn()
    .mockRejectedValueOnce(
      Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }),
    )
    .mockResolvedValue({ ok: true })
  vi.stubGlobal('fetch', send)
  try {
    await expect(report(c, emptyState(), c.workstation, ok)).resolves.toBeUndefined()
    expect(send.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2)
  } finally {
    vi.unstubAllGlobals()
  }
})
it('drops backup rows no plan entry writes any more, but not the restore drill or other machines', async () => {
  const c = cfg()
  const m = c.workstation
  const calls: { url: string; method: string; body?: { id: string }[] }[] = []
  vi.stubGlobal('fetch', async (url: URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    if (init?.method === 'POST' || init?.method === 'DELETE') return { ok: true }
    const posted = calls.find((call) => call.method === 'POST')?.body ?? []
    const kept = posted[0]?.id as string
    const rows = [kept, `${m}/backup/drive/a-term`, `${m}/backup/restore-drill`, 'other/backup/x']
    return { ok: true, json: async () => ({ rows: rows.map((id) => ({ id })) }) }
  })
  try {
    await report(c, emptyState(), m, ok)
    const deleted = calls
      .filter((call) => call.method === 'DELETE')
      .map((call) => new URL(call.url).searchParams.get('id'))
    expect(deleted).toEqual([`${m}/backup/drive/a-term`])
  } finally {
    vi.unstubAllGlobals()
  }
})
it('browses and restores a root-owned T7 tree without requiring caller traversal permission', async () => {
  const point = {
    source: '/srv/workspaces',
    target: '/root-only/received',
    snapshot: '/frozen',
    dataAt: new Date(now).toISOString(),
  }
  const run = vi.fn(async (argv: string[]) => ({ code: 0, err: '', out: `${argv.at(-1)}\n` }))
  const rt: Runtime = { cfg: cfg(), run, now: () => new Date(now) }
  await expect(
    nativePath(rt, point, '/srv/workspaces/projects/aico/project.identity.json'),
  ).resolves.toBe('/root-only/received/projects/aico/project.identity.json')
  expect(
    run.mock.calls.every(([argv]) => argv.slice(0, 4).join(' ') === 'sudo -n realpath -e'),
  ).toBe(true)
})
it('shows the stopped external backup owner as off with its last good artifact date and resumes normal checks', async () => {
  const c = cfg(),
    state = emptyState()
  const dataAt = '2026-10-20T12:00:00Z'
  state.copies['external/portfolio-ai-complete'] = {
    source: 'portfolio-ai-complete',
    target: 'drive',
    dataAt,
    error: 'Guest unreachable',
  }
  let status = 'stopped',
    statusCode = 0,
    artifactOk = false
  const run = vi.fn(async (argv: string[]) => {
    if (argv.includes('status')) return { code: statusCode, out: `status: ${status}\n`, err: '' }
    if (argv.includes('exec'))
      return artifactOk
        ? {
            code: 0,
            out: JSON.stringify({
              exitcode: 0,
              'out-data': `1792534517.1564229240,${Date.now() / 1000},1793669323.5744958790,`,
            }),
            err: '',
          }
        : { code: 1, out: '', err: 'guest unreachable' }
    return { code: 0, out: '[]', err: '' }
  })
  const stopped = (await scheduledEntries(state, c, c.workstation, run)).find(
    (e) => e.id === 'external/portfolio-ai-complete',
  )
  expect(stopped).toMatchObject({ state: 'off', dataAt, nextRun: null, running: false })
  expect(backupRows([stopped!])[0]?.state).toBe('off')
  expect(run.mock.calls.some(([argv]) => argv.includes('exec'))).toBe(false)
  state.copies['external/portfolio-ai-complete']!.observed = 'offline'
  status = 'running'
  const running = (await scheduledEntries(state, c, c.workstation, run)).find(
    (e) => e.id === 'external/portfolio-ai-complete',
  )
  expect(running?.state).toBe('failed')
  expect(running?.dataAt).toBe(dataAt)
  artifactOk = true
  const resumed = (await scheduledEntries(state, c, c.workstation, run)).find(
    (e) => e.id === 'external/portfolio-ai-complete',
  )
  expect(resumed?.state).toBe('ok')
  expect(resumed?.dataAt).not.toBe(dataAt)
  statusCode = 255
  expect(
    (await scheduledEntries(state, c, c.workstation, run)).find(
      (e) => e.id === 'external/portfolio-ai-complete',
    )?.state,
  ).toBe('failed')
  statusCode = 0
  status = 'unknown'
  expect(
    (await scheduledEntries(state, c, c.workstation, run)).find(
      (e) => e.id === 'external/portfolio-ai-complete',
    )?.state,
  ).toBe('failed')
})

it('the Jobinator snapshot row reads the container with pct exec, is off while it is stopped and ok once a snapshot is seen', async () => {
  const c = cfg(),
    state = emptyState()
  let status = 'stopped'
  const run = vi.fn(async (argv: string[]) => {
    if (argv.includes('status')) return { code: 0, out: `status: ${status}\n`, err: '' }
    if (argv.includes('exec') && argv.includes('191'))
      return { code: 0, out: `${Math.floor(Date.now() / 1000) - 600}.5,`, err: '' }
    return { code: 0, out: '[]', err: '' }
  })
  const row = async () =>
    (await scheduledEntries(state, c, c.workstation, run)).find(
      (e) => e.id === 'external/jobinator-snapshot',
    )
  expect(await row()).toMatchObject({ state: 'off', project: 'jobinator-4000' })
  expect(run.mock.calls.some(([argv]) => argv.includes('exec'))).toBe(false)
  await observeExternal({ cfg: c, run, now: () => new Date() }, state, ['jobinator-snapshot'])
  expect(state.copies['external/jobinator-snapshot']).toMatchObject({ observed: 'offline' })
  status = 'running'
  await observeExternal({ cfg: c, run, now: () => new Date() }, state, ['jobinator-snapshot'])
  expect(state.copies['external/jobinator-snapshot']).toMatchObject({ observed: 'ok' })
  expect((await row())?.state).toBe('ok')
})

it('asks every backup owner machine at once, so the listing waits for one ssh round trip, not the sum', async () => {
  const c = cfg(),
    state = emptyState()
  let active = 0,
    peak = 0
  const run = vi.fn(async (argv: string[]) => {
    active++
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 5))
    active--
    return { code: 0, out: argv.includes('status') ? 'status: stopped\n' : '[]', err: '' }
  })
  await observeExternal({ cfg: c, run, now: () => new Date() }, state)
  expect(peak).toBeGreaterThan(1)
})

it('a stopped VM or container file source is read from its disk by the host; whole guests are not', () => {
  expect(hostReadsStoppedDisk('qemu', ['qemu', '180', 'files'], 'agent')).toBe(true)
  expect(hostReadsStoppedDisk('lxc', ['lxc', '191', 'files'], 'pct')).toBe(true)
  expect(hostReadsStoppedDisk('lxc', ['lxc', '191'], null)).toBe(false)
  expect(hostReadsStoppedDisk('qemu', ['qemu', '180'], null)).toBe(false)
})

it('a copy read from a stopped VM is fresh, an unrefreshed one goes late, and neither is a failure', () => {
  const c = cfg(),
    fresh = new Date(now - 3600000).toISOString(),
    stale = new Date(now - (c.schedule.freshDriveHours + 1) * 3600000).toISOString()
  const row = (dataAt: string) =>
    entry(
      'vm',
      'VM',
      'drive',
      { source: 'vm', target: 'drive', dataAt, observed: 'ok' },
      c,
      c.workstation,
      now,
    )
  expect(row(fresh).state).toBe('ok')
  expect(row(stale).state).toBe('warn')
})

it('snapshots list the newest copies with the ids restore takes, and say how to see the rest', () => {
  const copies = Array.from({ length: 12 }, (_, i) => ({
    id: String(i).padStart(64, 'a'),
    time: new Date(Date.UTC(2026, 10, 12 - i)).toISOString(),
    paths: ['/x'],
  }))
  const text = snapshotLines(copies, 'aico', 'drive', false)
  expect(text).toContain('12 copies of aico')
  expect(text).toContain(copies[9]?.id)
  expect(text).not.toContain(copies[10]?.id)
  expect(text).toContain('2 older: add --all')
  expect(snapshotLines(copies, 'aico', 'drive', true)).toContain(copies[11]?.id)
  expect(snapshotLines([], 'aico', 'drive', false)).toContain('No copies of aico')
})
