// Timers that stay in systemd on purpose (watchdogs, heartbeats, root host jobs, hosts without the
// scheduler). They are listed in Routines read-only and never depend on aico-jobs: the list and its
// controls talk to systemd directly (data/systemd-timers.json names which timers and how to reach
// each host). A failed timer is a failed row like any routine; nothing here posts a Status row or
// a notice, so none of it reaches the phone (packages/notify/src/phone.ts: only a sender's own
// interrupt reason does).

import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execArgv } from '@aico/fleet/exec'
import { peerDir } from '@aico/fleet/hosts'

export interface TimerDef {
  /** The timer unit, e.g. host-steward-heartbeat.timer; its service is the same name. */
  unit: string
  host: string
  scope: 'user' | 'system'
  project: string
  what: string
  /** The schedule in plain words (the unit file holds the real one). */
  schedule: string
}

/** How to reach a host other than the one the command runs on. */
export interface TimerHost {
  /** Command words put in front of every systemctl call (e.g. an ssh hop). */
  exec?: string[]
  /** Reach the host over the fleet link (runs as that machine's Aico user). */
  fleet?: boolean
  /** The `exec` route already runs as root, so system units need no sudo. */
  root?: boolean
}

export interface TimersFile {
  hosts: Record<string, TimerHost>
  timers: TimerDef[]
}

const UNIT = /^[A-Za-z0-9:_.@-]{1,100}\.timer$/
const HOST = /^[a-z0-9][a-z0-9-]{0,63}$/

/** The kind a timer row has in Routines: unit name without .timer, then @host. */
export const timerKind = (def: Pick<TimerDef, 'unit' | 'host'>) =>
  `${def.unit.replace(/\.timer$/, '')}@${def.host}`

export function parseTimers(value: unknown): TimersFile {
  const fail = (where: string, message: string): never => {
    throw new Error(`timers file: ${where}: ${message}`)
  }
  const file = value as { hosts?: Record<string, TimerHost>; timers?: unknown } | null
  const hosts = file?.hosts ?? {}
  if (typeof hosts !== 'object' || Array.isArray(hosts)) fail('hosts', 'an object')
  for (const [name, host] of Object.entries(hosts)) {
    if (!HOST.test(name)) fail(`hosts.${name}`, 'a machine name')
    const exec = host.exec
    if (
      exec !== undefined &&
      (!Array.isArray(exec) || !exec.length || exec.some((w) => typeof w !== 'string'))
    )
      fail(`hosts.${name}.exec`, 'a list of command words')
    if (exec !== undefined && host.fleet) fail(`hosts.${name}`, 'exec or fleet, not both')
  }
  const listed = file?.timers
  if (!Array.isArray(listed)) return fail('timers', 'a list')
  const seen = new Set<string>()
  const timers = (listed as Record<string, unknown>[]).map((raw, index) => {
    const where = `timers[${index}]`
    const text = (field: string, max: number) => {
      const v = raw?.[field]
      if (typeof v !== 'string' || !v.trim() || v.length > max)
        fail(`${where}.${field}`, `a text of 1 to ${max} characters`)
      return v as string
    }
    const unit = text('unit', 110)
    if (!UNIT.test(unit)) fail(`${where}.unit`, 'a .timer unit name')
    const host = text('host', 64)
    if (!HOST.test(host)) fail(`${where}.host`, 'a machine name')
    const scope = raw.scope === undefined ? 'system' : raw.scope
    if (scope !== 'user' && scope !== 'system') fail(`${where}.scope`, 'user or system')
    const known = hosts[host]
    if (scope === 'user' && known && (known.exec || known.root))
      fail(
        `${where}.scope`,
        `user timers are read where the command runs; ${host} is reached by another route`,
      )
    const def: TimerDef = {
      unit,
      host,
      scope: scope as TimerDef['scope'],
      project: text('project', 64),
      what: text('what', 120),
      schedule: text('schedule', 120),
    }
    const kind = timerKind(def)
    if (seen.has(kind)) fail(where, `${kind} is listed twice`)
    seen.add(kind)
    return def
  })
  return { hosts, timers }
}

export function readTimers(path: string): TimersFile {
  return parseTimers(JSON.parse(readFileSync(path, 'utf8')))
}

export interface RunResult {
  code: number
  out: string
}
/** Runs one command (argv, no shell) and gives its exit code and output. */
export type RunCommand = (argv: string[]) => Promise<RunResult>

const COMMAND_MS = 15_000

const runCommand: RunCommand = (argv) =>
  new Promise((resolve, reject) => {
    const [file, ...args] = argv as [string, ...string[]]
    execFile(
      file,
      args,
      { encoding: 'utf8', timeout: COMMAND_MS, maxBuffer: 4 << 20 },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === 'ENOENT')
          return reject(new Error(`${file} is not installed here`))
        if (error?.killed) return reject(new Error('it did not answer in time'))
        const code = error ? ((error as { code?: number }).code ?? 1) : 0
        resolve({ code: typeof code === 'number' ? code : 1, out: `${stdout}${stderr}` })
      },
    )
  })

export interface TimerContext {
  /** This machine's id: its own timers run with no hop. */
  machine: string
  env: NodeJS.ProcessEnv
  run?: RunCommand
}

/** The command words that put `argv` on the timer's host. */
function onHost(file: TimersFile, def: TimerDef, ctx: TimerContext, argv: string[]): string[] {
  const host = file.hosts[def.host]
  if (def.host === ctx.machine) {
    const root =
      def.scope === 'system' && typeof process.getuid === 'function' && process.getuid() !== 0
    return root ? ['sudo', '-n', ...argv] : argv
  }
  if (host?.fleet)
    return execArgv(
      join(peerDir(ctx.env, process.getuid?.(), def.host), 'exec.sock'),
      argv,
      ctx.env,
    )
  if (host?.exec) {
    const needsSudo = def.scope === 'system' && !host.root
    return [...host.exec, ...(needsSudo ? ['sudo', '-n'] : []), ...argv]
  }
  throw new Error(`there is no route to ${def.host} in the timers file`)
}

const systemctl = (def: TimerDef, ...args: string[]) => [
  'systemctl',
  ...(def.scope === 'user' ? ['--user'] : []),
  ...args,
]

/** What systemd says about one timer and the service it starts. */
export interface TimerStatus {
  def: TimerDef
  /** Why it could not be read. */
  unreadable?: string
  installed: boolean
  /** The timer is active (it will fire); false once paused. */
  active: boolean
  /** The service is running right now. */
  running: boolean
  next: number | null
  last: number | null
  /** The service's last result: success, exit-code, timeout, signal... */
  result: string
  exitStatus: number | null
}

interface ListedTimer {
  unit?: string
  next?: number
  last?: number
}

/** `systemctl show` output as one record per unit (blocks split by a blank line, keyed by Id). */
function showBlocks(text: string): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>()
  for (const block of text.split(/\n\s*\n/)) {
    const record: Record<string, string> = {}
    for (const line of block.split('\n')) {
      const at = line.indexOf('=')
      if (at > 0) record[line.slice(0, at)] = line.slice(at + 1)
    }
    if (record.Id) out.set(record.Id, record)
  }
  return out
}

/** Microseconds since the epoch as milliseconds; 0 and absent are "never". */
const micros = (value: number | undefined) => (value && value > 0 ? Math.round(value / 1000) : null)

/** Reads every listed timer: one list-timers and one show per host and scope. */
export async function readTimerStatus(file: TimersFile, ctx: TimerContext): Promise<TimerStatus[]> {
  const run = ctx.run ?? runCommand
  const groups = new Map<string, TimerDef[]>()
  for (const def of file.timers) {
    const key = `${def.host}/${def.scope}`
    groups.set(key, [...(groups.get(key) ?? []), def])
  }
  const read = async (defs: TimerDef[]): Promise<TimerStatus[]> => {
    const first = defs[0] as TimerDef
    const units = defs.map((def) => def.unit)
    const services = defs.map((def) => def.unit.replace(/\.timer$/, '.service'))
    try {
      const [listed, shown] = await Promise.all([
        run(
          onHost(
            file,
            first,
            ctx,
            systemctl(first, 'list-timers', '--all', '--output=json', '--no-pager', ...units),
          ),
        ),
        run(
          onHost(
            file,
            first,
            ctx,
            systemctl(
              first,
              'show',
              '-p',
              'Id,LoadState,ActiveState,Result,ExecMainStatus',
              ...units,
              ...services,
            ),
          ),
        ),
      ])
      if (shown.code !== 0)
        throw new Error(shown.out.trim().split('\n').pop() || 'systemctl show failed')
      if (listed.code !== 0)
        throw new Error(listed.out.trim().split('\n').pop() || 'systemctl list-timers failed')
      const timers = new Map(
        (JSON.parse(listed.out || '[]') as ListedTimer[]).map((entry) => [entry.unit ?? '', entry]),
      )
      const records = showBlocks(shown.out)
      return defs.map((def) => {
        const timer = records.get(def.unit)
        const service = records.get(def.unit.replace(/\.timer$/, '.service'))
        const listing = timers.get(def.unit)
        const exit = service?.ExecMainStatus
        return {
          def,
          installed: timer?.LoadState === 'loaded',
          active: timer?.ActiveState === 'active',
          running: ['activating', 'active', 'reloading'].includes(service?.ActiveState ?? ''),
          next: micros(listing?.next),
          last: micros(listing?.last),
          result:
            service?.ActiveState === 'failed' && (service?.Result ?? 'success') === 'success'
              ? 'failed'
              : timer?.Result && timer.Result !== 'success'
                ? timer.Result
                : (service?.Result ?? 'success'),
          exitStatus: exit !== undefined && exit !== '' ? Number(exit) : null,
        }
      })
    } catch (error) {
      const message = (error as Error).message
      return defs.map((def) => ({
        def,
        unreadable: message,
        installed: false,
        active: false,
        running: false,
        next: null,
        last: null,
        result: 'success',
        exitStatus: null,
      }))
    }
  }
  const all = await Promise.all([...groups.values()].map(read))
  const byKind = new Map(all.flat().map((status) => [timerKind(status.def), status]))
  return file.timers.map((def) => byKind.get(timerKind(def)) as TimerStatus)
}

export type TimerVerb = 'run' | 'pause' | 'resume'

/** Run now (start the service, without waiting), Pause (disable the timer) or Resume (enable it). */
export async function controlTimer(
  file: TimersFile,
  def: TimerDef,
  verb: TimerVerb,
  ctx: TimerContext,
): Promise<void> {
  const run = ctx.run ?? runCommand
  const args =
    verb === 'run'
      ? ['start', '--no-ask-password', '--no-block', def.unit.replace(/\.timer$/, '.service')]
      : [verb === 'pause' ? 'disable' : 'enable', '--now', '--no-ask-password', def.unit]
  const result = await run(onHost(file, def, ctx, systemctl(def, ...args)))
  if (result.code !== 0)
    throw new Error(
      result.out.trim().split('\n').pop() || `systemctl ${args[0]} failed (${result.code})`,
    )
}

/** The last lines the timer's service logged. */
export async function timerLog(
  file: TimersFile,
  def: TimerDef,
  ctx: TimerContext,
): Promise<string> {
  const run = ctx.run ?? runCommand
  const service = def.unit.replace(/\.timer$/, '.service')
  const result = await run(
    onHost(file, def, ctx, [
      'journalctl',
      ...(def.scope === 'user' ? ['--user'] : []),
      '-u',
      service,
      '-n',
      '100',
      '--no-pager',
    ]),
  )
  return result.out.trimEnd()
}
