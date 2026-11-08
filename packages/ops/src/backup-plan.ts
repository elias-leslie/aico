// Backup configuration is migrated once. Runtime code never queries SummitFlow's database.
import { readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { backupTargetName } from '@aico/shared/backup-targets'
import { spanText } from '@aico/shared/time'
import type { StatusRow } from '@aico/status'
import defaults from '../data/backups.json' with { type: 'json' }
import imported from '../data/backups-import.json' with { type: 'json' }

/** A machine's own Google Drive repository, when it backs itself up there (`driveClients`). */
export type DriveClient = (typeof defaults.driveClients)[keyof typeof defaults.driveClients]
export type BackupConfig = typeof defaults & { drive?: DriveClient }
export type Source = (typeof imported.sources)[number]
export type BackupTarget = 'native' | 'drive' | 'append'
export interface BackupPoint {
  source: string
  snapshot: string
  target: string
  dataAt: string
  source_uuid?: string
  received_uuid?: string
}
export interface Copy {
  source: string
  target: BackupTarget
  dataAt?: string
  snapshot?: string
  path?: string
  error?: string
  offlineSince?: string
  attemptedAt?: string
  copiedAt?: string
  observed?: 'ok' | 'offline' | 'failed'
  /** Its owner machine could not be read, since then; a failure only once that has lasted. */
  unreadSince?: string
  /** When an external owner came back from being off: its artifact's age counts from then. */
  backAt?: string
}
export interface BackupState {
  copies: Record<string, Copy>
  runs: Partial<
    Record<
      BackupTarget | 'snapshots' | 'guard' | 'verify',
      {
        started: string
        finished?: string
        ok: boolean
        /** The T7 was found unplugged; its rows stay off until a run finishes after it's back. */
        unpluggedAt?: string
      }
    >
  >
  points: BackupPoint[]
  goodDriveRuns?: number
}
export const emptyState = (): BackupState => ({ copies: {}, runs: {}, points: [] })
export const homePath = (path: string) => path.replace(/^~(?=\/|$)/, homedir())
export const copyKey = (source: string, target: BackupTarget) => `${target}/${source}`
export function config(env = process.env): BackupConfig {
  const cfg = env.AICO_BACKUPS_CONFIG
    ? (JSON.parse(readFileSync(env.AICO_BACKUPS_CONFIG, 'utf8')) as BackupConfig)
    : structuredClone(defaults)
  const machine = env.AICO_BACKUP_MACHINE || hostname().toLowerCase().split('.')[0]
  const client = cfg.appendClients[machine as keyof typeof cfg.appendClients]
  if (client) {
    cfg.append = { repository: client.repository, passwordFile: client.passwordFile }
    cfg.pve.appendKey = client.key
  }
  const drive = cfg.driveClients[machine as keyof typeof cfg.driveClients]
  return drive ? { ...cfg, drive } : cfg
}
export const migrated = imported
export function driveTarget() {
  const backend = imported.backends.find((b) => b.config.engine === 'restic')
  if (!backend?.config.restic_remote_repository || !backend.config.restic_remote_password_file)
    throw new Error('No migrated Drive repository or password-file reference')
  return {
    repository: backend.config.restic_remote_repository,
    passwordFile: backend.config.restic_remote_password_file,
    rcloneConfig: backend.config.restic_rclone_config,
    pruneQualified: backend.config.restic_offsite_prune_qualified === true,
  }
}
/** The Drive repository this machine writes: its own (`driveClients`), else the workstation's migrated one. */
export const driveSpec = (cfg: BackupConfig) => cfg.drive ?? driveTarget()
export const contains = (parent: string, path: string) =>
  path === parent || path.startsWith(`${parent}/`)
export function coverage(source: Source, target: BackupTarget, cfg: BackupConfig): string | null {
  if (
    source.path.startsWith('proxmox://') ||
    source.path.startsWith('/media/') ||
    source.path.startsWith('/mnt/')
  )
    return target === 'drive' && source.enabled ? source.id : null
  if (target === 'native')
    return (
      [...cfg.nativeSources]
        .sort((a, b) => b.length - a.length)
        .find((root) => root !== '/' && contains(root, source.path)) ??
      (source.path === '/' ? '/' : null)
    )
  if (target === 'drive')
    return (
      Object.entries(cfg.subvolumes).find(([, spec]) =>
        spec.paths.some((p) => contains(p, source.path)),
      )?.[0] ?? null
    )
  return null
}
export interface BackupEntry {
  id: string
  source: string
  name: string
  target: BackupTarget | 'external'
  dataAt: string | null
  nextRun: string | null
  state: 'ok' | 'warn' | 'failed' | 'off'
  meaning: string
  snapshot: string | null
  path: string | null
  running: boolean
  machine: string
  /** The project this backup belongs to (its Status row carries it); absent for the machine's own. */
  project?: string
  /** A retired source whose path is gone: listed for its old copies, but no Status row. */
  gone?: boolean
  /** How old its data may get before it counts as late, in hours. */
  limitHours?: number
}
/** How often a target's backup job runs, in minutes (Drive: daily). */
export function runPeriodMinutes(target: BackupTarget, cfg: BackupConfig): number {
  return target === 'native'
    ? cfg.schedule.localMinutes
    : target === 'append'
      ? cfg.schedule.appendMinutes
      : 1440
}
export function entry(
  source: string,
  name: string,
  target: BackupTarget,
  copy: Copy | undefined,
  cfg: BackupConfig,
  machine: string,
  now: number,
  running = false,
): BackupEntry {
  const limit =
    target === 'native'
      ? cfg.schedule.freshLocalHours
      : target === 'append'
        ? cfg.schedule.freshAppendHours
        : cfg.schedule.freshDriveHours
  const age = copy?.dataAt ? Math.max(0, now - Date.parse(copy.dataAt)) : null
  const fresh = age !== null && age <= limit * 3600000
  // Off is off: its age doesn't count, and the copy it had stands until its next normal run.
  const offline = copy?.observed === 'offline' && !copy.error
  const state = copy?.error ? 'failed' : offline ? 'off' : fresh ? 'ok' : 'warn'
  const meaning = copy?.error
    ? copy.error
    : offline
      ? age === null
        ? 'Machine was off at the last run; no copy of it yet.'
        : 'Machine was off at the last run; its last copy covers the unchanged data.'
      : age === null
        ? 'No verified copy yet.'
        : `${fresh ? 'Restorable data is' : 'Restorable data is late:'} ${spanText(age)} old.`
  const period = runPeriodMinutes(target, cfg)
  const attempted = copy?.attemptedAt && Date.parse(copy.attemptedAt)
  const nextRun = new Date((attempted || now) + period * 60000).toISOString()
  return {
    id: copyKey(source, target),
    source,
    name,
    target,
    dataAt: copy?.dataAt ?? null,
    nextRun,
    state,
    meaning: meaning.slice(0, 300),
    snapshot: copy?.snapshot ?? null,
    path: copy?.path ?? null,
    running,
    machine,
    limitHours: limit,
  }
}
export function entries(
  state: BackupState,
  cfg: BackupConfig,
  machine: string,
  now = Date.now(),
  present?: (source: Source) => boolean,
): BackupEntry[] {
  const all: BackupEntry[] = []
  if (machine === cfg.workstation) {
    for (const source of imported.sources)
      for (const target of ['native', 'drive'] as const) {
        const owner = coverage(source, target, cfg)
        if (owner) {
          const item = entry(
            source.id,
            cfg.displayNames[source.id as keyof typeof cfg.displayNames] ?? source.name,
            target,
            state.copies[copyKey(owner, target)],
            cfg,
            machine,
            now,
          )
          if (source.project_id) item.project = source.project_id
          if (!source.enabled && present && !present(source))
            Object.assign(item, {
              state: 'off',
              dataAt: null,
              nextRun: null,
              running: false,
              meaning: 'This source path is gone. Older snapshots may still contain its files.',
              gone: true,
            })
          all.push(item)
        }
      }
    for (const root of cfg.nativeSources)
      all.push(
        entry(
          root === '/' ? 'root-volume' : root.replaceAll('/', '-').slice(1),
          `${root} recovery`,
          'native',
          state.copies[copyKey(root, 'native')],
          cfg,
          machine,
          now,
        ),
      )
  }
  for (const target of (machine === cfg.workstation || cfg.drive
    ? ['append', 'drive']
    : ['append']) as readonly ('append' | 'drive')[])
    all.push(
      entry(
        `aico-${machine}`,
        'Aico databases and photos',
        target,
        state.copies[copyKey(`aico-${machine}`, target)],
        cfg,
        machine,
        now,
      ),
    )
  if (machine === cfg.workstation) {
    const source = cfg.remoteSqlite.source
    const remote = entry(
      source,
      'Aico on gem · databases and photos',
      'drive',
      state.copies[copyKey(source, 'drive')],
      cfg,
      machine,
      now,
    )
    remote.meaning =
      `${remote.meaning} Copied from gem by the workstation; gem also copies itself to Drive on its own.`.slice(
        0,
        300,
      )
    // This registered source already has a Drive row. Use its plain name and dependency there.
    const existing = all.find((e) => e.source === source && e.target === 'drive')
    if (existing) Object.assign(existing, remote)
  }
  if (machine === cfg.workstation)
    for (const external of migrated.external.filter((s) => s.enabled)) {
      const copy = state.copies[`external/${external.id}`]
      const age = copy?.dataAt
        ? now - Math.max(Date.parse(copy.dataAt), copy.backAt ? Date.parse(copy.backAt) : 0)
        : null
      const fresh =
        age !== null &&
        age <=
          (external.frequency === 'weekly' ? 8 * 86400000 : cfg.schedule.freshDriveHours * 3600000)
      all.push({
        id: `external/${external.id}`,
        source: external.id,
        name: external.name,
        target: 'external',
        dataAt: copy?.dataAt ?? null,
        nextRun: null,
        state:
          copy?.observed === 'offline' ? 'off' : copy?.error ? 'failed' : fresh ? 'ok' : 'warn',
        meaning:
          copy?.observed === 'offline'
            ? copy?.dataAt
              ? 'Machine is off; its last good backup date is shown.'
              : 'Machine is off; no last good backup date is available.'
            : (copy?.error ??
              (fresh
                ? 'The owner backup artifact is current.'
                : 'No current owner backup artifact has been verified.')),
        snapshot: null,
        path: `/status?project=${external.owner_project}`,
        running: false,
        machine,
        project: external.owner_project,
        limitHours: external.frequency === 'weekly' ? 8 * 24 : cfg.schedule.freshDriveHours,
      })
    }
  // Backups of a project's data that no source row names (Proxmox copies, the Aico databases).
  for (const item of all)
    item.project ??= (cfg.sourceProjects as Record<string, string>)[item.source]
  const order = { failed: 0, warn: 1, ok: 2, off: 3 }
  return all.sort((a, b) => order[a.state] - order[b.state] || a.name.localeCompare(b.name))
}
/**
 * The T7 is a portable USB drive: while it is unplugged its rows are off (not late, not failed),
 * like a machine turned off on purpose, and run again once it is back. Only the T7 (native)
 * copies; Drive and CT 160 copies have no such state.
 */
export function markUnplugged(items: BackupEntry[], attached: boolean, waiting = false): void {
  if (attached && !waiting) return
  for (const item of items)
    if (item.target === 'native')
      Object.assign(item, {
        state: 'off',
        nextRun: null,
        running: false,
        meaning: attached
          ? 'The T7 drive is back. Its next run brings it up to date.'
          : 'The T7 drive is unplugged. Backups to it resume when it is plugged in.',
      })
}
export function backupRows(items: BackupEntry[]): StatusRow[] {
  return items.map((item) => ({
    id: `${item.machine}/backup/${item.id}`,
    what: `${item.name} · ${backupTargetName(item.target)}`.slice(0, 120),
    kind: 'backup',
    machine: item.machine,
    ...(item.project ? { project: item.project } : {}),
    state: item.state,
    meaning: item.meaning,
    ...(item.dataAt ? { last_run: item.dataAt } : {}),
    ...(item.nextRun ? { next_run: item.nextRun } : {}),
    actions:
      item.target === 'external'
        ? [
            {
              kind: 'detail',
              ref: `/status?project=${migrated.external.find((s) => s.id === item.source)?.owner_project}`,
            },
          ]
        : item.state === 'off'
          ? [
              {
                kind: 'detail',
                ref: `/backups/restore?source=${encodeURIComponent(item.source)}&target=${item.target}&name=${encodeURIComponent(item.name)}`,
              },
            ]
          : [
              { kind: 'run', ref: `aico backups request ${item.target}` },
              {
                kind: 'detail',
                ref: `/backups/restore?source=${encodeURIComponent(item.source)}&target=${item.target}&name=${encodeURIComponent(item.name)}`,
              },
            ],
  }))
}
export function stateFile(cfg: BackupConfig) {
  return join(homePath(cfg.stateDir), 'state.json')
}
