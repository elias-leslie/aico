import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { snapshotDatabase } from '@aico/store'
import {
  type BackupConfig,
  type BackupState,
  type Copy,
  copyKey,
  driveTarget,
  homePath,
  migrated,
} from './backup-plan'
import {
  checked,
  excludesPath,
  failureReason,
  type Runtime,
  restic,
  summary,
} from './backup-runtime'

export interface BackupJob {
  id: string
  paths: string[]
  binds: [string, string][]
  dataAt: string
  command?: string[]
  filename?: string
  offline?: boolean
  prepare?: boolean
}
export function volumeJobs(cfg: BackupConfig, state: BackupState): BackupJob[] {
  return Object.entries(cfg.subvolumes).map(([id, spec]) => {
    const p = state.points.find((p) => p.source === spec.mount)
    if (!p) throw new Error(`No verified native snapshot of ${spec.mount} to read for Drive.`)
    return {
      id,
      paths: spec.paths,
      binds: spec.paths.map((path) => [join(p.snapshot, relative(spec.mount, path)), path]),
      dataAt: p.dataAt,
    }
  })
}
/** A folder upload can never make its payload newer. Ignore directory and symlink mtimes. */
export function payloadTime(path: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8')) as {
      completed_at?: string
    }
    if (raw.completed_at && Number.isFinite(Date.parse(raw.completed_at)))
      return new Date(raw.completed_at).toISOString()
  } catch {}
  let newest: number | null = null
  const walk = (p: string) => {
    const st = statSync(p, { throwIfNoEntry: false })
    if (!st) return
    if (st.isFile()) {
      newest = Math.max(newest ?? 0, st.mtimeMs)
      return
    }
    if (st.isDirectory())
      for (const d of readdirSync(p, { withFileTypes: true }))
        if (!d.isSymbolicLink() && d.name !== '.snapshots') walk(join(p, d.name))
  }
  try {
    walk(path)
  } catch {
    return null
  }
  return newest === null ? null : new Date(newest).toISOString()
}
export function copiedDataTime(captured: string, payload: string | null): string | undefined {
  return payload && Number.isFinite(Date.parse(captured))
    ? new Date(Math.min(Date.parse(captured), Date.parse(payload))).toISOString()
    : undefined
}
async function pveSsh(rt: Runtime, key: string): Promise<string[]> {
  const output = await checked(rt.run, ['ssh', '-G', rt.cfg.pve.alias])
  const fields = Object.fromEntries(output.split('\n').map((l) => l.split(/\s+/, 2)))
  if (!fields.hostname) throw new Error('The Proxmox backup host alias is unavailable.')
  return [
    'ssh',
    '-F',
    '/dev/null',
    '-i',
    homePath(key),
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'IdentityAgent=none',
    '-o',
    'BatchMode=yes',
    '-o',
    `UserKnownHostsFile=${homePath(rt.cfg.pve.knownHosts)}`,
    '-p',
    fields.port || '22',
    `${fields.user || 'root'}@${fields.hostname}`,
  ]
}
/**
 * A stopped guest has nothing to read and counts as off, except a guest whose files the Proxmox host
 * reads straight from its stopped disk (neither the guest agent nor pct exec is needed): VM 180 and
 * the Jobinator container are off between uses and their last state must still reach Drive.
 */
export function hostReadsStoppedDisk(type: string, parts: string[], via: string | null): boolean {
  return (
    parts[2] === 'files' &&
    ((type === 'qemu' && via === 'agent') || (type === 'lxc' && via === 'pct'))
  )
}
async function proxmoxJob(
  rt: Runtime,
  state: BackupState,
  source: { id: string; path: string },
): Promise<BackupJob> {
  const target = new URL(source.path)
  const ssh = await pveSsh(rt, rt.cfg.pve.backupKey)
  let dataAt = rt.now().toISOString()
  if (source.id === rt.cfg.remoteSqlite.source) {
    await checked(rt.run, rt.cfg.remoteSqlite.snapshotCommand)
    const seconds = Number((await checked(rt.run, rt.cfg.remoteSqlite.timeCommand)).trim())
    if (!Number.isFinite(seconds) || seconds <= 0)
      throw new Error('The gem Aico snapshot date is unavailable.')
    dataAt = new Date(Math.min(rt.now().getTime(), seconds * 1000)).toISOString()
  }
  const parts = target.pathname.split('/').filter(Boolean)
  let filename = 'pve-cluster-config.sql'
  if (parts[0] !== 'config' && parts[0] !== 'host') {
    const resources = JSON.parse(await checked(rt.run, [...ssh, 'guests'])) as {
      vmid: number
      type: string
      status: string
      template?: boolean
    }[]
    const guest = resources.find(
      (g) => g.vmid === Number(parts[1]) && g.type === parts[0] && !g.template,
    )
    if (!guest) throw new Error('The registered Proxmox guest is unavailable.')
    if (
      guest.status !== 'running' &&
      !hostReadsStoppedDisk(guest.type, parts, target.searchParams.get('via')) &&
      (parts[2] === 'files' || state.copies[copyKey(source.id, 'drive')]?.snapshot)
    )
      return { id: source.id, paths: [], binds: [], dataAt: rt.now().toISOString(), offline: true }
    if (guest.type === 'lxc' && guest.status === 'running' && parts[2] !== 'files') {
      const pool = Number(await checked(rt.run, [...ssh, 'thinpool']))
      if (!Number.isFinite(pool) || pool >= rt.cfg.pve.thinPoolMaximumPercent)
        throw new Error('The Proxmox storage pool has insufficient room for a capture.')
    }
    filename =
      parts[2] === 'files'
        ? `files-${parts[0]}-${parts[1]}.tar${target.searchParams.get('via') === 'agent' ? '.gz' : ''}`
        : `vzdump-${parts[0]}-${parts[1]}.${parts[0] === 'qemu' ? 'vma' : 'tar'}`
  } else if (parts[0] === 'host') filename = 'files-host.tar'
  return {
    id: source.id,
    paths: [],
    binds: [],
    dataAt,
    filename,
    command: [...ssh, 'capture', source.id, createHash('sha256').update(source.path).digest('hex')],
  }
}
export async function prepareFolder(
  rt: Runtime,
  job: BackupJob,
  state?: BackupState,
): Promise<boolean> {
  const spec = rt.cfg.prepare[job.id as keyof typeof rt.cfg.prepare]
  if (!spec) return true
  const request = {
    contract_version: 1,
    operation: 'prepare_backup',
    project: spec.project,
    source_id: job.id,
    backup_id: `bkp-${randomBytes(8).toString('hex')}`,
    qualified_previous: previousQualification(job, state),
  }
  const context = {
    contract_version: 1,
    project_id: spec.project,
    project_root: spec.root,
    cwd: spec.root,
    api_base: null,
    agent_hub_url: null,
    output: { human: false, compact: false, progress_only: false },
  }
  // The owner extension keeps its existing secret and Proxmox access path. Never log its response.
  const result = await rt.run([...spec.command, '--request', JSON.stringify(request)], {
    cwd: spec.root,
    env: { ...process.env, ST_EXTENSION_CONTEXT: JSON.stringify(context) },
  })
  if (result.code)
    throw new Error(
      'The source owner could not make a fresh payload; the previous folder was not uploaded again.',
    )
  const answer = JSON.parse(result.out) as {
    status: string
    reason?: string
    archive_path?: string
    source_id?: string
    backup_id?: string
    size_bytes?: number
  }
  if (answer.source_id !== job.id || answer.backup_id !== request.backup_id)
    throw new Error('The source owner returned an unexpected capture.')
  if (answer.status === 'skipped' && answer.reason === 'guest_stopped') return false
  if (
    answer.status !== 'completed' ||
    !answer.archive_path ||
    dirname(answer.archive_path) !== job.paths[0] ||
    !existsSync(answer.archive_path) ||
    statSync(answer.archive_path).size !== answer.size_bytes
  )
    throw new Error('The source owner returned an incomplete capture.')
  return true
}
export async function backupJob(
  rt: Runtime,
  state: BackupState,
  job: BackupJob,
  target: 'drive' | 'append' = 'drive',
): Promise<Copy> {
  const attemptedAt = rt.now().toISOString(),
    old = state.copies[copyKey(job.id, target)]
  try {
    if (job.offline || (job.prepare && !(await prepareFolder(rt, job, state))))
      return {
        ...old,
        source: job.id,
        target,
        attemptedAt,
        observed: 'offline',
        dataAt:
          old?.dataAt ??
          (old?.snapshot && old.copiedAt && job.paths[0]
            ? copiedDataTime(old.copiedAt, payloadTime(job.paths[0]))
            : undefined),
        offlineSince:
          old?.observed === 'offline'
            ? old.offlineSince
            : old?.observed === 'ok' && !old.error
              ? attemptedAt
              : undefined,
        error: undefined,
      }
    if (job.prepare) job.dataAt = payloadTime(job.paths[0] as string) ?? ''
    if (!job.dataAt)
      throw new Error('The source has no readable payload date; no fresh backup was claimed.')
    const tags = ['offsite', `job:${job.id}`, `source:${job.id}`]
    const base = [
      'backup',
      '--host',
      process.env.AICO_BACKUP_MACHINE || hostname(),
      ...tags.flatMap((t) => ['--tag', t]),
    ]
    const args = job.command
      ? [
          ...base,
          '--stdin-from-command',
          '--stdin-filename',
          job.filename as string,
          '--',
          ...job.command,
        ]
      : [
          ...base,
          '--exclude-file',
          excludesPath(rt.cfg),
          '--exclude-caches',
          '--exclude-if-present',
          '.nobackup',
          ...job.paths,
        ]
    const result = await restic(rt, target, args, job.binds)
    const saved = summary(result)
    if (
      result.code !== 0 ||
      !saved.snapshot_id ||
      (job.command && !(saved.total_bytes_processed && saved.total_bytes_processed > 0))
    )
      throw new Error(
        `The ${target === 'drive' ? 'Drive' : 'CT 160'} copy failed (restic exit ${result.code}); the last good copy is preserved.${failureReason(result, ' Restic said: ')}`,
      )
    return {
      source: job.id,
      target,
      dataAt: job.dataAt,
      snapshot: saved.snapshot_id,
      copiedAt: rt.now().toISOString(),
      observed: 'ok',
      path: job.paths[0] ?? `/${job.filename}`,
      attemptedAt,
    }
  } catch (error) {
    return {
      ...old,
      source: job.id,
      target,
      attemptedAt,
      observed: 'failed',
      offlineSince: undefined,
      error: (error as Error).message,
    }
  }
}
/** Every local Aico database, including WAL contents, is independently snapshotted and checked. */
export function stageSqlite(cfg: BackupConfig, now: Date): { paths: string[]; dataAt: string } {
  const staging = homePath(cfg.sqlite.stagingDir)
  mkdirSync(staging, { recursive: true, mode: 0o700 })
  const dirs = [
    process.env.AICO_DATA_DIR || homePath(cfg.sqlite.dataDir),
    ...cfg.sqlite.otherDirs.map(homePath),
  ]
  const copied: string[] = []
  for (const [index, dir] of dirs.entries()) {
    if (!existsSync(dir)) continue
    for (const file of readdirSync(dir, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith('.db')) continue
      const source = join(dir, file.name),
        target = join(staging, index ? `${basename(dir)}-${file.name}` : file.name)
      snapshotDatabase(source, target)
      copied.push(target)
    }
  }
  if (!copied.length) throw new Error('No Aico databases were found; no fresh backup was claimed.')
  writeFileSync(
    join(staging, 'manifest.json'),
    JSON.stringify({ completed_at: now.toISOString(), files: copied.map((p) => basename(p)) }) +
      '\n',
    { mode: 0o600 },
  )
  const blobs = join(dirs[0] as string, 'blobs')
  const secrets = join(dirs[0] as string, 'secrets')
  return {
    paths: [
      ...copied,
      join(staging, 'manifest.json'),
      ...(existsSync(blobs) ? [blobs] : []),
      ...(existsSync(secrets) ? [secrets] : []),
      ...cfg.sqlite.recoveryPaths.map(homePath).filter(existsSync),
    ],
    dataAt: now.toISOString(),
  }
}
export async function driveBackup(
  rt: Runtime,
  state: BackupState,
  machine: string,
  save: () => void,
): Promise<boolean> {
  const jobs: BackupJob[] = machine === rt.cfg.workstation ? volumeJobs(rt.cfg, state) : []
  if (machine === rt.cfg.workstation)
    for (const s of migrated.sources.filter((s) => s.enabled)) {
      if (s.path.startsWith('proxmox://')) {
        try {
          jobs.push(await proxmoxJob(rt, state, s))
        } catch (error) {
          state.copies[copyKey(s.id, 'drive')] = {
            ...state.copies[copyKey(s.id, 'drive')],
            source: s.id,
            target: 'drive',
            attemptedAt: rt.now().toISOString(),
            error: (error as Error).message,
          }
          save()
        }
      } else if (s.path.startsWith('/media/') || s.path.startsWith('/mnt/')) {
        jobs.push({
          id: s.id,
          paths: [s.path],
          binds: [],
          dataAt: payloadTime(s.path) ?? '',
          prepare: s.id in rt.cfg.prepare,
        })
      }
    }
  const sqlite = stageSqlite(rt.cfg, rt.now())
  jobs.push({ id: `aico-${machine}`, ...sqlite, binds: [] })
  let ok = true
  for (const job of jobs) {
    const result = await backupJob(rt, state, job)
    state.copies[copyKey(job.id, 'drive')] = result
    if (result.error) ok = false
    save()
  }
  return (
    ok && !migrated.sources.some((s) => s.enabled && state.copies[copyKey(s.id, 'drive')]?.error)
  )
}

function previousQualification(
  job: BackupJob,
  state: BackupState | undefined,
): { backup_id: string; sha256: string; snapshot_id: string; repository_id: string } | null {
  const copy = state?.copies[copyKey(job.id, 'drive')]
  if (!copy?.snapshot || !/^[a-f0-9]{64}$/.test(copy.snapshot) || !copy.copiedAt) return null
  try {
    const prior = JSON.parse(
      readFileSync(join(job.paths[0] as string, 'manifest.json'), 'utf8'),
    ) as { source_id?: string; completed_at?: string; backup_id?: string; sha256?: string }
    if (
      prior.source_id !== job.id ||
      !prior.completed_at ||
      !Number.isFinite(Date.parse(prior.completed_at)) ||
      Date.parse(copy.copiedAt) < Date.parse(prior.completed_at) ||
      !prior.backup_id ||
      !prior.sha256 ||
      !/^[a-f0-9]{64}$/.test(prior.sha256)
    )
      return null
    return {
      backup_id: prior.backup_id,
      sha256: prior.sha256,
      snapshot_id: copy.snapshot,
      repository_id: createHash('sha256').update(driveTarget().repository).digest('hex'),
    }
  } catch {
    return null
  }
}
