// `aico snapshots take|list|restore`: read-only Btrfs points of a project tree, in the catalogue
// `st snap`/`st snaps` keep (~/.local/share/st/snaps/<project>/project-<project>/manifest.json, same
// entry fields), so either tool lists, and SummitFlow's timer still prunes, the other's points.
// A point is a read-only snapshot of the nearest subvolume holding the project (for /srv/workspaces
// projects that is the whole workspace). Restore swaps a project that is its own subvolume for a
// writable copy of a point (after saving the current tree as a point, so it can be undone); inside the
// production workspace it is refused, as st refuses it.
// Both take SummitFlow's physical and per-scope locks (flock), so the two never interleave.

import { randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { writeFileDurable } from '@aico/shared/durable-file'
import ops from '../data/ops.json' with { type: 'json' }
import { Refusal } from './deploy'
import { expandHome, type Runner, tail } from './sh'

export interface Point {
  id: string
  name: string | null
  project_id: string
  repo_root: string
  scope_path: string
  scope_type: string
  scope_name: string
  snapshot_path: string
  branch: string | null
  head_oid: string | null
  head_ref: string | null
  git_dir: string
  index_artifact_path: string | null
  created_at: string
  backend: string
  source: string
  last_restored_at: string | null
  capture_root: string | null
  project_relative_path: string
  [field: string]: unknown
}

export interface SnapDeps {
  run: Runner
  out: (line: string) => void
  /** ~/.local/share/st/snaps */
  catalogue: string
  workspacesRoot: string
  now: () => Date
  /** Re-runs this command holding the lock files; null when it already holds them. */
  relock: (files: string[]) => number | null
  /** The subvolume root holding a directory. */
  boundary: (dir: string) => string
}

export function snapDeps(run: Runner, out: (line: string) => void, env = process.env): SnapDeps {
  return {
    run,
    out,
    catalogue: expandHome(ops.snapshots.catalogue),
    workspacesRoot: ops.snapshots.workspacesRoot,
    now: () => new Date(),
    boundary: boundaryOf,
    relock: (files) => {
      if (env.AICO_SNAP_LOCKED === '1') return null
      for (const file of files) mkdirSync(dirname(file), { recursive: true })
      const chain = files.flatMap((file) => ['flock', '-n', '-E', '75', file])
      const self = [process.execPath, ...process.execArgv, ...process.argv.slice(1)]
      const result = run(chain[0] as string, [...chain.slice(1), ...self], {
        env: { ...env, AICO_SNAP_LOCKED: '1' },
        inherit: true,
      })
      if (result.code === 75)
        out('Deferred: another snapshot operation is in progress; retry in a moment')
      return result.code
    },
  }
}

const label = (value: string) =>
  value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'snapshot'

export interface Scope {
  project: string
  root: string
}

/** The project at a directory: its git top level; the id from project.identity.json, else the dir name. */
export function scopeAt(dir: string, run: Runner, project?: string): Scope {
  const top = run('git', ['-C', dir, 'rev-parse', '--show-toplevel'])
  if (top.code !== 0) throw new Refusal(`${dir} is not inside a git repository`)
  const root = resolve(top.out.trim())
  let id = project
  if (!id)
    try {
      id = JSON.parse(readFileSync(join(root, 'project.identity.json'), 'utf8')).project.id
    } catch {
      id = basename(root)
    }
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id))
    throw new Refusal(`Not a usable project id: ${id}`)
  return { project: id, root }
}

const scopeDir = (deps: SnapDeps, scope: Scope) =>
  join(deps.catalogue, scope.project, `project-${label(scope.project)}`)
const manifestPath = (deps: SnapDeps, scope: Scope) => join(scopeDir(deps, scope), 'manifest.json')

/** A list that exists but can't be read is refused, never read as no snapshots: the points themselves are untouched. */
function readManifest(path: string): Point[] {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    raw = null
  }
  if (!Array.isArray(raw))
    throw new Refusal(
      `The snapshot list can't be read: ${path}. Nothing was changed; the snapshots themselves are fine. Restore the list from a backup, or move it aside to start a new one.`,
    )
  return raw as Point[]
}

export function loadPoints(deps: SnapDeps, scope: Scope): Point[] {
  const path = manifestPath(deps, scope)
  if (!existsSync(path)) return []
  const raw = readManifest(path)
  // The same list, in the same order, st's preview resolves -N against: every entry, newest first by
  // created_at compared as plain text (a stable sort, as Python's).
  return raw.filter((entry) => entry && typeof entry === 'object').sort(newestFirst)
}

const newestFirst = (a: Point, b: Point) =>
  a.created_at === b.created_at ? 0 : a.created_at < b.created_at ? 1 : -1

function savePoints(deps: SnapDeps, scope: Scope, update: (all: Point[]) => Point[]) {
  const path = manifestPath(deps, scope)
  mkdirSync(dirname(path), { recursive: true })
  const all = existsSync(path) ? readManifest(path) : []
  writeFileDurable(path, JSON.stringify(update(all).sort(newestFirst), null, 2))
}

/** The nearest Btrfs subvolume root at or above dir (every subvolume root has inode 256). */
export function boundaryOf(dir: string): string {
  for (let path = dir; ; path = dirname(path)) {
    if (statSync(path).ino === 256) return path
    if (dirname(path) === path) throw new Refusal(`No Btrfs subvolume holds ${dir}`)
  }
}

/** Where points of a boundary live: the workspace's .snapshots, else a .snapshots beside the subvolume. */
export function storeFor(deps: SnapDeps, boundary: string, scope: Scope): string {
  const base =
    boundary === deps.workspacesRoot || boundary.startsWith(`${deps.workspacesRoot}/`)
      ? join(deps.workspacesRoot, '.snapshots')
      : join(dirname(boundary), '.snapshots')
  return join(base, scope.project, 'projects', label(scope.project))
}

export function find(points: Point[], target: string): Point {
  if (!points.length) throw new Refusal('No snapshots for this project.')
  if (/^-\d+$/.test(target)) {
    const point = points[Math.abs(Number(target)) - 1]
    if (!point) throw new Refusal(`Snapshot index ${target} is out of range.`)
    return point
  }
  const hit =
    points.find((p) => p.id === target) ??
    points.find((p) => p.name === target) ??
    points.find((p) => p.id.startsWith(target))
  if (!hit) throw new Refusal(`No snapshot matches ${target}`)
  return hit
}

const git = (deps: SnapDeps, dir: string, args: string[]) => {
  const result = deps.run('git', ['-C', dir, ...args])
  return result.code === 0 ? result.out.trim() : null
}

export function take(deps: SnapDeps, scope: Scope, name: string | null): Point {
  const btrfs = (...args: string[]) => {
    const result = deps.run('btrfs', args)
    if (result.code !== 0)
      throw new Refusal(`btrfs ${args.slice(0, 2).join(' ')} failed: ${tail(result, 3)}`)
  }
  const gitDir = join(scope.root, '.git')
  for (const lock of ['index.lock', 'HEAD.lock', 'packed-refs.lock'])
    if (existsSync(join(gitDir, lock)))
      throw new Refusal('Deferred: a git transaction is in progress; retry in a moment')
  const boundary = deps.boundary(scope.root)
  const now = deps.now()
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
  const id = `${stamp}-${name ? `${label(name).slice(0, 40)}-` : ''}${randomBytes(4).toString('hex')}`
  const store = storeFor(deps, boundary, scope)
  mkdirSync(store, { recursive: true })
  const path = join(store, id)
  btrfs('subvolume', 'snapshot', '-r', boundary, path)
  const inside = relative(boundary, scope.root) || '.'
  const captured = join(path, inside)
  const headRef = git(deps, captured, ['symbolic-ref', '-q', 'HEAD'])
  let index: string | null = null
  if (existsSync(join(captured, '.git/index'))) {
    const artifacts = join(scopeDir(deps, scope), 'artifacts', id)
    mkdirSync(artifacts, { recursive: true })
    writeFileSync(join(artifacts, 'index'), readFileSync(join(captured, '.git/index')))
    index = join(artifacts, 'index')
  }
  const point: Point = {
    id,
    name,
    project_id: scope.project,
    repo_root: scope.root,
    scope_path: scope.root,
    scope_type: 'project',
    scope_name: scope.project,
    snapshot_path: path,
    branch: headRef?.replace(/^refs\/heads\//, '') ?? null,
    head_oid: git(deps, captured, ['rev-parse', '--verify', 'HEAD']),
    head_ref: headRef,
    git_dir: join(captured, '.git'),
    index_artifact_path: index,
    created_at: now.toISOString(),
    backend: 'btrfs',
    source: 'manual',
    last_restored_at: null,
    last_recovered_at: null,
    recovery_path: null,
    recovery_branch: null,
    capture_root: boundary,
    project_relative_path: inside,
    source_digest: null,
    unfinished: Boolean(git(deps, captured, ['status', '--short', '--untracked-files=all'])),
    pin_reason: null,
    pin_until: null,
    recovery_active: false,
    deletion_error: null,
    nested_subvolumes: [],
    shared_capture: false,
    recovery_copies: [],
  }
  savePoints(deps, scope, (all) => [...all, point])
  return point
}

/**
 * The project root becomes a writable copy of the point. Its current contents are first saved as a
 * point of their own (named pre-restore), so the restore can be undone with another restore.
 */
export function restore(
  deps: SnapDeps,
  scope: Scope,
  target: string,
): { point: Point; saved: Point } {
  const point = find(loadPoints(deps, scope), target)
  if (point.scope_path !== scope.root)
    throw new Refusal(`Snapshot ${point.id} belongs to ${point.scope_path}, not ${scope.root}`)
  if (point.capture_root !== scope.root || deps.boundary(scope.root) !== scope.root)
    throw new Refusal(
      'Restore needs a project that is its own subvolume; for a shared workspace recover single files instead',
    )
  if (scope.root === deps.workspacesRoot || scope.root.startsWith(`${deps.workspacesRoot}/`))
    throw new Refusal(
      'Whole workspace and production project restore is refused; recover single files instead',
    )
  if (!existsSync(point.snapshot_path))
    throw new Refusal(`Snapshot path is missing: ${point.snapshot_path}`)
  const old = `${scope.root}.__rollback_old__`
  if (existsSync(old))
    throw new Refusal(`Rollback staging path already exists: ${old}; clean it up first`)
  const saved = take(deps, scope, 'pre-restore')
  renameSync(scope.root, old)
  const made = deps.run('btrfs', ['subvolume', 'snapshot', point.snapshot_path, scope.root])
  if (made.code !== 0) {
    renameSync(old, scope.root)
    throw new Refusal(`btrfs snapshot failed, nothing changed: ${tail(made, 3)}`)
  }
  let removed = deps.run('btrfs', ['subvolume', 'delete', old])
  if (removed.code !== 0) removed = deps.run('sudo', ['-n', 'btrfs', 'subvolume', 'delete', old])
  if (removed.code !== 0)
    deps.out(`[snapshots] restored; the replaced tree is still at ${old} (${tail(removed, 1)})`)
  const at = deps.now().toISOString()
  savePoints(deps, scope, (all) =>
    all.map((entry) => (entry.id === point.id ? { ...entry, last_restored_at: at } : entry)),
  )
  return { point: { ...point, last_restored_at: at }, saved }
}

const line = (index: number, p: Point) =>
  `SNAP ${index}|${p.id}|name:${p.name ?? '-'}|scope:${p.scope_type}:${p.scope_name}|created:${p.created_at}|` +
  `backend:${p.backend}|source:${p.source}|restored:${p.last_restored_at ?? '-'}|recovered:${p.last_recovered_at ?? '-'}`

/** The lock files st snap holds: the shared physical lock and this scope's lock. */
export const lockFiles = (deps: SnapDeps, scope: Scope) => [
  join(deps.catalogue, 'physical.lock'),
  join(scopeDir(deps, scope), 'snapshot.lock'),
]

export function snapshots(argv: string[], deps: SnapDeps, cwd = process.cwd()): number {
  const [verb, ...rest] = argv
  let root = cwd
  let project: string | undefined
  const args: string[] = []
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--root') root = rest[++i] ?? ''
    else if (rest[i] === '--project') project = rest[++i]
    else args.push(rest[i] as string)
  }
  const scope = scopeAt(root, deps.run, project)
  if (verb === 'list') {
    const points = loadPoints(deps, scope)
    deps.out(`SNAPS[${points.length}]`)
    for (const [i, point] of points.entries()) deps.out(line(i + 1, point))
    return 0
  }
  if (verb === 'take' || verb === 'restore') {
    const code = deps.relock(lockFiles(deps, scope))
    if (code !== null) return code
  }
  if (verb === 'take') {
    const point = take(deps, scope, args[0] ?? null)
    deps.out(
      `SNAP ${point.id}|name:${point.name ?? '-'}|scope:project:${scope.project}|backend:btrfs|branch:${point.branch ?? 'detached'}`,
    )
    return 0
  }
  if (verb === 'restore') {
    const at = args.indexOf('--confirm')
    const token = at >= 0 ? args.splice(at, 2)[1] : undefined
    if (!args[0]) throw new Refusal('aico snapshots restore needs a snapshot id, name or -N', 2)
    // Two passes, as SummitFlow's st rollback: a preview that issues a single-use token, then the restore.
    const target = find(loadPoints(deps, scope), args[0])
    const tokenFile = join(scopeDir(deps, scope), 'rollback-confirm.json')
    if (token === undefined) {
      const issued = randomBytes(4).toString('hex')
      mkdirSync(dirname(tokenFile), { recursive: true })
      writeFileSync(tokenFile, JSON.stringify({ token: issued, point: target.id }), { mode: 0o600 })
      for (const text of [
        `ROLLBACK would replace the whole project root ${scope.root} (${scope.project})`,
        `  Snapshot: ${target.id}`,
        `  Name: ${target.name ?? '-'}`,
        `  Created: ${target.created_at}`,
        `  Branch: ${target.branch ?? 'detached'}  HEAD: ${target.head_oid ?? '?'}`,
        'The current tree is saved as a pre-restore snapshot first. To recover single files instead, copy them out of the snapshot path.',
        `To restore: st rollback ${args[0]} --confirm ${issued}`,
      ])
        deps.out(text)
      return 0
    }
    let issued: { token?: string; point?: string } = {}
    try {
      issued = JSON.parse(readFileSync(tokenFile, 'utf8'))
    } catch {}
    if (!token || issued.token !== token || issued.point !== target.id)
      throw new Refusal(
        'That confirm token is not the one the preview issued for this snapshot; run st rollback without --confirm for a new one.',
        2,
      )
    rmSync(tokenFile, { force: true })
    const { point, saved } = restore(deps, scope, target.id)
    deps.out(
      `ROLLED_BACK ${point.id}|name:${point.name ?? '-'}|scope:project:${scope.project}|backend:btrfs`,
    )
    deps.out(
      `The tree before the restore is snapshot ${saved.id}; undo with: st rollback ${saved.id}`,
    )
    return 0
  }
  throw new Refusal(
    'Usage: aico snapshots take [NAME] | list | restore ID|NAME|-N [--confirm TOKEN]   [--root DIR] [--project ID]',
    2,
  )
}
