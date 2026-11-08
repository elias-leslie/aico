// Selection is per physical point, as in the old autosnapshot timer. A view can only add a hold.
import { randomBytes } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statfsSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ops from '../data/ops.json' with { type: 'json' }
import { type BackupConfig, type BackupState, driveSpec, homePath, migrated } from './backup-plan'
import { checked, type Runtime, resticArgs, resticJson } from './backup-runtime'
import type { Point } from './snapshots'

export interface RetentionView extends Point {
  unfinished?: boolean | null
  recovery_active?: boolean
  pin_reason?: string | null
  pin_until?: string | null
  recovery_copies?: { deleted_at?: string }[]
}
const physicalKey = (path: string) => (existsSync(path) ? realpathSync(path) : resolve(path))
export function retentionSelection(
  entries: RetentionView[],
  policy: BackupConfig['retention']['snapshot'],
  now: number,
  pressure = false,
  released: ReadonlySet<string> = new Set(),
): string[] {
  const points = new Map<string, RetentionView[]>()
  for (const entry of entries) {
    const key = physicalKey(entry.snapshot_path)
    points.set(key, [...(points.get(key) ?? []), entry])
  }
  const created = (key: string) =>
    Math.min(...(points.get(key) ?? []).map((e) => Date.parse(e.created_at)))
  const newest = [...points.keys()].sort((a, b) => created(b) - created(a))
  const held = (e: RetentionView) =>
    e.unfinished == null ||
    e.recovery_active ||
    e.recovery_path ||
    (e.recovery_copies ?? []).some((c) => !c.deleted_at) ||
    (e.pin_reason && (!e.pin_until || Date.parse(e.pin_until) > now))
  const keep = new Set(newest.filter((key) => (points.get(key) ?? []).some(held)))
  for (const key of newest.slice(0, pressure ? Math.max(1, policy.pressureKeep) : 1)) keep.add(key)
  if (!pressure) {
    const hours = new Set<string>(),
      days = new Set<string>()
    for (const key of newest) {
      const at = created(key),
        age = now - at,
        stamp = new Date(at).toISOString(),
        hour = stamp.slice(0, 13),
        day = stamp.slice(0, 10)
      if (
        age <= policy.recentHours * 3600000 ||
        (age <= policy.hourlyHours * 3600000 && !hours.has(hour)) ||
        (age > policy.hourlyHours * 3600000 && age <= policy.dailyDays * 86400000 && !days.has(day))
      )
        keep.add(key)
      if (age <= policy.hourlyHours * 3600000) hours.add(hour)
      if (age <= policy.dailyDays * 86400000) days.add(day)
    }
    const scopes = new Map<string, RetentionView[]>()
    for (const e of entries) {
      if (released.has(e.project_id)) continue
      const scope = `${e.project_id}/${e.scope_type}/${e.scope_name}`
      scopes.set(scope, [...(scopes.get(scope) ?? []), e])
    }
    for (const views of scopes.values()) {
      views.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      for (const e of views
        .filter((e) => !e.source.startsWith('auto-'))
        .slice(0, policy.manualPerScope))
        keep.add(physicalKey(e.snapshot_path))
      const unfinished = views.find((e) => e.unfinished)
      if (unfinished && now - Date.parse(unfinished.created_at) <= policy.unfinishedDays * 86400000)
        keep.add(physicalKey(unfinished.snapshot_path))
      const last = views[0]
      if (
        last &&
        existsSync(dirname(last.scope_path)) &&
        !existsSync(last.scope_path) &&
        now - Date.parse(last.created_at) <= policy.archivedDays * 86400000
      )
        keep.add(physicalKey(last.snapshot_path))
    }
  }
  return newest
    .reverse()
    .filter((key) => !keep.has(key))
    .slice(0, policy.maxDeletes)
}
function manifests(
  root = homePath(ops.snapshots.catalogue),
): { path: string; entries: RetentionView[] }[] {
  if (!existsSync(root)) return []
  const result: { path: string; entries: RetentionView[] }[] = []
  for (const project of readdirSync(root, { withFileTypes: true }))
    if (project.isDirectory() && !project.isSymbolicLink())
      for (const scope of readdirSync(join(root, project.name), { withFileTypes: true }))
        if (scope.isDirectory() && !scope.isSymbolicLink()) {
          const path = join(root, project.name, scope.name, 'manifest.json')
          if (existsSync(path)) {
            const entries = JSON.parse(readFileSync(path, 'utf8')) as RetentionView[]
            if (!Array.isArray(entries))
              throw new Error('A snapshot catalogue cannot be read; retention was left alone.')
            result.push({ path, entries })
          }
        }
  return result
}
/**
 * Scheduled retention only. Unknown metadata and active recovery copies always preserve the point.
 * Under disk pressure (the space guard) no new point is taken and only the newest pressureKeep
 * points survive beside held ones, as SummitFlow's `autosnap prune --pressure` did.
 */
export async function snapshotSweep(
  rt: Runtime,
  scheduled: boolean,
  pressure = false,
): Promise<number> {
  const all = manifests()
  const active = pressure ? null : await captureWorkspace(rt, all)
  const released = new Set(
    active
      ? all.flatMap((m) => m.entries.map((e) => e.project_id)).filter((id) => !active.has(id))
      : [],
  )
  const points = all.flatMap((m) => m.entries)
  const allowed =
    scheduled || pressure
      ? retentionSelection(
          points,
          rt.cfg.retention.snapshot,
          rt.now().getTime(),
          pressure,
          released,
        )
      : []
  let deleted = 0
  for (const path of allowed) {
    const permitted = realpathSync(resolve(ops.snapshots.workspacesRoot, '.snapshots'))
    if (
      !path.startsWith(permitted + '/') ||
      !existsSync(path) ||
      !realpathSync(path).startsWith(realpathSync(permitted) + '/')
    )
      continue
    if (
      (await checked(rt.run, ['btrfs', 'property', 'get', '-ts', path, 'ro'])).trim() !== 'ro=true'
    )
      continue
    // The same physical lock used by `aico snapshots` surrounds this whole scheduled sweep.
    if (deleted && deleted % rt.cfg.retention.snapshot.deleteBatch === 0)
      await settleWorkDeletion(rt)
    await deleteWorkPoint(rt, path)
    if (existsSync(path))
      throw new Error('The physical point remains; its catalogue entries are preserved.')
    deleted++
    for (const manifest of all) {
      manifest.entries = manifest.entries.filter((e) => physicalKey(e.snapshot_path) !== path)
      const temporary = manifest.path + `.${process.pid}.tmp`
      writeFileSync(temporary, JSON.stringify(manifest.entries, null, 2))
      renameSync(temporary, manifest.path)
    }
  }
  return deleted
}
function driveRetentionArgs(cfg: BackupConfig): string[] {
  const p = cfg.retention.drive
  return [
    'forget',
    '--tag',
    'offsite',
    '--group-by',
    'host,paths',
    '--keep-daily',
    String(p.daily),
    '--keep-weekly',
    String(p.weekly),
    '--keep-monthly',
    String(p.monthly),
  ]
}

const pointId = (at: string) =>
  at.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z') + '-' + randomBytes(4).toString('hex')
const SCRATCH_POINT = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-[0-9a-f]{8}$/
const freeBytes = (path: string) => {
  const disk = statfsSync(path)
  return disk.bavail * disk.bsize
}
/**
 * The scratch disk's few daily read-only points, so a mistaken delete there can be undone. They are a
 * convenience, not a backup: this looks only in its own folder, and failing or skipping never fails
 * the routine. Short of free space, or under the space guard's pressure, they all go and none is taken.
 * Returns how many it removed.
 */
export async function scratchSnapshots(
  rt: Runtime,
  scheduled: boolean,
  pressure = false,
  free = freeBytes,
): Promise<number> {
  const policy = rt.cfg.retention.scratch
  let deleted = 0
  try {
    const store = join(policy.root, '.snapshots', policy.store)
    let points = existsSync(store)
      ? readdirSync(store, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && SCRATCH_POINT.test(entry.name))
          .map((entry) => entry.name)
          .sort()
          .reverse()
      : []
    const short = pressure || free(policy.source) < policy.stopBelowGib * 1024 ** 3
    if (!short) {
      const newest = points[0]
      const taken = newest
        ? Date.parse(newest.replace(SCRATCH_POINT, '$1-$2-$3T$4:$5:$6Z'))
        : Number.NEGATIVE_INFINITY
      if (rt.now().getTime() - taken >= policy.everyHours * 3600000) {
        const id = pointId(rt.now().toISOString())
        mkdirSync(store, { recursive: true })
        await checked(rt.run, [
          'btrfs',
          'subvolume',
          'snapshot',
          '-r',
          policy.source,
          join(store, id),
        ])
        points = [id, ...points]
      }
      if (!scheduled) return 0
    }
    for (const name of points.slice(short ? 0 : policy.keep)) {
      await deleteWorkPoint(rt, join(store, name), policy.root)
      deleted++
    }
    // The cleaner frees the space a moment later: wait, so the space guard measures it, not the old figure.
    if (short && deleted)
      await rt.run(['sudo', '-n', 'btrfs', 'subvolume', 'sync', policy.source], {
        timeout: rt.cfg.retention.snapshot.settleMaxSeconds * 1000,
      })
  } catch (error) {
    console.error(`Scratch snapshots left as they are: ${(error as Error).message}`)
  }
  return deleted
}

/** One physical workspace point per sweep; project views share it. Protected projects are never inspected. */
export async function captureWorkspace(
  rt: Runtime,
  all: ReturnType<typeof manifests>,
  options = { root: ops.snapshots.workspacesRoot, catalogue: homePath(ops.snapshots.catalogue) },
): Promise<Set<string>> {
  const root = options.root,
    physicalRoot = realpathSync(root)
  const listed = JSON.parse(await checked(rt.run, ['aico', 'projects', 'list'])) as {
    id: string
    root_path: string | null
  }[]
  if (!Array.isArray(listed))
    throw new Error('The active project registry cannot be read; work snapshots were left alone.')
  const registeredIds = new Set(listed.map((p) => p.id))
  if (!registeredIds.size && all.some((m) => m.entries.length))
    throw new Error(
      'The project registry has no active records; existing snapshot holds are preserved.',
    )
  const active: {
    manifest: ReturnType<typeof manifests>[number]
    project: string
    id: string
    inside: string
    nested: string[]
  }[] = []
  for (const registered of listed) {
    if (
      !registered.root_path ||
      !/^[a-zA-Z0-9._-]+$/.test(registered.id) ||
      registered.id.toLowerCase().includes('neri') ||
      registered.root_path.toLowerCase().includes('neri')
    )
      continue
    if (!existsSync(registered.root_path)) continue
    const project = realpathSync(registered.root_path)
    if (!project.startsWith(physicalRoot + '/projects/') || !existsSync(join(project, '.git')))
      continue
    const tracked = (
      await checked(rt.run, ['git', '--no-optional-locks', '-C', project, 'ls-files', '-z'])
    )
      .split('\0')
      .filter(Boolean)
    const nested = qualifyWorkProject(physicalRoot, project, tracked, rt.cfg.workSnapshotDisposable)
    let manifest = all.find((m) =>
      m.entries.some((e) => e.project_id === registered.id && e.scope_type === 'project'),
    )
    if (!manifest) {
      manifest = {
        path: join(options.catalogue, registered.id, `project-${registered.id}`, 'manifest.json'),
        entries: [],
      }
      all.push(manifest)
    }
    active.push({
      manifest,
      project,
      id: registered.id,
      inside: relative(physicalRoot, project),
      nested,
    })
  }
  if (!active.length) return registeredIds
  const latest = all
    .flatMap((m) => m.entries)
    .filter(
      (e) =>
        e.capture_root &&
        existsSync(e.capture_root) &&
        realpathSync(e.capture_root) === physicalRoot &&
        existsSync(e.snapshot_path),
    )
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0]
  if (
    latest &&
    rt.now().getTime() - Date.parse(latest.created_at) <
      rt.cfg.retention.snapshot.intervalMinutes * 60000
  )
    return registeredIds
  const now = rt.now().toISOString(),
    id = pointId(now)
  const parent = join(root, '.snapshots', 'aico-autosnap', 'projects', 'workspace'),
    path = join(parent, id)
  mkdirSync(parent, { recursive: true })
  const publish = (manifest: ReturnType<typeof manifests>[number]) => {
    mkdirSync(dirname(manifest.path), { recursive: true })
    const tmp = manifest.path + `.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(manifest.entries, null, 2))
    renameSync(tmp, manifest.path)
  }
  for (const item of active) {
    item.manifest.entries.push({
      id,
      name: null,
      project_id: item.id,
      repo_root: item.project,
      scope_path: item.project,
      scope_type: 'project',
      scope_name: item.id,
      snapshot_path: path,
      created_at: now,
      backend: 'btrfs',
      source: 'auto-incomplete',
      capture_root: root,
      project_relative_path: item.inside,
      git_dir: join(path, item.inside, '.git'),
      index_artifact_path: null,
      head_oid: null,
      head_ref: null,
      branch: null,
      unfinished: null,
      nested_subvolumes: item.nested,
      last_restored_at: null,
      deletion_error: 'Capture metadata pending',
    })
    publish(item.manifest)
  }
  await checked(rt.run, ['btrfs', 'subvolume', 'snapshot', '-r', root, path])
  let incomplete = false
  for (const item of active) {
    const captured = join(path, item.inside),
      point = item.manifest.entries.find((e) => e.id === id) as RetentionView
    try {
      if (!existsSync(join(captured, '.git')) || !lstatSync(join(captured, '.git')).isDirectory())
        throw new Error('The project Git directory was omitted from the frozen point.')
      for (const name of ['index.lock', 'HEAD.lock', 'packed-refs.lock'])
        if (existsSync(join(captured, '.git', name)))
          throw new Error('A Git transaction was in progress at capture.')
      const status = await checked(rt.run, [
        'git',
        '--no-optional-locks',
        '-C',
        captured,
        'status',
        '--porcelain',
        '--untracked-files=normal',
      ])
      const head = (
        await checked(rt.run, ['git', '--no-optional-locks', '-C', captured, 'rev-parse', 'HEAD'])
      ).trim()
      if (!head) throw new Error('No committed project history was captured.')
      point.head_oid = head
      point.unfinished = !!status.trim()
      point.source = 'auto-periodic'
      point.deletion_error = null
    } catch (error) {
      point.deletion_error = (error as Error).message
      incomplete = true
    }
    publish(item.manifest)
  }
  if (incomplete)
    throw new Error(
      'Some work snapshots could not be qualified. Their points remain held and the previous copies are preserved.',
    )
  return registeredIds
}
/** Inspect only this ordinary project; never enter a nested subvolume or follow a symlink. */
function qualifyWorkProject(
  boundary: string,
  project: string,
  tracked: string[],
  disposable: string[],
): string[] {
  const device = statSync(boundary).dev,
    nested: string[] = []
  for (let dir = project; dir !== boundary; dir = dirname(dir)) {
    const info = statSync(dir)
    if (info.dev !== device || info.ino === 256)
      throw new Error('The project lies inside an omitted nested filesystem boundary.')
    if (dirname(dir) === dir) throw new Error('The project is outside the work snapshot boundary.')
  }
  let durable: string[] = []
  try {
    const identity = JSON.parse(readFileSync(join(project, 'project.identity.json'), 'utf8')) as {
      storage?: { durable_data?: unknown; disposable_outputs?: unknown }
    }
    durable = [
      ...(Array.isArray(identity.storage?.durable_data) ? identity.storage.durable_data : []),
      ...(Array.isArray(identity.storage?.disposable_outputs)
        ? identity.storage.disposable_outputs
        : []),
    ].filter((p): p is string => typeof p === 'string')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const walk = (dir: string) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (!item.isDirectory() || item.isSymbolicLink()) continue
      const path = join(dir, item.name),
        inside = relative(project, path),
        info = lstatSync(path)
      const trackedBelow = tracked.some((p) => p === inside || p.startsWith(inside + '/'))
      const omitted =
        durable.some((p) => inside === p || inside.startsWith(p + '/')) ||
        (!trackedBelow && inside.split('/').some((p) => disposable.includes(p)))
      if (info.ino === 256 || info.dev !== device) {
        nested.push(relative(boundary, path))
        if (!omitted) throw new Error('Saved source lies in an omitted nested subvolume.')
        continue
      }
      if (!omitted) walk(path)
    }
  }
  walk(project)
  return nested.sort()
}

/** Legacy windows only; a newest copy for every enabled source is held regardless of age. */
function legacyRetentionIds(
  snapshots: { id: string; time: string; tags?: string[] }[],
  enabled: string[],
  days: number,
  now: number,
): string[] {
  const latest = new Map<string, { id: string; time: number }>()
  for (const s of snapshots)
    for (const source of enabled) {
      if (!s.tags?.includes(`source:${source}`)) continue
      const time = Date.parse(s.time)
      if (!Number.isFinite(time)) continue
      if (time > (latest.get(source)?.time ?? 0)) latest.set(source, { id: s.id, time })
    }
  const keep = new Set([...latest.values()].map((s) => s.id))
  return snapshots
    .filter(
      (s) =>
        !s.tags?.includes('offsite') &&
        s.tags?.some((t) => t.startsWith('source:')) &&
        Date.parse(s.time) < now - days * 86400000 &&
        !keep.has(s.id),
    )
    .map((s) => s.id)
    .sort()
}
/** Called only by the scheduled Drive run, never by Run now or the restore path. */
export async function retainDrive(rt: Runtime, state: BackupState): Promise<void> {
  if (!driveSpec(rt.cfg).pruneQualified)
    throw new Error('Automatic Drive retention is not qualified; backup data is preserved.')
  const request = resticArgs(rt.cfg, 'drive', driveRetentionArgs(rt.cfg))
  request.argv.splice(
    request.argv.indexOf('forget'),
    0,
    '-o',
    'rclone.args=serve restic --stdio --drive-use-trash=true',
  )
  await checked(rt.run, request.argv, { env: request.env })
  // A machine's own repository holds only its tagged copies; the legacy sweep is the workstation's.
  if (!rt.cfg.drive && (state.goodDriveRuns ?? 0) >= rt.cfg.retention.drive.legacyAfterGoodRuns) {
    const snapshots = (await resticJson(rt, 'drive', ['snapshots'])) as {
      id: string
      time: string
      tags?: string[]
    }[]
    const ids = legacyRetentionIds(
      snapshots,
      migrated.sources.filter((s) => s.enabled).map((s) => s.id),
      rt.cfg.retention.drive.legacyDays,
      rt.now().getTime(),
    )
    if (ids.length) {
      const legacy = resticArgs(rt.cfg, 'drive', [
        '-o',
        'rclone.args=serve restic --stdio --drive-use-trash=true',
        'forget',
        ...ids,
      ])
      await checked(rt.run, legacy.argv, { env: legacy.env })
    }
  }
  state.goodDriveRuns = (state.goodDriveRuns ?? 0) + 1
}
export async function verifyDrive(rt: Runtime, scheduled: boolean): Promise<void> {
  if (scheduled && rt.now().getDay() !== rt.cfg.verify.day) return
  const check = resticArgs(rt.cfg, 'drive', ['check', `--read-data-subset=${rt.cfg.verify.sample}`])
  await checked(rt.run, check.argv, { env: check.env })
  if (scheduled) {
    if (!driveSpec(rt.cfg).pruneQualified)
      throw new Error('Automatic Drive retention is not qualified; backup data is preserved.')
    const prune = resticArgs(rt.cfg, 'drive', [
      '-o',
      'rclone.args=serve restic --stdio --drive-use-trash=true',
      'prune',
      '--max-unused',
      rt.cfg.verify.maxUnused,
      '--max-repack-size',
      rt.cfg.verify.maxRepack,
    ])
    await checked(rt.run, prune.argv, { env: prune.env })
  }
}

export async function deleteWorkPoint(
  rt: Runtime,
  path: string,
  root = ops.snapshots.workspacesRoot,
): Promise<void> {
  const base = join(realpathSync(root), '.snapshots'),
    absolute = resolve(path)
  let target = absolute
  for (let parent = dirname(absolute); dirname(parent) !== parent; parent = dirname(parent)) {
    if (
      parent.split('/').at(-1) === '.snapshots' &&
      existsSync(dirname(parent)) &&
      realpathSync(dirname(parent)) === realpathSync(root)
    ) {
      target = join(base, relative(parent, absolute))
      break
    }
  }
  if (!target.startsWith(base + '/'))
    throw new Error('Work retention is confined to the managed snapshot store.')
  const parts = relative(base, target).split('/')
  if (
    parts.length !== 4 ||
    parts[0] === 'recoveries' ||
    !['projects', 'worktrees'].includes(parts[1] ?? '') ||
    parts.some((p) => !p || p === '.' || p === '..' || !/^[a-zA-Z0-9._-]+$/.test(p))
  )
    throw new Error('Work retention requires an exact managed snapshot leaf.')
  for (let dir = target; ; dir = dirname(dir)) {
    if (lstatSync(dir).isSymbolicLink())
      throw new Error('Work retention refuses a symlink in the snapshot store.')
    if (dir === base) break
  }
  const info = lstatSync(target)
  if (info.uid !== process.getuid?.())
    throw new Error('The work point belongs to another user; it is preserved.')
  if (
    (await checked(rt.run, ['btrfs', 'property', 'get', '-ts', target, 'ro'])).trim() !== 'ro=true'
  )
    throw new Error('Work retention refuses writable points.')
  await checked(rt.run, [
    'sudo',
    '-n',
    rt.cfg.workSnapshotDeleteHelper,
    target,
    String(info.dev),
    String(info.ino),
  ])
}
async function settleWorkDeletion(rt: Runtime): Promise<void> {
  const policy = rt.cfg.retention.snapshot
  await new Promise((resolve) => setTimeout(resolve, policy.settleSeconds * 1000))
  const until = Date.now() + policy.settleMaxSeconds * 1000
  while (Date.now() < until) {
    let pressure = 0
    try {
      pressure = Number(
        readFileSync('/proc/pressure/io', 'utf8').match(/^some.*avg10=([\d.]+)/m)?.[1] ?? 0,
      )
    } catch {}
    if (pressure < policy.settleIoPressure) return
    await new Promise((resolve) => setTimeout(resolve, policy.settlePollSeconds * 1000))
  }
}
