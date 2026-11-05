// Aico owns the schedule, run receipts, coverage and scratch-only restore boundary.
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { machineId } from '@aico/status'
import { backupJob, driveBackup, stageSqlite } from './backup-drive'
import { observeExternal } from './backup-external'
import { nativeBackup } from './backup-native'
import {
  type BackupConfig,
  type BackupState,
  type BackupTarget,
  backupRows,
  config,
  copyKey,
  coverage,
  entries,
  homePath,
  migrated,
} from './backup-plan'
import { retainDrive, snapshotSweep, verifyDrive } from './backup-retention'
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
    const from = join(point.target, relative(point.source, path)),
      dest = join(to, path)
    if (
      realpathSync(from) !== realpathSync(point.target) &&
      !realpathSync(from).startsWith(realpathSync(point.target) + '/')
    )
      throw new Error('The restored path must stay in the selected snapshot.')
    await checked(rt.run, ['sudo', '-n', 'mkdir', '-p', dirname(dest)])
    await checked(rt.run, ['sudo', '-n', 'cp', '-a', '--reflink=auto', '--', from, dest])
    await checked(rt.run, ['sudo', '-n', 'diff', '-r', '--no-dereference', '--', from, dest])
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
/** Required clean receipts must precede any timer change, even after a failed or interrupted run. */
export function cutoverReady(
  state: BackupState,
  kind: 'host' | 'snapshots' | 'guard' | 'verify',
): boolean {
  const good = (key: keyof BackupState['runs']) =>
    !!state.runs[key]?.ok && !!state.runs[key]?.finished
  return kind === 'host' ? good('native') && good('drive') && good('append') : good(kind)
}
export async function cutover(
  rt: Runtime,
  state: BackupState,
  kind: 'host' | 'snapshots' | 'guard' | 'verify',
) {
  if (!cutoverReady(state, kind))
    throw new Error(
      'The replacement has not completed a clean Aico run; the SummitFlow timer stays enabled.',
    )
  const [scope, unit] = rt.cfg.legacyTimers[kind]
  const system = scope !== '--user'
  await checked(rt.run, [
    ...(system ? ['sudo', '-n'] : []),
    'systemctl',
    '--no-ask-password',
    ...(system ? [] : ['--user']),
    'disable',
    '--now',
    system ? scope : (unit as string),
  ])
  state.cutover[kind] = rt.now().toISOString()
  saveState(rt.cfg, state)
}
export async function report(
  cfg: BackupConfig,
  state: BackupState,
  machine: string,
  run: Execute = execute,
): Promise<void> {
  const rows = backupRows(await scheduledEntries(state, cfg, machine, run))
  const url = process.env.AICO_WEB_URL || cfg.webUrl
  const result = await fetch(new URL('/api/status/rows', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(rows),
    signal: AbortSignal.timeout(10000),
  })
  if (!result.ok) throw new Error(`Could not publish backup Status rows (${result.status}).`)
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
  state.runs[target] = { started, ok: false }
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
      const result = await backupJob(rt, state, { id, ...staged, binds: [] }, 'append')
      state.copies[copyKey(id, 'append')] = result
      if (result.error) throw new Error(result.error)
    } else if (target === 'guard')
      await checked(rt.run, ['sudo', '-n', rt.cfg.windowHelper, 'guard'])
    else await snapshotSweep(rt, scheduled)
    ok = true
  } catch (error) {
    const message = (error as Error).message
    if (target === 'native')
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
    state.runs[target] = { started, finished: rt.now().toISOString(), ok }
    saveRun(rt.cfg, target, state.runs[target] as NonNullable<BackupState['runs'][typeof target]>)
    if (target !== 'snapshots' && target !== 'guard') saveState(rt.cfg, state)
  }
  return ok
}
const USAGE = `Usage: aico backups list | request native|drive|append
  run native|drive|append|snapshots|guard|verify
  snapshots SOURCE [--target native|drive|append]       copies available to restore
  browse SOURCE SNAPSHOT PATH [--target native|drive|append]
  restore SOURCE SNAPSHOT PATH --to /srv/scratch/NEW_FOLDER [--target native|drive|append]
  cutover host|snapshots|guard|verify                    disable the old timer after clean Aico runs
  rollback                                     print how to restore the old schedules
Run commands hold the existing backup lock. Restores only create a new scratch folder.
No key setup, prune or forget commands. Settings: AICO_BACKUPS_CONFIG.`
export async function backups(argv: string[], env = process.env): Promise<number> {
  const cfg = config(env),
    machine = env.AICO_BACKUP_MACHINE || machineId()
  const rt: Runtime = { cfg, run: execute, now: () => new Date() }
  const [verb, ...args] = argv
  if (!verb || ['help', '--help', '-h'].includes(verb)) {
    console.log(USAGE)
    return verb ? 0 : 2
  }
  if (verb === 'rollback') {
    for (const [scope, unit] of Object.values(cfg.legacyTimers))
      console.log(
        `${scope === '--user' ? '' : 'sudo -n '}systemctl --no-ask-password ${scope === '--user' ? '--user ' : ''}enable --now ${scope === '--user' ? unit : scope}`,
      )
    console.log(
      'Remove backup jobs from the Aico jobs file before enabling both schedules together. No units or backup data were deleted.',
    )
    return 0
  }
  if (verb === 'request') {
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
  if (verb === 'run' && env.AICO_BACKUPS_UNIT !== '1') {
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
    const result = await execute([
      'systemd-run',
      '--user',
      '--no-ask-password',
      '--quiet',
      '--collect',
      '--wait',
      `--unit=aico-backup-${target}`,
      ...cfg.runProperties.flatMap((p) => ['--property', p]),
      ...kept,
      '--setenv=AICO_BACKUPS_UNIT=1',
      process.execPath,
      ...process.execArgv,
      ...process.argv.slice(1),
    ])
    if (result.out) process.stdout.write(result.out)
    if (result.err) process.stderr.write(result.err)
    console.log(
      result.code === 0
        ? 'Backup finished.'
        : 'The backup did not finish cleanly. Check its Status row and log.',
    )
    return result.code
  }
  // Work snapshots and the read-only guard keep their original independent schedules.
  // Only native/Drive/append data operations share the old host-recovery lock.
  const lockFiles =
    args[0] === 'snapshots'
      ? [join(homePath('~/.local/share/st/snaps'), 'physical.lock')]
      : args[0] === 'guard'
        ? []
        : [homePath(cfg.sharedLock)]
  if (
    !['list', 'snapshots', 'browse'].includes(verb) &&
    lockFiles.length &&
    env.AICO_BACKUPS_LOCKED !== '1'
  ) {
    for (const path of lockFiles) mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const chain = lockFiles.flatMap((path) => [
      'flock',
      ...(args.includes('--scheduled') ? [] : ['-n', '-E', '75']),
      path,
    ])
    const result = await execute(
      [...chain, process.execPath, ...process.execArgv, ...process.argv.slice(1)],
      { env: { ...env, AICO_BACKUPS_LOCKED: '1' } },
    )
    if (result.out) process.stdout.write(result.out)
    if (result.err) process.stderr.write(result.err)
    if (result.code === 75)
      console.error(
        'Another backup is running. Its data is left alone; run again after it finishes.',
      )
    return result.code
  }
  const state = readState(cfg)
  if (verb === 'list') {
    console.log(
      JSON.stringify({
        machine,
        entries: await scheduledEntries(state, cfg, machine, rt.run),
        runs: state.runs,
        cutover: state.cutover,
      }),
    )
    return 0
  }
  if (verb === 'run') {
    const target = args[0]
    if (!['native', 'drive', 'append', 'snapshots', 'guard', 'verify'].includes(target ?? ''))
      throw new Error(USAGE)
    if (machine !== cfg.workstation && ['native', 'snapshots', 'guard'].includes(target as string))
      throw new Error('Btrfs backup jobs run on the workstation only.')
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
  if (verb === 'cutover') {
    if (!['host', 'snapshots', 'guard', 'verify'].includes(args[0] ?? '')) throw new Error(USAGE)
    await cutover(rt, state, args[0] as 'host' | 'snapshots' | 'guard' | 'verify')
    console.log('The old timer is disabled. Aico owns its schedule.')
    return 0
  }
  const at = args.indexOf('--target'),
    target = at >= 0 ? args[at + 1] : 'drive'
  if (target !== 'drive' && target !== 'append' && target !== 'native')
    throw new Error('Choose Drive or CT 160 for this restore.')
  const [source, snapshot, path] = args
  if (!source) throw new Error(USAGE)
  if (verb === 'snapshots') {
    console.log(JSON.stringify(await snapshotsFor(rt, target, source)))
    return 0
  }
  if (!snapshot || !path) throw new Error(USAGE)
  if (verb === 'browse') {
    if (!(await snapshotsFor(rt, target, source)).some((s) => s.id === snapshot))
      throw new Error('No such snapshot for this source.')
    if (!path.startsWith('/') || path.split('/').includes('..'))
      throw new Error('Choose an absolute path from the snapshot.')
    if (target === 'native') {
      const point = state.points.find((p) => p.target.split('/').at(-1) === snapshot)
      if (!point) throw new Error('That native snapshot is no longer available.')
      const from = join(point.target, relative(point.source, path))
      const resolved = realpathSync(from),
        base = realpathSync(point.target)
      if (resolved !== base && !resolved.startsWith(base + '/'))
        throw new Error('Choose a folder in this snapshot.')
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

export async function scheduledEntries(
  state: BackupState,
  cfg: BackupConfig,
  machine: string,
  run: Execute,
) {
  const items = entries(state, cfg, machine, Date.now(), (source) => {
    if (!source.path.startsWith('/')) return true
    try {
      return statSync(source.path, { throwIfNoEntry: false }) !== undefined
    } catch {
      return true
    }
  })
  const result = await run(['aico', 'jobs', 'list', '--json'])
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
    const job = jobs.find(
      (j) => j.kind === `backups-${item.target}${machine === cfg.workstation ? '' : '-' + machine}`,
    )?.state
    item.nextRun = job ? new Date(job.nextRun).toISOString() : null
    item.running = !!job?.leaseId && !!job.leaseExpires && job.leaseExpires > Date.now()
  }
  return items
}

export function validateScheduledTarget(target: string | undefined): void {
  if (!['native', 'drive', 'append', 'snapshots', 'guard', 'verify'].includes(target ?? ''))
    throw new Error('Unknown backup job target.')
}
export async function requestBackup(rt: Runtime, machine: string, target: string): Promise<void> {
  if (!['native', 'drive', 'append'].includes(target))
    throw new Error('Choose T7, Drive or CT 160.')
  const kind = `backups-${target}${machine === rt.cfg.workstation ? '' : '-' + machine}`
  await checked(rt.run, ['aico', 'jobs', 'run', kind])
}
