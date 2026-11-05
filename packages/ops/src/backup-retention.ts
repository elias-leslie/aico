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
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ops from '../data/ops.json' with { type: 'json' }
import { type BackupConfig, type BackupState, homePath, migrated } from './backup-plan'
import { checked, type Runtime, resticArgs, resticJson } from './backup-runtime'
import type { Point } from './snapshots'

export interface RetentionView extends Point {
  unfinished?: boolean | null
  recovery_active?: boolean
  pin_reason?: string | null
  pin_until?: string | null
  recovery_copies?: { deleted_at?: string }[]
}
export const physicalKey = (path: string) => (existsSync(path) ? realpathSync(path) : resolve(path))
export function retentionSelection(
  entries: RetentionView[],
  policy: BackupConfig['retention']['snapshot'],
  now: number,
  pressure = false,
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
export function manifests(
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
/** Scheduled retention only. Unknown metadata and active recovery copies always preserve the point. */
export async function snapshotSweep(rt: Runtime, scheduled: boolean): Promise<void> {
  const all = manifests()
  await captureWorkspace(rt, all)
  const points = all.flatMap((m) => m.entries)
  const allowed = scheduled
    ? retentionSelection(points, rt.cfg.retention.snapshot, rt.now().getTime())
    : []
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
    await checked(rt.run, ['btrfs', 'subvolume', 'delete', '--', path])
    for (const manifest of all) {
      manifest.entries = manifest.entries.filter((e) => physicalKey(e.snapshot_path) !== path)
      const temporary = manifest.path + `.${process.pid}.tmp`
      writeFileSync(temporary, JSON.stringify(manifest.entries, null, 2))
      renameSync(temporary, manifest.path)
    }
  }
}
export function driveRetentionArgs(cfg: BackupConfig): string[] {
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

/** One physical workspace point per sweep; project views share it. Protected projects are never inspected. */
export async function captureWorkspace(
  rt: Runtime,
  all: ReturnType<typeof manifests>,
  options = { root: ops.snapshots.workspacesRoot, catalogue: homePath(ops.snapshots.catalogue) },
): Promise<void> {
  const root = options.root,
    physicalRoot = realpathSync(root)
  const listed = JSON.parse(await checked(rt.run, ['aico', 'projects', 'list'])) as {
    id: string
    root_path: string | null
  }[]
  if (!Array.isArray(listed))
    throw new Error('The active project registry cannot be read; work snapshots were left alone.')
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
  if (!active.length) return
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
    return
  const now = rt.now().toISOString(),
    id = now.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z') + '-' + randomBytes(4).toString('hex')
  const parent = join(root, '.snapshots', 'aico-autosnap'),
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
export function legacyRetentionIds(
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
  const request = resticArgs(rt.cfg, 'drive', driveRetentionArgs(rt.cfg))
  request.argv.splice(
    request.argv.indexOf('forget'),
    0,
    '-o',
    'rclone.args=serve restic --stdio --drive-use-trash=true',
  )
  await checked(rt.run, request.argv, { env: request.env })
  const day = rt.now().toLocaleDateString('sv-SE')
  state.goodDriveDays = [...new Set([...(state.goodDriveDays ?? []), day])].slice(-3)
  if (state.goodDriveDays.length >= 3) {
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
}
export async function verifyDrive(rt: Runtime, scheduled: boolean): Promise<void> {
  if (scheduled && rt.now().getDay() !== rt.cfg.verify.day) return
  const check = resticArgs(rt.cfg, 'drive', ['check', `--read-data-subset=${rt.cfg.verify.sample}`])
  await checked(rt.run, check.argv, { env: check.env })
  if (scheduled) {
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
