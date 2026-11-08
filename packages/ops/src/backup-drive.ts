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
  driveGuests,
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
  /** Where the source owner stages its payload on a machine without the usual disk. */
  prepareEnv?: Record<string, string>
  /** The machine this copy reads: how it stood at the start, and how to read it again if the copy fails. */
  machine?: { before: GuestPower; read: () => Promise<GuestPower> }
}
/** A machine's power: `off` also when the Proxmox host holding it does not answer at all. */
export type GuestPower = { state: 'on'; uptime?: number } | { state: 'off' } | { state: 'unknown' }
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
/**
 * ssh itself couldn't reach the host, so it's off or off the network. Its exit code 255 alone doesn't
 * say that: a rejected key, a changed host key or a missing key file are real failures.
 */
const SSH_NO_ROUTE =
  /connection refused|timed out|no route to host|network is unreachable|host is down|connection closed|connection reset|broken pipe|server not responding/i
export const hostAway = (result: { code: number; err: string }): boolean =>
  result.code === 255 && SSH_NO_ROUTE.test(result.err)
/**
 * A source on an external disk that isn't mounted (unplugged): off, like a machine. A folder missing
 * from a mounted disk is still a failure.
 */
export function diskAway(
  path: string,
  mounts = readFileSync('/proc/self/mounts', 'utf8'),
): boolean {
  if (!/^\/(media|mnt)\//.test(path) || existsSync(path)) return false
  const root = path
    .split('/')
    .slice(0, path.startsWith('/media/') ? 4 : 3)
    .join('/')
  return !mounts.split('\n').some((line) => line.split(' ')[1] === root)
}
/** How a guest (or, with no `guest`, the Proxmox host) stands now, from the host's own list. */
async function readPower(
  rt: Runtime,
  ssh: string[],
  guest?: { vmid: number; type: string },
): Promise<GuestPower> {
  const listing = await rt.run([...ssh, 'guests'])
  if (hostAway(listing)) return { state: 'off' }
  if (listing.code) return { state: 'unknown' }
  try {
    return readListed(JSON.parse(listing.out), guest)
  } catch {
    return { state: 'unknown' }
  }
}
function readListed(
  resources: { vmid: number; type: string; status: string; uptime?: number }[],
  guest?: { vmid: number; type: string },
): GuestPower {
  if (!guest) return { state: 'on' }
  const found = resources.find((g) => g.vmid === guest.vmid && g.type === guest.type)
  if (!found) return { state: 'unknown' }
  return found.status === 'running'
    ? { state: 'on', ...(found.uptime === undefined ? {} : { uptime: found.uptime }) }
    : { state: 'off' }
}
/** CT 160, where the append copy goes, as a machine a copy can find off; null off the workstation. */
export async function appendMachine(rt: Runtime): Promise<BackupJob['machine']> {
  try {
    const ssh = await pveSsh(rt, rt.cfg.pve.backupKey)
    const guest = { vmid: rt.cfg.pve.appendGuest, type: 'lxc' }
    return { before: await readPower(rt, ssh, guest), read: () => readPower(rt, ssh, guest) }
  } catch {
    return undefined
  }
}
/**
 * What a failed copy says about its machine. A machine turned off (or on, or restarted) during the
 * copy is why it failed, so it isn't a failed backup: `off` records it as off, `changed` leaves the
 * last good copy to the next normal run. A machine that stayed as it was failed for real: restic,
 * Drive, or a read of a stopped disk, which works on a machine that stays off.
 */
async function failedCopyMachine(
  job: BackupJob,
  seconds: number,
): Promise<'off' | 'changed' | null> {
  if (!job.machine) return null
  const { before, read } = job.machine
  const now = await read().catch((): GuestPower => ({ state: 'unknown' }))
  if (now.state === 'unknown' || before.state === 'unknown') return null
  if (now.state === 'off') return before.state === 'off' ? null : 'off'
  if (before.state === 'off') return 'changed'
  return now.uptime !== undefined && now.uptime < seconds ? 'changed' : null
}
async function proxmoxJob(
  rt: Runtime,
  state: BackupState,
  source: { id: string; path: string },
): Promise<BackupJob> {
  const target = new URL(source.path)
  const ssh = await pveSsh(rt, rt.cfg.pve.backupKey)
  let dataAt = rt.now().toISOString()
  const parts = target.pathname.split('/').filter(Boolean)
  const offline = (): BackupJob => ({
    id: source.id,
    paths: [],
    binds: [],
    dataAt: rt.now().toISOString(),
    offline: true,
  })
  const onHost = parts[0] === 'config' || parts[0] === 'host'
  const guestId = onHost ? undefined : { vmid: Number(parts[1]), type: parts[0] as string }
  // The host itself doesn't answer: everything on it is off.
  const listing = await rt.run([...ssh, 'guests'])
  if (hostAway(listing)) return offline()
  if (listing.code)
    throw new Error(`The Proxmox guest list is unavailable${failureReason(listing, ': ')}.`)
  const resources = JSON.parse(listing.out) as {
    vmid: number
    type: string
    status: string
    uptime?: number
    template?: boolean
  }[]
  const machine = {
    before: readListed(resources, guestId),
    read: () => readPower(rt, ssh, guestId),
  }
  // A step that fails because the machine just went off isn't a failure either.
  const wentOff = async () =>
    (await machine.read().catch((): GuestPower => ({ state: 'unknown' }))).state === 'off'
  if (source.id === rt.cfg.remoteSqlite.source) {
    if (machine.before.state === 'off') return offline()
    try {
      await checked(rt.run, rt.cfg.remoteSqlite.snapshotCommand)
      const seconds = Number((await checked(rt.run, rt.cfg.remoteSqlite.timeCommand)).trim())
      if (!Number.isFinite(seconds) || seconds <= 0)
        throw new Error('The gem Aico snapshot date is unavailable.')
      dataAt = new Date(Math.min(rt.now().getTime(), seconds * 1000)).toISOString()
    } catch (error) {
      if (await wentOff()) return offline()
      throw error
    }
  }
  let filename = 'pve-cluster-config.sql'
  if (!onHost) {
    const guest = resources.find(
      (g) => g.vmid === Number(parts[1]) && g.type === parts[0] && !g.template,
    )
    if (!guest) throw new Error('The registered Proxmox guest is unavailable.')
    if (
      guest.status !== 'running' &&
      !hostReadsStoppedDisk(guest.type, parts, target.searchParams.get('via')) &&
      (parts[2] === 'files' || state.copies[copyKey(source.id, 'drive')]?.snapshot)
    )
      return offline()
    if (guest.type === 'lxc' && guest.status === 'running' && parts[2] !== 'files') {
      try {
        const pool = Number(await checked(rt.run, [...ssh, 'thinpool']))
        if (!Number.isFinite(pool) || pool >= rt.cfg.pve.thinPoolMaximumPercent)
          throw new Error('The Proxmox storage pool has insufficient room for a capture.')
      } catch (error) {
        if (await wentOff()) return offline()
        throw error
      }
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
    machine,
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
    env: { ...process.env, ...job.prepareEnv, ST_EXTENSION_CONTEXT: JSON.stringify(context) },
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
  const off = (): Copy => ({
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
  })
  try {
    if (job.offline || (job.prepare && !(await prepareFolder(rt, job, state)))) return off()
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
          excludesPath(),
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
    const seconds = (rt.now().getTime() - Date.parse(attemptedAt)) / 1000
    const machine = await failedCopyMachine(job, seconds)
    if (machine === 'off') return off()
    // The last good copy waits for the next normal run. An earlier real failure still stands.
    if (machine === 'changed') return { ...old, source: job.id, target, attemptedAt }
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
  // The workstation copies every source. The standby copies the machines on its own Proxmox host to
  // its own repository, every day, so nothing there depends on the workstation being on.
  const sources = migrated.sources.filter(
    (s) => s.enabled && (machine === rt.cfg.workstation || driveGuests(rt.cfg).includes(s.id)),
  )
  for (const s of sources) {
    const stage = rt.cfg.drive?.stages?.[s.id as keyof typeof rt.cfg.drive.stages]
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
    } else if (stage || s.path.startsWith('/media/') || s.path.startsWith('/mnt/')) {
      const path = stage ? homePath(stage.path) : s.path
      jobs.push({
        id: s.id,
        paths: [path],
        binds: [],
        dataAt: payloadTime(path) ?? '',
        offline: diskAway(path),
        prepare: s.id in rt.cfg.prepare,
        ...(stage
          ? {
              prepareEnv: Object.fromEntries(
                Object.entries(stage.env).map(([k, v]) => [k, homePath(v)]),
              ),
            }
          : {}),
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
