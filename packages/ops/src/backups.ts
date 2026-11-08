// Aico owns the schedule, run receipts, coverage and scratch-only restore boundary.
import { existsSync, mkdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { countBackups } from '@aico/shared/backup-count'
import { backupTargetName } from '@aico/shared/backup-targets'
import { aicoDataDir } from '@aico/shared/data-dir'
import { nearest } from '@aico/shared/suggest'
import { ago, localTime } from '@aico/shared/time'
import {
  deleteStatusRow,
  machineId,
  outboxDir,
  postOrKeep,
  postStatusRows,
  type StatusRow,
  statusRowsUrl,
} from '@aico/status'
import { appendMachine, backupJob, driveBackup, stageSqlite } from './backup-drive'
import { observeExternal } from './backup-external'
import { nativeBackup } from './backup-native'
import {
  type BackupConfig,
  type BackupEntry,
  type BackupPoint,
  type BackupState,
  type BackupTarget,
  backupRows,
  config,
  copyKey,
  coverage,
  entries,
  homePath,
  markUnplugged,
  migrated,
  runPeriodMinutes,
} from './backup-plan'
import { retainDrive, scratchSnapshots, snapshotSweep, verifyDrive } from './backup-retention'
import {
  checked,
  type Execute,
  execute,
  type Runtime,
  readState,
  restic,
  resticJson,
  saveRun,
  saveState,
} from './backup-runtime'
import { Refusal } from './deploy'
import { recovery } from './recovery'

export interface Snapshot {
  id: string
  time: string
  paths: string[]
  tags?: string[]
}
export interface FileNode {
  name: string
  path: string
  type: string
  size?: number
}
export async function snapshotsFor(
  rt: Runtime,
  target: BackupTarget,
  source: string,
): Promise<Snapshot[]> {
  const registered = migrated.sources.find((s) => s.id === source)
  if (target === 'native') {
    const mount = registered
      ? coverage(registered, 'native', rt.cfg)
      : rt.cfg.nativeSources.find(
          (p) =>
            p.replaceAll('/', '-').slice(1) === source || (p === '/' && source === 'root-volume'),
        )
    const point = readState(rt.cfg).points.find((p) => p.source === mount)
    return point
      ? [
          {
            id: point.target.split('/').at(-1) as string,
            time: point.dataAt,
            paths: [registered?.path ?? point.source],
          },
        ]
      : []
  }
  const owner = registered ? coverage(registered, target, rt.cfg) : null
  const listing = await resticJson(rt, target, ['snapshots', '--tag', `source:${owner ?? source}`])
  if (!Array.isArray(listing)) throw new Error('The repository returned an invalid snapshot list.')
  return (listing as Snapshot[])
    .filter(
      (s) =>
        /^[a-f0-9]{64}$/.test(s.id) &&
        Number.isFinite(Date.parse(s.time)) &&
        Array.isArray(s.paths),
    )
    .map((s) => (registered?.path.startsWith('/') ? { ...s, paths: [registered.path] } : s))
    .sort((a, b) => Date.parse(b.time) - Date.parse(a.time))
}
export function scratchDestination(root: string, target: string): string {
  const base = realpathSync(root),
    path = resolve(target)
  if (path === base || !path.startsWith(base + '/'))
    throw new Error(`Choose a new folder below ${base}.`)
  let parent = path
  while (!existsSync(parent)) parent = dirname(parent)
  if (
    realpathSync(parent) !== parent ||
    (!realpathSync(parent).startsWith(base + '/') && realpathSync(parent) !== base)
  )
    throw new Error('The scratch destination has a link outside the scratch folder.')
  if (existsSync(path))
    throw new Error('Choose a new scratch folder so existing files are preserved.')
  return path
}
export async function restoreFiles(
  rt: Runtime,
  target: BackupTarget,
  source: string,
  snapshot: string,
  path: string,
  destination: string,
): Promise<{ destination: string }> {
  const selected = (await snapshotsFor(rt, target, source)).find((s) => s.id === snapshot)
  if (!selected) throw new Error('That snapshot does not belong to the selected source.')
  if (
    !path.startsWith('/') ||
    path.split('/').some((p) => p === '..') ||
    !selected.paths.some((p) => path === p || path.startsWith(p.replace(/\/$/, '') + '/'))
  )
    throw new Error('Choose a path contained in this snapshot.')
  const to = scratchDestination(rt.cfg.restoreRoot, destination)
  if (target === 'native') {
    const point = readState(rt.cfg).points.find((p) => p.target.split('/').at(-1) === snapshot)
    if (!point) throw new Error('The native snapshot is no longer available.')
    const from = await nativePath(rt, point, path),
      dest = join(to, path)
    await checked(rt.run, ['sudo', '-n', 'mkdir', '-p', dirname(dest)])
    await checked(rt.run, ['sudo', '-n', 'cp', '-a', '--reflink=auto', '--', from, dest])
    // Live tmux control sockets in Tether's state copy as sockets, but `diff` reports any two sockets as different.
    await checked(rt.run, [
      'sudo',
      '-n',
      'diff',
      '-r',
      '--no-dereference',
      '-x',
      '*.sock',
      '--',
      from,
      dest,
    ])
    await checked(rt.run, [
      'sudo',
      '-n',
      'chown',
      '-R',
      `${process.getuid?.()}:${process.getgid?.()}`,
      to,
    ])
    return { destination: to }
  }
  const result = await restic(rt, target, [
    'restore',
    snapshot,
    '--target',
    to,
    '--include',
    path,
    '--verify',
  ])
  if (result.code)
    throw new Error(`The restore failed (restic exit ${result.code}); inspect its scratch folder.`)
  return { destination: to }
}
export async function nativePath(rt: Runtime, point: BackupPoint, path: string): Promise<string> {
  const from = join(point.target, relative(point.source, path))
  // T7's receive tree is root-only. Resolve it with the same authority as the read/copy below.
  const [resolved, base] = await Promise.all(
    [from, point.target].map(async (p) =>
      (await checked(rt.run, ['sudo', '-n', 'realpath', '-e', '--', p])).trim(),
    ),
  )
  if (!base || (resolved !== base && !resolved.startsWith(`${base}/`)))
    throw new Error('Choose a path contained in this snapshot.')
  return from
}
export async function report(
  cfg: BackupConfig,
  state: BackupState,
  machine: string,
  run: Execute = execute,
): Promise<void> {
  const rows = backupRows(
    (await scheduledEntries(state, cfg, machine, run)).filter((item) => !item.gone),
  )
  const url = process.env.AICO_WEB_URL || cfg.webUrl
  await post(cfg, url, rows)
  await prune(cfg, url, machine, new Set(rows.map((row) => row.id)))
}

/** This machine's backup rows no plan entry writes any more (a retired or gone source). */
async function prune(cfg: BackupConfig, url: string, machine: string, kept: Set<string>) {
  try {
    const query = new URLSearchParams({ kind: 'backup', machine })
    const answer = await fetch(new URL(`/api/status?${query}`, url), {
      signal: AbortSignal.timeout(cfg.statusPublish.timeoutMs),
    })
    if (!answer.ok) return
    const { rows } = (await answer.json()) as { rows: { id: string }[] }
    for (const { id } of rows) {
      // The restore drill writes its own row (recovery.ts).
      if (
        !id.startsWith(`${machine}/backup/`) ||
        kept.has(id) ||
        id === `${machine}/backup/restore-drill`
      )
        continue
      await deleteStatusRow(url, id, { timeoutMs: cfg.statusPublish.timeoutMs })
    }
  } catch (error) {
    // The rows themselves went out; a leftover row is tidied on the next report.
    console.error(`Could not tidy old backup Status rows: ${(error as Error).message}`)
  }
}

async function post(cfg: BackupConfig, url: string, rows: unknown[]): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await postStatusRows(url, rows, { timeoutMs: cfg.statusPublish.timeoutMs })
      if (!result.ok) throw new Error(`Could not publish backup Status rows (${result.status}).`)
      return
    } catch (error) {
      // Like jobs/postJob: boot can start the runner before the local web listener is ready.
      const code =
        (error as { code?: string; cause?: { code?: string } }).cause?.code ??
        (error as { code?: string }).code
      if (code !== 'ECONNREFUSED' || attempt >= cfg.statusPublish.attempts) {
        // Out of tries (aico-web restarting): keep the rows to send later instead of losing them.
        const waiting = await postOrKeep(statusRowsUrl(url), rows as StatusRow[], {
          dir: outboxDir(aicoDataDir()),
          timeoutMs: cfg.statusPublish.timeoutMs,
        })
        if (waiting !== null) console.error(`Backup Status rows will go out later: ${waiting}`)
        return
      }
      await new Promise((resolve) => setTimeout(resolve, cfg.statusPublish.waitMs))
    }
  }
}
export async function runBackup(
  rt: Runtime,
  state: BackupState,
  target: BackupTarget | 'snapshots' | 'guard' | 'verify',
  machine: string,
  scheduled: boolean,
): Promise<boolean> {
  if (target === 'verify' && scheduled && rt.now().getDay() !== rt.cfg.verify.day) return true
  const started = rt.now().toISOString()
  // An unplugged T7 isn't a failed backup or a run: its rows show off, and it runs when it is back.
  const t7Gone = () =>
    target === 'native' && !existsSync(join('/dev/disk/by-uuid', rt.cfg.nativeDriveUuid))
  if (t7Gone()) {
    console.log('The T7 drive is unplugged; nothing to copy to.')
    const last = state.runs.native
    // A run it never got to finish while away isn't a failed one; one that finished keeps its result.
    state.runs.native = {
      ...(last ?? { started }),
      ok: last?.finished ? last.ok : true,
      unpluggedAt: started,
    }
    saveRun(rt.cfg, target, state.runs.native)
    saveState(rt.cfg, state)
    return true
  }
  const away = target === 'native' ? state.runs.native?.unpluggedAt : undefined
  state.runs[target] = { started, ok: false, ...(away ? { unpluggedAt: away } : {}) }
  saveRun(rt.cfg, target, state.runs[target] as NonNullable<BackupState['runs'][typeof target]>)
  if (target !== 'snapshots' && target !== 'guard') saveState(rt.cfg, state)
  let ok = false
  try {
    if (target === 'native') await nativeBackup(rt, state, scheduled)
    else if (target === 'drive') {
      ok = await driveBackup(rt, state, machine, () => saveState(rt.cfg, state))
      if (!ok)
        throw new Error('Some sources did not reach Drive; their last good copies are preserved.')
      if (scheduled && ok) await retainDrive(rt, state)
    } else if (target === 'verify') await verifyDrive(rt, scheduled)
    else if (target === 'append') {
      const staged = stageSqlite(rt.cfg, rt.now()),
        id = `aico-${machine}`
      const ct = await appendMachine(rt)
      const result = await backupJob(
        rt,
        state,
        {
          id,
          ...staged,
          binds: [],
          ...(ct ? { machine: ct, offline: ct.before.state === 'off' } : {}),
        },
        'append',
      )
      state.copies[copyKey(id, 'append')] = result
      if (result.error) throw new Error(result.error)
    } else if (target === 'guard')
      await checked(rt.run, ['sudo', '-n', rt.cfg.windowHelper, 'guard'])
    else {
      await scratchSnapshots(rt, scheduled)
      await snapshotSweep(rt, scheduled)
    }
    ok = true
  } catch (error) {
    const message = (error as Error).message
    // Pulled out mid-run: the same, not a failure.
    if (t7Gone()) ok = true
    else if (target === 'native')
      for (const root of rt.cfg.nativeSources)
        state.copies[copyKey(root, 'native')] = {
          ...state.copies[copyKey(root, 'native')],
          source: root,
          target: 'native',
          attemptedAt: started,
          error: message,
        }
    console.error(message)
  } finally {
    const finished = rt.now().toISOString()
    state.runs[target] = { started, finished, ok, ...(t7Gone() ? { unpluggedAt: finished } : {}) }
    saveRun(rt.cfg, target, state.runs[target] as NonNullable<BackupState['runs'][typeof target]>)
    if (target !== 'snapshots' && target !== 'guard') saveState(rt.cfg, state)
  }
  return ok
}
/** Exit code for "another run of this backup holds the lock": the scheduler records it as busy, not failed. */
const BUSY_EXIT = 75

const USAGE = `Usage:
  aico backups [list] [--json]                          backup health: problems first, one line per target
  aico backups request native|drive|append              run that backup now (same run as aico routines run backups-TARGET)
  aico backups recover bootstrap --machine workstation|gem --to /srv/scratch/NEW_FOLDER [--plan]
  aico backups recover check|snapshots|restore|repair --repository REPO --password-file FILE [--to NEW_FOLDER] [--snapshot ID]
  aico backups drill [--plan] [--scheduled]             monthly scratch restore and live Aico counts
  aico backups run native|drive|append|snapshots|guard|verify
  aico backups run snapshots --pressure [--scratch-only]  disk pressure: scratch's snapshots go, then only the newest work points stay
  aico backups snapshots SOURCE [--target native|drive|append] [--all] [--json]  newest copies to restore
  aico backups browse SOURCE SNAPSHOT PATH [--target native|drive|append]
  aico backups restore SOURCE SNAPSHOT PATH --to /srv/scratch/NEW_FOLDER [--target native|drive|append]
Run commands hold the existing backup lock. Restores only create a new scratch folder.
No key setup, prune or forget commands. Settings: AICO_BACKUPS_CONFIG.`

/** Without --all, how many copies `snapshots` lists. */
const SNAPSHOTS_SHOWN = 10
const VERBS = ['list', 'request', 'recover', 'drill', 'run', 'snapshots', 'browse', 'restore']

/** The usage lines of one backups command ("aico backups restore ..."), or all of them. */
export function backupsUsage(verb?: string): string {
  const mine = USAGE.split('\n').filter((line) => line.startsWith(`  aico backups ${verb} `))
  return mine.length ? `Usage:\n${mine.join('\n')}` : USAGE
}

/** The mistakes a command line can have, named before anything runs (exit 2). */
function check(verb: string, args: string[]): void {
  const need = (what: string) => {
    throw new Refusal(`${verb} needs ${what}\n${backupsUsage(verb)}`, 2)
  }
  const [first, second, third] = args
  const target = args.indexOf('--target')
  if (target >= 0 && !['native', 'drive', 'append'].includes(args[target + 1] ?? ''))
    throw new Refusal(`${verb}: --target is native, drive or append`, 2)
  if (verb === 'request' && !['native', 'drive', 'append'].includes(first ?? ''))
    need('native, drive or append')
  else if (
    verb === 'run' &&
    !['native', 'drive', 'append', 'snapshots', 'guard', 'verify'].includes(first ?? '')
  )
    need('what to run: native, drive, append, snapshots, guard or verify')
  else if (verb === 'snapshots' && !first) need('a SOURCE (aico backups list names them)')
  else if (verb === 'browse' && !(first && second && third)) need('SOURCE SNAPSHOT PATH')
  else if (verb === 'restore') {
    if (!(first && second && third && !first.startsWith('--') && !second.startsWith('--')))
      need('SOURCE SNAPSHOT PATH --to FOLDER')
    if (!args[args.indexOf('--to') + 1] || args.indexOf('--to') < 0)
      need('--to FOLDER (a new scratch folder)')
  }
}

/** `aico backups request TARGET`: ask for a backup to run now. */
async function requestCommand(rt: Runtime, machine: string, args: string[]): Promise<number> {
  const target = args[0]
  if (!['native', 'drive', 'append'].includes(target ?? '')) throw new Error(USAGE)
  await requestBackup(rt, machine, target as string)
  console.log(
    JSON.stringify({
      message: 'Backup is due now. Its last good data age updates when it finishes.',
    }),
  )
  return 0
}

/** `aico backups run TARGET` outside its unit: start it as a transient user
 * unit so it outlives this process. */
async function runInUnit(
  cfg: Runtime['cfg'],
  env: NodeJS.ProcessEnv,
  args: string[],
): Promise<number> {
  const target = args[0]
  validateScheduledTarget(target)
  // A backup survives the scheduler or web app restarting. Keep the previous CPU/IO/memory policy.
  const kept = [
    'HOME',
    'PATH',
    'XDG_RUNTIME_DIR',
    'DBUS_SESSION_BUS_ADDRESS',
    'AICO_BACKUPS_CONFIG',
    'AICO_WEB_URL',
    'AICO_BACKUP_MACHINE',
    'AICO_DATA_DIR',
    'AICO_WEB_DB',
    'XDG_STATE_HOME',
  ].flatMap((key) => (env[key] ? [`--setenv=${key}=${env[key]}`] : []))
  const unit = `aico-backup-${target}${args.includes('--pressure') ? '-pressure' : ''}`
  const live = async () =>
    (await execute(['systemctl', '--user', 'is-active', '--quiet', unit])).code === 0
  // One run of a backup at a time: a second finds the live unit and says so, it does not fail.
  const busy = () => {
    console.log(`Already running: the ${target} backup is in progress, so this run did nothing.`)
    return BUSY_EXIT
  }
  if (await live()) return busy()
  const result = await execute([
    'systemd-run',
    '--user',
    '--no-ask-password',
    '--quiet',
    '--collect',
    '--wait',
    `--unit=${unit}`,
    ...cfg.runProperties.flatMap((p) => ['--property', p]),
    ...kept,
    '--setenv=AICO_BACKUPS_UNIT=1',
    process.execPath,
    ...process.execArgv,
    ...process.argv.slice(1),
  ])
  // Two starters raced for the unit name and the other won: the same answer.
  if (
    result.code !== 0 &&
    /already exists|already loaded/i.test(`${result.out}${result.err}`) &&
    (await live())
  )
    return busy()
  if (result.out) process.stdout.write(result.out)
  if (result.err) process.stderr.write(result.err)
  if (result.code === BUSY_EXIT) return busy()
  console.log(
    result.code === 0
      ? 'Backup finished.'
      : `The backup did not finish cleanly. ${failedSourcesLine(readState(cfg), target as string)} Its log: aico logs ${unit}.`,
  )
  return result.code
}

/** Which sources a failed run left failing, for the line the routine's log and Status show. */
export function failedSourcesLine(state: BackupState, target: string): string {
  const failed = Object.values(state.copies)
    .filter((copy) => copy.target === target && copy.error)
    .map((copy) => copy.source)
  return failed.length
    ? `Failed: ${failed.join(', ')}.`
    : 'Which sources failed: aico backups list.'
}

/** systemd counts dying of SIGINT as a clean exit, so a stopped run would report "Backup finished". */
export function stopReadsFailed(): void {
  process.once('SIGINT', () => process.exit(130))
}

/**
 * Only a backup run takes the shared lock. Listing, browsing and restoring read a repository and
 * write to a new scratch folder; restic's own shared lock already keeps them safe beside a backup,
 * so a restore never waits out a Drive backup.
 */
export const holdsBackupLock = (verb: string): boolean => verb === 'run'

/** Run this same command again under the shared backup lock (flock). */
async function runUnderLock(
  env: NodeJS.ProcessEnv,
  args: string[],
  lockFiles: string[],
): Promise<number> {
  for (const path of lockFiles) mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const chain = lockFiles.flatMap((path) => [
    'flock',
    ...(args.includes('--scheduled') ? [] : ['-n', '-E', String(BUSY_EXIT)]),
    path,
  ])
  const result = await execute(
    [...chain, process.execPath, ...process.execArgv, ...process.argv.slice(1)],
    { env: { ...env, AICO_BACKUPS_LOCKED: '1' } },
  )
  if (result.out) process.stdout.write(result.out)
  if (result.err) process.stderr.write(result.err)
  if (result.code === BUSY_EXIT)
    console.error('Another backup is running. Its data is left alone; run again after it finishes.')
  return result.code
}

/** `aico backups list`. */
async function listCommand(
  rt: Runtime,
  state: BackupState,
  machine: string,
  args: string[],
): Promise<number> {
  const { cfg } = rt
  const list = {
    machine,
    entries: await scheduledEntries(state, cfg, machine, rt.run),
    runs: state.runs,
  }
  console.log(args.includes('--json') ? JSON.stringify(list) : listText(list, Date.now()))
  return 0
}

/** `aico backups run TARGET`, inside its unit. */
async function runCommand(
  rt: Runtime,
  state: BackupState,
  machine: string,
  args: string[],
): Promise<number> {
  const { cfg } = rt
  const target = args[0]
  if (!['native', 'drive', 'append', 'snapshots', 'guard', 'verify'].includes(target ?? ''))
    throw new Error(USAGE)
  if (machine !== cfg.workstation && ['native', 'snapshots', 'guard'].includes(target as string))
    throw new Error('Btrfs backup jobs run on the workstation only.')
  if (args.includes('--pressure')) {
    if (target !== 'snapshots') throw new Error('Only snapshots thin under --pressure.')
    // The space guard's reclaim tier: thin now, take no new point, leave the schedule's record alone.
    const scratch = await scratchSnapshots(rt, true, true)
    const deleted = args.includes('--scratch-only') ? 0 : await snapshotSweep(rt, true, true)
    console.log(JSON.stringify({ ok: true, target, pressure: true, deleted, scratch }))
    return 0
  }
  const ok = await runBackup(
    rt,
    state,
    target as BackupTarget | 'snapshots' | 'guard' | 'verify',
    machine,
    args.includes('--scheduled'),
  )
  if (machine === cfg.workstation && target !== 'snapshots' && target !== 'guard') {
    await observeExternal(rt, state)
    saveState(cfg, state)
  }
  await report(cfg, readState(cfg), machine)
  console.log(
    JSON.stringify({
      ok,
      target,
      message: ok
        ? 'Backup finished.'
        : 'Some backup sources failed. Check Backups for the last good data age.',
    }),
  )
  return ok ? 0 : 1
}

/** One line per copy with the id restore and browse take; newest few unless --all. */
export function snapshotLines(
  found: Snapshot[],
  source: string,
  target: string,
  all: boolean,
): string {
  if (!found.length) return `No copies of ${source} on ${backupTargetName(target)}.`
  const shown = all ? found : found.slice(0, SNAPSHOTS_SHOWN)
  const lines = [
    `${found.length} copies of ${source} on ${backupTargetName(target)}, newest first:`,
  ]
  for (const s of shown) lines.push(`  ${new Date(s.time).toLocaleString()}  ${s.id}`)
  if (shown.length < found.length)
    lines.push(`${found.length - shown.length} older: add --all (--json for every field).`)
  lines.push(
    `To restore: aico backups restore ${source} ID PATH --to /srv/scratch/NEW_FOLDER --target ${target}`,
  )
  return lines.join('\n')
}

/** `aico backups snapshots|browse|restore SOURCE ...`: read or restore one source's snapshots. */
async function sourceCommand(
  rt: Runtime,
  state: BackupState,
  verb: string,
  args: string[],
): Promise<number> {
  const at = args.indexOf('--target'),
    target = at >= 0 ? args[at + 1] : 'drive'
  if (target !== 'drive' && target !== 'append' && target !== 'native')
    throw new Error('Choose Drive or CT 160 for this restore.')
  const [source, snapshot, path] = args
  if (!source) throw new Error(USAGE)
  if (verb === 'snapshots') {
    const found = await snapshotsFor(rt, target, source)
    console.log(
      args.includes('--json')
        ? JSON.stringify(found)
        : snapshotLines(found, source, target, args.includes('--all')),
    )
    return 0
  }
  if (!snapshot || !path) throw new Error(USAGE)
  if (verb === 'browse') {
    const selected = (await snapshotsFor(rt, target, source)).find((s) => s.id === snapshot)
    if (!selected) throw new Error('No such snapshot for this source.')
    if (
      !path.startsWith('/') ||
      path.split('/').includes('..') ||
      !selected.paths.some((p) => path === p || path.startsWith(p.replace(/\/$/, '') + '/'))
    )
      throw new Error('Choose an absolute path from the snapshot.')
    if (target === 'native') {
      const point = state.points.find((p) => p.target.split('/').at(-1) === snapshot)
      if (!point) throw new Error('That native snapshot is no longer available.')
      const from = await nativePath(rt, point, path)
      const result = await checked(rt.run, [
        'sudo',
        '-n',
        'find',
        from,
        '-mindepth',
        '1',
        '-maxdepth',
        '1',
        '-printf',
        '%f\t%y\t%s\n',
      ])
      console.log(
        JSON.stringify(
          result
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => {
              const [name, type, size] = line.split('\t')
              return {
                name,
                path: join(path, name as string),
                type: type === 'd' ? 'dir' : 'file',
                size: Number(size),
              }
            }),
        ),
      )
      return 0
    }
    const result = await restic(rt, target, ['ls', snapshot, path])
    if (result.code) throw new Error('Could not read the snapshot folder.')
    console.log(
      JSON.stringify(
        result.out
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l) as FileNode)
          .filter((n) => n.type),
      ),
    )
    return 0
  }
  if (verb === 'restore') {
    const to = args.indexOf('--to')
    if (to < 0 || !args[to + 1]) throw new Error(USAGE)
    console.log(
      JSON.stringify(
        await restoreFiles(rt, target, source, snapshot, path, args[to + 1] as string),
      ),
    )
    return 0
  }
  throw new Error(USAGE)
}

export async function backups(argv: string[], env = process.env): Promise<number> {
  // Bare `aico backups` (or only --json) lists.
  const [verb, ...args] =
    !argv[0] || (argv[0].startsWith('-') && !['--help', '-h'].includes(argv[0]))
      ? ['list', ...argv]
      : argv
  if (['help', '--help', '-h'].includes(verb as string)) {
    console.log(USAGE)
    return 0
  }
  // Mistakes and help are answered before any configuration or host is read.
  if (!VERBS.includes(verb as string)) {
    const near = nearest(verb as string, VERBS)
    throw new Refusal(
      `unknown command ${verb}${near ? ` (did you mean ${near}?)` : ''}; aico backups --help lists them`,
      2,
    )
  }
  if (args.includes('--help') || args.includes('-h')) {
    console.log(backupsUsage(verb))
    return 0
  }
  if (verb !== 'recover' && verb !== 'drill') check(verb as string, args)
  const cfg = config(env),
    machine = env.AICO_BACKUP_MACHINE || machineId()
  const rt: Runtime = { cfg, run: execute, now: () => new Date() }
  if (verb === 'recover' || verb === 'drill') return recovery([verb, ...args], cfg, env)
  if (verb === 'request') return requestCommand(rt, machine, args)
  if (verb === 'run' && env.AICO_BACKUPS_UNIT !== '1') return runInUnit(cfg, env, args)
  if (verb === 'run') stopReadsFailed()
  // Work snapshots and the read-only guard keep their original independent schedules.
  // Only native/Drive/append data operations share the old host-recovery lock.
  const lockFiles =
    args[0] === 'snapshots'
      ? [join(homePath('~/.local/share/st/snaps'), 'physical.lock')]
      : args[0] === 'guard'
        ? []
        : [homePath(cfg.sharedLock)]
  if (holdsBackupLock(verb) && lockFiles.length && env.AICO_BACKUPS_LOCKED !== '1') {
    if (verb !== 'run' || !args.includes('--scheduled')) return runUnderLock(env, args, lockFiles)
    // A scheduled run can wait behind another backup for hours. Keep telling Status it's under way
    // so its rows don't read late, and never let a hung probe hold up the backup itself.
    const { runReportSeconds, runReportTimeoutSeconds } = cfg.schedule
    const bounded: Execute = (argv, options) =>
      execute(argv, { ...options, timeout: runReportTimeoutSeconds * 1000 })
    let telling: Promise<void> | null = null
    const tell = () => {
      telling ??= report(cfg, readState(cfg), machine, bounded)
        .catch((error) =>
          console.error(`Could not tell Status this run started: ${(error as Error).message}`),
        )
        .finally(() => {
          telling = null
        })
      return telling
    }
    await tell()
    const every = setInterval(() => void tell(), runReportSeconds * 1000)
    try {
      return await runUnderLock(env, args, lockFiles)
    } finally {
      clearInterval(every)
      // A report still under way carries what was true before the run's own last one: say it again.
      await telling
      await tell()
    }
  }
  const state = readState(cfg)
  if (verb === 'list') return listCommand(rt, state, machine, args)
  if (verb === 'run') return runCommand(rt, state, machine, args)
  return sourceCommand(rt, state, verb as string, args)
}

const since = (iso: string | null | undefined, now: number) =>
  iso ? ago(Date.parse(iso), now) : 'never'

/** `aico backups list` for a person: problems first, each target in one line, archived sources folded. */
export function listText(
  list: { machine: string; entries: BackupEntry[]; runs: BackupState['runs'] },
  now: number,
): string {
  const lines: string[] = []
  const gone = list.entries.filter((e) => e.gone)
  const live = list.entries.filter((e) => !e.gone)
  // A machine that is off is not a problem Status raises: it is counted apart, with its last good copy.
  const away = live.filter((e) => e.state === 'off')
  const problems = live.filter((e) => e.state !== 'ok' && e.state !== 'off')
  // Counted per source, the way the web list counts, with the copies beside it.
  const { current, late, failed, archived, away: awaySources, copies } = countBackups(list.entries)
  const bad = late + failed
  const parts = [
    `${bad ? '' : 'All '}${current} ${current === 1 ? 'source' : 'sources'} current (${copies} ${copies === 1 ? 'copy' : 'copies'})`,
    bad ? `${bad} need a look` : '',
    awaySources ? `${awaySources} on a machine that is off` : '',
    archived ? `${archived} archived` : '',
  ].filter(Boolean)
  lines.push(`Backups on ${list.machine}: ${parts.join(', ')}.`)
  if (away.length) {
    lines.push('', 'On a machine that is off:')
    for (const e of away)
      lines.push(
        `  ${backupTargetName(e.target).padEnd(13)} ${e.name}: ${e.dataAt ? `last good copy ${since(e.dataAt, now)}` : 'no good copy date known'}`,
      )
  }
  if (problems.length) {
    lines.push('', 'Need a look:')
    for (const e of problems)
      lines.push(
        `  ${e.state.padEnd(6)} ${backupTargetName(e.target).padEnd(13)} ${e.name}: ${e.meaning}`,
      )
  }
  lines.push('', 'By target:')
  for (const target of ['native', 'drive', 'append', 'external']) {
    const rows = live.filter((e) => e.target === target)
    if (!rows.length) continue
    const ok = rows.filter((e) => e.state === 'ok').length
    const newest = rows
      .map((e) => e.dataAt)
      .filter((at): at is string => !!at)
      .sort()
      .at(-1)
    const run = list.runs[target as BackupTarget]
    const last = run
      ? `; last run ${since(run.finished ?? run.started, now)}${run.finished ? (run.ok ? ', ok' : ', failed') : ', running'}`
      : ''
    // While it runs, nextRun is Status's deadline for the run, not the schedule's next start.
    const next =
      run && !run.finished
        ? undefined
        : rows
            .map((e) => e.nextRun)
            .filter((at): at is string => !!at)
            .sort()[0]
    lines.push(
      `  ${backupTargetName(target).padEnd(13)} ${ok}/${rows.length} ok; newest data ${since(newest, now)}${last}${next ? `; next ${localTime(next)}` : ''}`,
    )
  }
  if (gone.length)
    lines.push(
      '',
      `Archived (source gone; older copies still hold them): ${[...new Set(gone.map((e) => e.name))].join(', ')}.`,
    )
  lines.push('', 'Every entry with paths and snapshots: aico backups list --json')
  return lines.join('\n')
}

export async function scheduledEntries(
  state: BackupState,
  cfg: BackupConfig,
  machine: string,
  run: Execute,
) {
  // Read the current guest state on each listing; restarting a guest must remove the off state.
  const observed = { ...state, copies: { ...state.copies } }
  // The job list and the guest probes are independent; run them together.
  const jobsRun = run(['aico', 'jobs', 'list', '--json'])
  if (machine === cfg.workstation)
    await observeExternal(
      { cfg, run, now: () => new Date() },
      observed,
      Object.entries(cfg.externalProbes)
        .filter(([, probe]) => 'statusCommand' in probe)
        .map(([id]) => id),
    )
  const items = entries(observed, cfg, machine, Date.now(), (source) => {
    if (!source.path.startsWith('/')) return true
    try {
      return statSync(source.path, { throwIfNoEntry: false }) !== undefined
    } catch {
      return true
    }
  })
  if (machine === cfg.workstation)
    markUnplugged(
      items,
      existsSync(join('/dev/disk/by-uuid', cfg.nativeDriveUuid)),
      Boolean(state.runs.native?.unpluggedAt),
    )
  const result = await jobsRun
  let jobs: {
    kind: string
    state: { nextRun: number; leaseId: string | null; leaseExpires: number | null } | null
  }[] = []
  if (result.code === 0)
    try {
      jobs = JSON.parse(result.out)
    } catch {}
  for (const item of items) {
    if (item.state === 'off') {
      item.nextRun = null
      item.running = false
      continue
    }
    const job = jobs.find((j) => j.kind === backupJobKind(cfg, machine, item.target))?.state
    item.running = !!job?.leaseId && !!job.leaseExpires && job.leaseExpires > Date.now()
    // While the job runs, the scheduler still holds the due time it started at; posting that would
    // show the row late from the run's first report until the next one. Due a period after now,
    // as the scheduler sets it when the run completes. A run stuck past `runStuckHours` stops being
    // moved on, so a hung backup does read late.
    const due =
      job && item.running && item.target !== 'external'
        ? Math.max(
            job.nextRun,
            Math.min(
              Date.now() + runPeriodMinutes(item.target, cfg) * 60000,
              job.nextRun + cfg.schedule.runStuckHours * 3600000,
            ),
          )
        : job?.nextRun
    item.nextRun = due !== undefined ? new Date(due).toISOString() : null
  }
  return items
}

/** The scheduler job that runs a target's backup on a machine (packages/jobs/data/jobs.json). */
const backupJobKind = (cfg: BackupConfig, machine: string, target: string) =>
  `backups-${target}${machine === cfg.workstation ? '' : `-${machine}`}`

export function validateScheduledTarget(target: string | undefined): void {
  if (!['native', 'drive', 'append', 'snapshots', 'guard', 'verify'].includes(target ?? ''))
    throw new Error('Unknown backup job target.')
}
export async function requestBackup(rt: Runtime, machine: string, target: string): Promise<void> {
  if (!['native', 'drive', 'append'].includes(target))
    throw new Error('Choose T7, Drive or CT 160.')
  await checked(rt.run, ['aico', 'jobs', 'run', backupJobKind(rt.cfg, machine, target)])
}
