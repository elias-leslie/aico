// What a job does: POST to the local aico-web, or run a command. Neither has a
// time limit: a job is never stopped for taking long.
//
// A command runs as its own transient systemd unit (aico-job-KIND), not as a child of the
// scheduler, so restarting aico-jobs does not touch it. The unit's wrapper leaves the exit code
// in a file; the scheduler (this one or the next after a restart) attaches to the live unit, or
// picks up the finished run's code, and records the result once. The unit name is the one-run
// guard: a run that finds it live attaches instead of starting a second.

import { execFile, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
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

/** What a finished command means: its last line of output and its exit code. */
export function exitResult(code: number | null, signal: string | null, tail: string): JobResult {
  const last = tail.trim().split('\n').at(-1)?.trim() ?? ''
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
  active(unit: string): Promise<boolean>
  start(unit: string, argv: readonly string[]): Promise<void>
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
    active: async (unit) =>
      (await run('systemctl', ['--user', 'is-active', '--quiet', unit])).code === 0,
    start: async (unit, argv) => {
      const started = await run('systemd-run', [
        '--user',
        '--no-ask-password',
        '--quiet',
        '--collect',
        `--unit=${unit}`,
        `--working-directory=${process.cwd()}`,
        ...setenv,
        ...argv,
      ])
      if (started.code !== 0) throw new Error(started.out || `systemd-run exited ${started.code}`)
    },
  }
}

export const unitName = (kind: string) => `aico-job-${kind}`

// "$@" runs the job; its exit code is written last and moved into place whole, so a code file
// is never half-written. SIGKILL of the wrapper leaves no code file: that run reads as stopped.
const WRAPPER = '"$@" >"$0.log" 2>&1; echo $? >"$0.code.tmp"; mv "$0.code.tmp" "$0.code"'

/** The unit's command line: the wrapper shell, then the job's argv. */
export const unitArgv = (base: string, argv: readonly string[]) => [
  '/bin/sh',
  '-c',
  WRAPPER,
  base,
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

/** True when the job's unit is live, or it finished and nobody has recorded its code yet. */
export async function unitInFlight(kind: string, options: UnitJobOptions): Promise<boolean> {
  return (
    (await options.host.active(unitName(kind))) ||
    readIf(join(options.dir, `${kind}.code`)) !== null
  )
}

/** Attaches to the job's live unit, or takes a finished run's code, or starts the unit; then waits
 * for it and returns the result. A restarted scheduler calling this again joins the same run. */
export async function unitJob(
  kind: string,
  argv: readonly string[],
  options: UnitJobOptions,
): Promise<JobResult> {
  const { host, dir } = options
  const unit = unitName(kind)
  const base = join(dir, kind)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (!(await host.active(unit)) && readIf(`${base}.code`) === null) {
    rmSync(`${base}.log`, { force: true })
    try {
      await host.start(unit, unitArgv(base, argv))
    } catch (error) {
      // A concurrent start (or a scheduler racing us) won: join its run rather than failing.
      if (!(await host.active(unit)))
        return { state: 'failed', meaning: `Could not start: ${(error as Error).message}` }
    }
  }
  while (await host.active(unit))
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 2_000))
  const code = readIf(`${base}.code`)
  const log = readIf(`${base}.log`) ?? ''
  rmSync(`${base}.code`, { force: true })
  if (code === null) return { state: 'failed', meaning: 'It was stopped before it left a result.' }
  return exitResult(Number(code.trim()), null, log.slice(-TAIL_BYTES))
}

export function act(webUrl: string, units: UnitJobOptions): (job: JobDef) => Promise<JobResult> {
  return (job) =>
    'post' in job.run ? postJob(webUrl, job.run.post) : unitJob(job.kind, job.run.command, units)
}
