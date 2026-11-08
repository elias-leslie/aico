// `aico routines ...`: the owner-facing list of every scheduled routine, and how a project
// registers its own (a routine is a job another project owns: same lease, run and Status row).

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { peerDir } from '@aico/fleet/hosts'
import type { StatusRow } from '@aico/status'
import { LOG_LINES, remoteAuthority } from './fleet-leases'
import { type JobDef, resumeAt, runTime, schedule } from './jobs'
import type { JobState, JobStore } from './leases'
import { type EitherHosts, newRoutine, type RoutineInput } from './routines'
import { jobRow, type LeaseAuthority } from './runner'
import {
  controlTimer,
  type RunCommand,
  readTimerStatus,
  type TimerDef,
  type TimerStatus,
  type TimersFile,
  timerKind,
  timerLog,
} from './systemd-timers'

const ROUTINES_USAGE = `Usage: aico routines <command>
  list [KIND] [--json]  every routine (or those matching KIND): project, schedule, next run, how it last went
  add --project P --kind K --what "..." (--at HH:MM [--on DAY] | --every MINUTES)
      (--post /aico/path | --command ARGV...) [--cwd DIR] [--hosts either|this] [--scope user|system] [--lease SECONDS]
                     register a routine; --command takes the rest of the line, so it goes last
  remove KIND        unregister a routine you added (built-in ones live in jobs.json)
  pause KIND         stop its scheduled runs (Run now still works)
  resume KIND        schedule it again
  run KIND           run it now; its worker starts it within seconds
  log KIND           the output of its last run
--at is the local time of the machine it runs on (--hosts either: the zone jobs.json names for the pair).
--on DAY picks the day for --at: mon (every Monday), 1st-sat (the first Saturday of each month; 1st, 2nd,
3rd, 4th or last) or day-15 (the 15th of each month, 1 to 28). Without it the routine runs daily.
Timers that stay in systemd (watchdogs, host jobs) are listed too, read-only: run, pause and resume
start, disable and enable the timer; their definitions are in packages/jobs/data/systemd-timers.json.
--hosts either runs it on whichever of the two Aico machines is online (never twice for one slot);
run add on a machine that can run it: it registers the routine on the other one over the fleet link.
A failed routine shows in Status and the morning digest; it reaches the phone only if its own
command sends an \`aico notify\` that asks for it.`

type Control = LeaseAuthority & {
  run(kind: string): boolean | Promise<boolean>
  pause(kind: string): boolean | Promise<boolean>
  resume(kind: string): boolean | Promise<boolean>
}

export interface RoutinesContext {
  jobs: readonly JobDef[]
  store: JobStore
  machine: string
  env: NodeJS.ProcessEnv
  dataDir: string
  /** The machines `--hosts either` means (jobs.json). */
  either?: EitherHosts | null
  /** Timers that stay in systemd and show in the list (data/systemd-timers.json). */
  timers?: TimersFile | null
  /** How systemctl commands run (tests give their own). */
  runCommand?: RunCommand
  /** The lease link to another machine (tests give their own). */
  peer?: (
    name: string,
  ) => Pick<ReturnType<typeof remoteAuthority>, 'register' | 'unregister' | 'log'> &
    Partial<Pick<ReturnType<typeof remoteAuthority>, 'get'>>
  /** Sends Status rows to aico-web; failures are the caller's to ignore. */
  postRows: (rows: StatusRow[]) => Promise<void>
  removeRow: (id: string) => Promise<void>
  now?: () => number
}

/** One routine as the list and the web app read it. */
export interface RoutineView {
  kind: string
  what: string
  project: string
  source: 'built-in' | 'registered' | 'systemd'
  home: string
  /** Every machine that may run it, and the one that holds its lease. */
  hosts: string[]
  /** The zone `at` is read in (registered routines). */
  tz?: string
  leaseHost: string
  schedule: string
  at?: string
  /** The day `at` runs on (mon, 1st-sat, day-15); absent: daily. */
  on?: string
  every_min?: number
  scope: 'user' | 'system'
  command?: string[]
  post?: string
  cwd?: string
  paused: boolean
  running: boolean
  /** False until the scheduler has picked the routine up. */
  started: boolean
  nextRun: number | null
  lastRun: number | null
  lastState: 'ok' | 'warn' | 'failed' | null
  lastMeaning: string | null
  lastMachine: string | null
  /** Why the state could not be read (the lease holder's machine did not answer). */
  unreadable?: string
}

const timerCtx = (ctx: RoutinesContext) => ({
  machine: ctx.machine,
  env: ctx.env,
  ...(ctx.runCommand ? { run: ctx.runCommand } : {}),
})

function controlOf(job: JobDef, ctx: RoutinesContext): Control {
  const holder = job.lease_host ?? job.home
  if (holder !== ctx.machine)
    return remoteAuthority(join(peerDir(ctx.env, process.getuid?.(), holder), 'jobs.sock'))
  const now = ctx.now ?? Date.now
  return {
    claim: (...args) => ctx.store.claim(...args),
    renew: (lease, at, ttl) => ctx.store.renew(lease, at, ttl),
    complete: (lease, result, ranAt, next) => ctx.store.complete(lease, result, ranAt, next),
    release: (lease, retryAt) => ctx.store.release(lease, retryAt),
    get: (kind) => ctx.store.get(kind),
    run: (kind) => ctx.store.runNow(kind, now()),
    pause: (kind) => ctx.store.setPaused(kind, true, now()),
    resume: (kind) => ctx.store.setPaused(kind, false, resumeAt(job, now())),
  }
}

const peerOf = (name: string, ctx: RoutinesContext) =>
  ctx.peer?.(name) ?? remoteAuthority(join(peerDir(ctx.env, process.getuid?.(), name), 'jobs.sock'))

/** The lease holder's state of a job (this machine's own store when it holds the lease). */
async function stateOf(job: JobDef, ctx: RoutinesContext): Promise<JobState | null> {
  const holder = job.lease_host ?? job.home
  if (holder === ctx.machine) return ctx.store.get(job.kind)
  const peer = ctx.peer?.(holder)
  return peer?.get ? peer.get(job.kind) : controlOf(job, ctx).get(job.kind)
}

async function viewOf(job: JobDef, ctx: RoutinesContext): Promise<RoutineView> {
  const now = (ctx.now ?? Date.now)()
  let state: JobState | null = null
  let unreadable: string | undefined
  try {
    state = await controlOf(job, ctx).get(job.kind)
  } catch (error) {
    unreadable = (error as Error).message
  }
  return {
    kind: job.kind,
    what: job.what,
    project: job.project,
    source: job.source ?? 'built-in',
    home: job.home,
    hosts: job.workers ?? [job.home],
    ...(job.tz ? { tz: job.tz } : {}),
    leaseHost: job.lease_host ?? job.home,
    schedule: schedule(job),
    ...(job.at !== undefined ? { at: job.at } : {}),
    ...(job.on !== undefined ? { on: job.on } : {}),
    ...(job.every_min !== undefined ? { every_min: job.every_min } : {}),
    scope: job.scope ?? 'user',
    ...('command' in job.run ? { command: job.run.command } : { post: job.run.post }),
    ...(job.cwd ? { cwd: job.cwd } : {}),
    paused: state?.paused ?? false,
    running: !!state?.leaseId && (state.leaseExpires ?? 0) > now,
    started: state !== null,
    nextRun: state && !state.paused ? state.nextRun : null,
    lastRun: state?.lastRun ?? null,
    lastState: (state?.lastState as RoutineView['lastState']) ?? null,
    lastMeaning: state?.lastMeaning ?? null,
    lastMachine: state?.lastMachine ?? null,
    ...(unreadable ? { unreadable } : {}),
  }
}

/** A systemd timer as a routine row: its last result is the service's. */
function timerView(status: TimerStatus, file: TimersFile | null | undefined): RoutineView {
  const tz = file?.hosts[status.def.host]?.tz
  const { def } = status
  const failed = status.result !== 'success'
  const unread =
    status.unreadable ??
    (status.installed ? undefined : `${def.unit} is not installed on ${def.host}`)
  const common = {
    kind: timerKind(def),
    what: def.what,
    project: def.project,
    source: 'systemd' as const,
    home: def.host,
    hosts: [def.host],
    leaseHost: def.host,
    schedule: def.schedule,
    ...(tz ? { tz } : {}),
    scope: def.scope,
    command: [def.unit],
    started: true,
    lastMachine: def.host,
  }
  if (unread)
    return {
      ...common,
      paused: false,
      running: false,
      nextRun: null,
      lastRun: null,
      lastState: null,
      lastMeaning: null,
      unreadable: unread,
    }
  const ran = status.last !== null
  return {
    ...common,
    paused: !status.active,
    running: status.running,
    nextRun: status.active ? status.next : null,
    lastRun: status.last,
    lastState: failed ? 'failed' : ran ? 'ok' : null,
    lastMeaning: failed
      ? `Failed (${status.result}${status.exitStatus ? `, exit ${status.exitStatus}` : ''}).`
      : ran
        ? 'Finished OK.'
        : null,
  }
}

const time = runTime

/** Flags of `add`, parsed; `--command` takes the rest of the line. */
export function parseAdd(args: readonly string[]): RoutineInput {
  const input: Partial<RoutineInput> = {}
  const values = new Map<string, string>()
  for (let i = 0; i < args.length; i++) {
    const flag = args[i] as string
    if (flag === '--command') {
      const rest = args.slice(i + 1)
      if (rest[0] === '--') rest.shift()
      input.command = rest
      break
    }
    if (!flag.startsWith('--')) throw new Error(`unexpected '${flag}'`)
    const value = args[i + 1]
    if (value === undefined) throw new Error(`${flag} needs a value`)
    values.set(flag.slice(2), value)
    i++
  }
  const known = [
    'project',
    'kind',
    'what',
    'at',
    'on',
    'every',
    'post',
    'cwd',
    'host',
    'hosts',
    'scope',
    'lease',
  ]
  const unknown = [...values.keys()].find((key) => !known.includes(key))
  if (unknown) throw new Error(`unknown option --${unknown}`)
  for (const field of ['project', 'kind', 'what'] as const)
    if (!values.get(field)) throw new Error(`--${field} is required`)
  const every = values.get('every')
  const lease = values.get('lease')
  if ((values.get('at') === undefined) === (every === undefined))
    throw new Error('give exactly one schedule: --at HH:MM (daily) or --every MINUTES')
  if (values.has('on') && !values.has('at'))
    throw new Error('--on needs --at HH:MM (the time of day on that day)')
  if (input.command?.length === 0) throw new Error('--command needs the program and its arguments')
  return {
    kind: values.get('kind') as string,
    project: values.get('project') as string,
    what: values.get('what') as string,
    ...(values.has('at') ? { at: values.get('at') } : {}),
    ...(values.has('on') ? { on: values.get('on') } : {}),
    ...(every !== undefined ? { every_min: Number(every) } : {}),
    ...(input.command ? { command: input.command } : {}),
    ...(values.has('post') ? { post: values.get('post') } : {}),
    ...(values.has('cwd') ? { cwd: values.get('cwd') } : {}),
    ...(values.has('host') ? { host: values.get('host') } : {}),
    ...(values.has('hosts') ? { hosts: values.get('hosts') } : {}),
    ...(values.has('scope') ? { scope: values.get('scope') } : {}),
    ...(lease !== undefined ? { lease_s: Number(lease) } : {}),
  }
}

/** run, pause, resume, log and remove on a systemd timer row. */
async function timerCommand(
  verb: string,
  timer: TimerDef,
  file: TimersFile,
  ctx: RoutinesContext,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  const kind = timerKind(timer)
  if (verb === 'remove') {
    err(
      `aico routines remove: ${kind} is a systemd timer listed in packages/jobs/data/systemd-timers.json; pause it instead`,
    )
    return 2
  }
  try {
    if (verb === 'log') {
      out((await timerLog(file, timer, timerCtx(ctx))) || `${kind} has logged nothing yet.`)
      return 0
    }
    if (verb !== 'run' && verb !== 'pause' && verb !== 'resume') {
      err(`aico routines: unknown command '${verb}'\n${ROUTINES_USAGE}`)
      return 2
    }
    await controlTimer(file, timer, verb, timerCtx(ctx))
  } catch (error) {
    err(`aico routines ${verb}: ${timer.host} said: ${(error as Error).message}`)
    return 1
  }
  out(
    verb === 'run'
      ? `${kind} was started now.`
      : verb === 'pause'
        ? `${kind} is paused (its timer is disabled). aico routines resume ${kind} enables it again.`
        : `${kind} is scheduled again.`,
  )
  return 0
}

export async function routinesCommand(
  rest: readonly string[],
  ctx: RoutinesContext,
  out: (line: string) => void = console.log,
  err: (line: string) => void = console.error,
): Promise<number> {
  const [verb, ...args] = rest
  const now = ctx.now ?? Date.now
  if (!verb || verb === 'help' || verb === '--help' || verb === '-h') {
    out(ROUTINES_USAGE)
    return verb ? 0 : 2
  }
  if (verb === 'list') {
    const [jobViews, timerStatuses] = await Promise.all([
      Promise.all(ctx.jobs.map((job) => viewOf(job, ctx))),
      ctx.timers ? readTimerStatus(ctx.timers, timerCtx(ctx)) : [],
    ])
    const wanted = args.find((word) => !word.startsWith('-'))
    const views = [
      ...jobViews,
      ...timerStatuses.map((status) => timerView(status, ctx.timers)),
    ].filter((view) => !wanted || view.kind.includes(wanted))
    if (args.includes('--json')) out(JSON.stringify(views))
    else
      for (const view of views) {
        out(
          `${view.kind}  ${view.project}  ${view.schedule}${view.source === 'registered' ? '  (registered)' : ''}` +
            `${view.paused ? '  PAUSED' : view.running ? '  running' : `  next ${time(view.nextRun, view.tz)}`}`,
        )
        out(
          view.unreadable
            ? `  state unreadable: ${view.unreadable}`
            : view.lastRun === null
              ? `  not run yet${view.started ? '' : ' (the scheduler has not picked it up)'}`
              : `  last ${time(view.lastRun, view.tz)} on ${view.lastMachine ?? '-'}: ${view.lastState}: ${view.lastMeaning}`,
        )
      }
    return 0
  }
  if (verb === 'add') {
    let routine: ReturnType<typeof newRoutine>
    try {
      const input = parseAdd(args)
      if (input.command && !input.cwd) input.cwd = process.cwd()
      routine = newRoutine(
        input,
        ctx.machine,
        new Set(ctx.jobs.map((job) => job.kind)),
        now(),
        ctx.either ?? null,
      )
    } catch (error) {
      err(`aico routines add: ${(error as Error).message}`)
      return 2
    }
    // Every other machine that may run it keeps the routine too, so its scheduler can take over.
    const others = (routine.workers ?? []).filter((name) => name !== ctx.machine)
    const sent: string[] = []
    try {
      for (const name of others) {
        await peerOf(name, ctx).register(routine)
        sent.push(name)
      }
    } catch (error) {
      for (const name of sent)
        await peerOf(name, ctx)
          .unregister(routine.kind)
          .catch(() => {})
      err(
        `aico routines add: could not register it on ${others.find((name) => !sent.includes(name))} ` +
          `(${(error as Error).message}); nothing was registered. Try again when that machine is online.`,
      )
      return 1
    }
    ctx.store.addRoutine(routine)
    out(
      `Registered ${routine.kind} (${routine.project}): ${schedule(routine)} on ${(routine.workers ?? [routine.host]).join(' or ')}. ` +
        `The scheduler picks it up within seconds; aico routines run ${routine.kind} tries it now.`,
    )
    return 0
  }
  const kind = args[0]
  const timer = ctx.timers?.timers.find((candidate) => timerKind(candidate) === kind)
  if (timer && ctx.timers) return timerCommand(verb, timer, ctx.timers, ctx, out, err)
  const job = ctx.jobs.find((candidate) => candidate.kind === kind)
  if (!job) {
    err(
      `aico routines ${verb}: no routine '${kind ?? ''}' (aico routines list shows them: ${[...ctx.jobs.map((j) => j.kind), ...(ctx.timers?.timers.map(timerKind) ?? [])].join(', ')})`,
    )
    return 2
  }
  if (verb === 'remove') {
    if (job.source !== 'registered') {
      err(
        `aico routines remove: ${job.kind} is built in (packages/jobs/data/jobs.json); pause it instead`,
      )
      return 2
    }
    ctx.store.removeRoutine(job.kind)
    await ctx.removeRow(`jobs/${job.kind}`).catch(() => {})
    for (const name of (job.workers ?? []).filter((worker) => worker !== ctx.machine)) {
      try {
        await peerOf(name, ctx).unregister(job.kind)
      } catch (error) {
        err(
          `aico routines remove: ${name} is not reachable (${(error as Error).message}); ` +
            `run aico routines remove ${job.kind} there too, or it keeps scheduling it.`,
        )
      }
    }
    out(`Removed ${job.kind}.`)
    return 0
  }
  if (verb === 'log') {
    // A run's output stays on the machine that ran it, which is not always the lease holder.
    const file = join(ctx.dataDir, 'job-runs', `${job.kind}.last.log`)
    const here = existsSync(file)
    const holder = job.lease_host ?? job.home
    let ranOn: string | null = null
    try {
      ranOn = (await stateOf(job, ctx))?.lastMachine ?? null
    } catch {
      // The holder does not answer: a file kept here is still readable below.
    }
    if (ranOn !== null && ranOn !== ctx.machine) {
      let note: string
      try {
        const text = await peerOf(ranOn, ctx).log(job.kind)
        if (text) {
          out(text)
          return 0
        }
        note = `${ranOn} has no saved output of ${job.kind}; this is what ${ctx.machine} kept:`
      } catch (error) {
        note = `${ranOn} ran it last and is not reachable (${(error as Error).message}); this is what ${ctx.machine} kept:`
        if (!here) {
          err(
            `aico routines log: ${ranOn} is not reachable (${(error as Error).message}); its output is kept there`,
          )
          return 1
        }
      }
      if (!here) {
        out(`${job.kind} has no saved output on ${ranOn} yet.`)
        return 0
      }
      out(note)
    } else if (!here && holder !== ctx.machine) {
      // Never run, or the holder did not answer: it may still keep the output.
      try {
        const text = await peerOf(holder, ctx).log(job.kind)
        out(text || `${job.kind} has no saved output on ${holder} yet.`)
        return 0
      } catch (error) {
        err(
          `aico routines log: ${holder} is not reachable (${(error as Error).message}); its output is kept there`,
        )
        return 1
      }
    }
    if (!here) {
      // No saved output (it has not run since output was kept): what the scheduler logged about it.
      try {
        out(
          execFileSync(
            'journalctl',
            [
              '--user',
              '-u',
              'aico-jobs.service',
              '-g',
              job.kind,
              '-n',
              String(LOG_LINES),
              '--no-pager',
            ],
            { encoding: 'utf8', timeout: 8_000 },
          ).trimEnd(),
        )
      } catch {
        out(`${job.kind} has no saved output yet.`)
      }
      return 0
    }
    out(readFileSync(file, 'utf8').trimEnd().split('\n').slice(-LOG_LINES).join('\n'))
    return 0
  }
  if (verb === 'run' || verb === 'pause' || verb === 'resume') {
    const control = controlOf(job, ctx)
    let done: boolean
    try {
      // A run asked for during a run is cleared when that one finishes, so say so instead.
      if (verb === 'run') {
        const state = await control.get(job.kind)
        if (state?.leaseId && (state.leaseExpires ?? 0) > (ctx.now ?? Date.now)()) {
          out(
            `${job.kind} is already running on ${state.holderMachine ?? 'its machine'}, so no second run was started. Run this again after it ends.`,
          )
          return 0
        }
      }
      done = await control[verb](job.kind)
    } catch (error) {
      err(
        `aico routines ${verb}: ${job.lease_host ?? job.home} is not reachable: ${(error as Error).message}`,
      )
      return 1
    }
    if (!done) {
      err(
        `aico routines ${verb}: the scheduler has not started ${job.kind} yet; try again in a few seconds`,
      )
      return 1
    }
    if (verb !== 'run') {
      try {
        const state = await control.get(job.kind)
        if (state) await ctx.postRows([jobRow(job, state)])
      } catch {
        // The scheduler writes the row at its next result; the state itself is already saved.
      }
    }
    out(
      verb === 'run'
        ? `${job.kind} is due now; its worker runs it within seconds.`
        : verb === 'pause'
          ? `${job.kind} is paused. aico routines resume ${job.kind} schedules it again.`
          : `${job.kind} is scheduled again.`,
    )
    return 0
  }
  err(`aico routines: unknown command '${verb}'\n${ROUTINES_USAGE}`)
  return 2
}
