// What a job does: POST to the local aico-web, or run a command. Neither has a
// time limit: a job is never stopped for taking long.
//
// Either runs as its own transient systemd unit (aico-job-KIND), not as a child of the
// scheduler, so restarting aico-jobs does not touch it. A POST job's unit is `aico jobs post
// PATH`, which holds the request open and prints the answer's result as its last line. The
// unit's wrapper leaves the exit code in a file; the scheduler (this one or the next after a restart) attaches to the live unit, or
// picks up the finished run's code, and records the result once. The unit name is the one-run
// guard: a run that finds it live attaches instead of starting a second.

import { execFile, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { request } from 'node:http'
import { uptime } from 'node:os'
import { join } from 'node:path'
import { LIMITS } from '@aico/status'
import type { JobDef } from './jobs'
import type { JobResult } from './leases'

/** aico-web is not listening yet just after a boot; a refused connection is retried this often. */
const REFUSED_TRIES = 6
const REFUSED_WAIT_MS = 5_000

interface Answer {
  status: number
  body: string
}

function post(url: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        )
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.end('{}')
  })
}

/** Exit code a job's command uses for "another run of this job holds the lock": busy, not failed. */
const BUSY_EXIT = 75

/** The answer's own sentence (`message` or `detail`), else the HTTP status. */
export function answerResult({ status, body }: Answer): JobResult {
  let said: string | null = null
  let reported: JobResult['state'] | null = null
  try {
    const parsed = JSON.parse(body) as { message?: unknown; detail?: unknown; state?: unknown }
    if (parsed.state === 'ok' || parsed.state === 'warn' || parsed.state === 'failed')
      reported = parsed.state
    said = typeof parsed.message === 'string' ? parsed.message : null
    said ??= typeof parsed.detail === 'string' ? parsed.detail : null
  } catch {}
  // The route says a run of it is already going (the export's guard): busy, not failed.
  if (status === 409) return { state: 'ok', busy: true, meaning: said ?? 'Already running.' }
  const ok = status >= 200 && status < 300
  return {
    state: ok ? (reported ?? 'ok') : 'failed',
    meaning: said ?? (ok ? 'Finished.' : `Aico answered ${status}.`),
  }
}

export async function postJob(
  webUrl: string,
  path: string,
  wait = REFUSED_WAIT_MS,
): Promise<JobResult> {
  for (let attempt = 1; ; attempt++) {
    try {
      return answerResult(await post(new URL(path, webUrl).toString()))
    } catch (error) {
      const refused = (error as { code?: string }).code === 'ECONNREFUSED'
      if (!refused || attempt >= REFUSED_TRIES)
        return { state: 'failed', meaning: `Could not reach Aico: ${(error as Error).message}` }
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
  }
}

/** The last line of output a person can read: a JSON block at the end (a report for tools) is skipped. */
function plainLast(tail: string): string {
  const lines = tail.trim().split('\n')
  const lastOf = (some: string[]) => some.map((line) => line.trim()).findLast(Boolean) ?? ''
  for (let at = lines.length - 1; at >= 0; at--) {
    if (!/^[[{]/.test(lines[at] as string)) continue
    try {
      JSON.parse(lines.slice(at).join('\n'))
      return lastOf(lines.slice(0, at))
    } catch {}
  }
  const last = lastOf(lines)
  // A JSON report cut at the front: its closing brackets alone say nothing.
  return /^[\]}),\s]*$/.test(last) ? '' : last
}

/** What a finished command means: its last readable line of output and its exit code. */
export function exitResult(code: number | null, signal: string | null, tail: string): JobResult {
  const last = plainLast(tail)
  if (code === 0) return { state: 'ok', meaning: last || 'Finished.' }
  if (code === BUSY_EXIT)
    return { state: 'ok', busy: true, meaning: last || 'Already running; this run did nothing.' }
  return {
    state: 'failed',
    meaning: `${signal ? `Stopped by ${signal}` : `Exited ${code}`}${last ? `: ${last}` : '.'}`,
  }
}

export function commandJob(argv: readonly string[]): Promise<JobResult> {
  return new Promise((resolve) => {
    const [file, ...args] = argv as [string, ...string[]]
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let tail = ''
    const keep = (chunk: Buffer) => {
      tail = (tail + chunk.toString('utf8')).slice(-2000)
    }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    child.on('error', (error) =>
      resolve({ state: 'failed', meaning: `Could not start: ${error.message}` }),
    )
    child.on('close', (code, signal) => resolve(exitResult(code, signal, tail)))
  })
}

/** Where a job's transient unit runs: start it, ask whether it is live. */
export interface UnitHost {
  active(unit: string, where?: UnitWhere): Promise<boolean>
  start(unit: string, argv: readonly string[], where?: UnitWhere): Promise<void>
  /** This machine, or the user manager running its units, is shutting down right now. */
  stopping?(where?: UnitWhere): Promise<boolean>
  /** When this boot began, ms since the epoch: a result written before it is the last boot's. */
  bootedAt?(): number
  /** Stable across clock adjustments; different after a machine reboot. */
  bootId?(): string | null
}

/** Where a unit runs: a user unit (default) or a system unit as root; and its working folder. */
export interface UnitWhere {
  scope?: 'user' | 'system'
  cwd?: string
}

const run = (file: string, args: string[]) =>
  new Promise<{ code: number; out: string }>((resolve) =>
    execFile(file, args, { encoding: 'utf8' }, (error, stdout, stderr) =>
      resolve({
        code: error ? ((error as { code?: unknown }).code as number) || 1 : 0,
        out: `${stdout}${stderr}`.trim(),
      }),
    ),
  )

/** systemd --user: `systemd-run --no-ask-password` starts the unit, `is-active` asks. */
export function systemdUnits(env: NodeJS.ProcessEnv = process.env): UnitHost {
  const passed = ['HOME', 'PATH', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_STATE_HOME']
  const setenv = Object.keys(env)
    .filter((key) => passed.includes(key) || key.startsWith('AICO_'))
    .flatMap((key) => (env[key] ? [`--setenv=${key}=${env[key]}`] : []))
  return {
    active: async (unit, where) =>
      (
        await run('systemctl', [
          ...(where?.scope === 'system' ? [] : ['--user']),
          'is-active',
          '--quiet',
          unit,
        ])
      ).code === 0,
    stopping: async (where) =>
      (
        await Promise.all([
          run('systemctl', ['is-system-running']),
          ...(where?.scope === 'system' ? [] : [run('systemctl', ['--user', 'is-system-running'])]),
        ])
      ).some((answer) => answer.out === 'stopping'),
    bootedAt: () => Date.now() - uptime() * 1000,
    bootId: () => readIf('/proc/sys/kernel/random/boot_id')?.trim() || null,
    start: async (unit, argv, where) => {
      const system = where?.scope === 'system'
      const args = [
        ...(system ? [] : ['--user']),
        '--no-ask-password',
        '--quiet',
        '--collect',
        `--unit=${unit}`,
        `--working-directory=${where?.cwd ?? process.cwd()}`,
        ...setenv,
        ...argv,
      ]
      const started = system
        ? await run('sudo', ['-n', 'systemd-run', ...args])
        : await run('systemd-run', args)
      if (started.code !== 0) throw new Error(started.out || `systemd-run exited ${started.code}`)
    },
  }
}

export const unitName = (kind: string) => `aico-job-${kind}`

// "$@" runs the job; its exit code is written last and moved into place whole, so a code file
// is never half-written. SIGKILL of the wrapper leaves no code file: that run reads as stopped.
const WRAPPER =
  'cat /proc/sys/kernel/random/boot_id >"$0.boot.tmp" 2>/dev/null; mv "$0.boot.tmp" "$0.boot"; printf "%s\\n" "$1" >"$0.run"; shift; "$@" >"$0.log" 2>&1; echo $? >"$0.code.tmp"; mv "$0.code.tmp" "$0.code"'

/** The unit's command line: the wrapper shell, then the job's argv. */
export const unitArgv = (base: string, argv: readonly string[], runId = '') => [
  '/bin/sh',
  '-c',
  WRAPPER,
  base,
  runId,
  ...argv,
]

export interface UnitJobOptions {
  host: UnitHost
  /** Directory holding each kind's log and exit code. */
  dir: string
  pollMs?: number
}

const TAIL_BYTES = 2000

function readIf(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

const CUT_SHORT: JobResult = {
  state: 'ok',
  cut: true,
  meaning: 'This machine shut down during the run; it runs again once the machine is back.',
}

/** Shutdown signals; SIGKILL and crash signals also have real running-machine causes. */
const endedByShutdownSignal = (code: number) => code === 130 || code === 143

/** When the file was last written, or null when it isn't there. */
function writtenAt(path: string): number | null {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

/**
 * A run this machine's shutdown ended, which says nothing about the job (owner 2026-11-08). Anything
 * short of success while the machine is stopping counts; after the boot only a shutdown signal exit
 * from the last boot does, as any other exit code then is a real result nobody had read yet. Boot
 * identity survives clock adjustments; older wrappers without it fall back to the result timestamp.
 * A run stopped by hand on a running machine reads failed, as it did.
 */
async function endedWithMachine(
  host: UnitHost,
  code: number | null,
  codeAt: number | null,
  resultBoot: string | null,
  where?: UnitWhere,
): Promise<boolean> {
  if (code === 0) return false
  if (await host.stopping?.(where).catch(() => false)) return true
  if (code === null || !endedByShutdownSignal(code)) return false
  const bootId = host.bootId?.()
  if (bootId && resultBoot) return bootId !== resultBoot
  const booted = host.bootedAt?.()
  return codeAt !== null && booted !== undefined && Number.isFinite(booted) && codeAt < booted
}

/** True when the job's unit is live, or it finished and nobody has recorded its code yet. */
export async function unitInFlight(
  kind: string,
  options: UnitJobOptions,
  where?: UnitWhere,
): Promise<boolean> {
  return (
    (await options.host.active(unitName(kind), where)) ||
    readIf(join(options.dir, `${kind}.code`)) !== null
  )
}

/** Attaches to the job's live unit, or takes a finished run's code, or starts the unit; then waits
 * for it and returns the result. A restarted scheduler calling this again joins the same run. */
export async function unitJob(
  kind: string,
  argv: readonly string[],
  options: UnitJobOptions,
  read: (code: number, tail: string) => JobResult = (code, tail) => exitResult(code, null, tail),
  where?: UnitWhere,
  runId?: string,
): Promise<JobResult> {
  const { host, dir } = options
  const unit = unitName(kind)
  const base = join(dir, kind)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (!(await host.active(unit, where)) && readIf(`${base}.code`) === null) {
    // No log cleanup here: the wrapper truncates it as the run begins, and a second caller racing this
    // start would otherwise delete the log the first caller's run is already writing.
    try {
      await host.start(unit, unitArgv(base, argv, runId), where)
    } catch (error) {
      // A concurrent start (or a scheduler racing us) won: join its run rather than failing.
      if (!(await host.active(unit, where)))
        return { state: 'failed', meaning: `Could not start: ${(error as Error).message}` }
    }
  }
  while (await host.active(unit, where))
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 2_000))
  const code = readIf(`${base}.code`)
  const codeAt = writtenAt(`${base}.code`)
  const resultBoot = readIf(`${base}.boot`)?.trim() || null
  const originalRun = readIf(`${base}.run`)?.trim()
  const log = readIf(`${base}.log`) ?? ''
  rmSync(`${base}.code`, { force: true })
  rmSync(`${base}.run`, { force: true })
  // The last run's output stays for `aico routines log KIND`; the next run writes a fresh .log.
  try {
    renameSync(`${base}.log`, `${base}.last.log`)
  } catch {}
  const exit = code === null ? null : Number(code.trim())
  if (await endedWithMachine(host, exit, codeAt, resultBoot, where)) return CUT_SHORT
  if (exit === null) return { state: 'failed', meaning: 'It was stopped before it left a result.' }
  const result = read(exit, log.slice(-TAIL_BYTES))
  return originalRun && originalRun.length <= LIMITS.id.max && LIMITS.id.pattern.test(originalRun)
    ? { ...result, runId: originalRun }
    : result
}

/** A POST job unit's result: the JSON line `aico jobs post` printed last; else its exit as a command's. */
export function postedResult(code: number, tail: string): JobResult {
  const last = tail.trim().split('\n').at(-1) ?? ''
  try {
    const result = JSON.parse(last) as Partial<JobResult>
    if (
      code === 0 &&
      (result.state === 'ok' || result.state === 'warn' || result.state === 'failed') &&
      typeof result.meaning === 'string'
    )
      return {
        state: result.state,
        meaning: result.meaning,
        ...(result.busy ? { busy: true } : {}),
      }
  } catch {}
  return exitResult(code, null, tail)
}

/** A job's unit placement: its scope and working folder (neither set for most built-in jobs). */
export const whereOf = (job: JobDef): UnitWhere => ({
  ...(job.scope ? { scope: job.scope } : {}),
  ...(job.cwd ? { cwd: job.cwd } : {}),
})

/** How to start this program again: node with its own flags (aico-jobs.service passes
 * --disable-warning=ExperimentalWarning, so a POST job's unit logs its result, not node:sqlite's
 * warning) and the bundle. */
/**
 * Clears what a reboot or power cut left behind (`aico deploy boot-clean`; only things older than
 * this boot, so every start of this service may ask). In its own unit: putting back a half-swapped
 * deploy can restart this very service. One already going is fine.
 */
export async function startBootClean(host: Pick<UnitHost, 'start'>): Promise<void> {
  try {
    await host.start('aico-boot-clean', ['aico', 'deploy', 'boot-clean'])
  } catch (error) {
    console.error(`[jobs] after-boot cleanup did not start: ${(error as Error).message}`)
  }
}

export function selfArgv(
  proc: Pick<NodeJS.Process, 'execPath' | 'execArgv' | 'argv'> = process,
): string[] {
  return [proc.execPath, ...proc.execArgv, proc.argv[1] as string]
}

/**
 * Runs each job in its own unit. `self` is how to start this program again (node and the
 * aico-jobs bundle), for a POST job's `aico jobs post PATH` unit.
 */
export function act(
  self: readonly string[],
  units: UnitJobOptions,
): (job: JobDef, runId?: string) => Promise<JobResult> {
  return (job, runId) => {
    const where = whereOf(job)
    return 'post' in job.run
      ? unitJob(job.kind, [...self, 'post', job.run.post], units, postedResult, where, runId)
      : unitJob(job.kind, job.run.command, units, undefined, where, runId)
  }
}
