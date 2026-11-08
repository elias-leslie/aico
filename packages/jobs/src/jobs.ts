// Job definitions own placement, the single lease authority, eligible workers
// and schedules. A missing worker list keeps a job bound to its home machine.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export interface JobDef {
  kind: string
  what: string
  project: string
  /** The one machine that runs it (machine id: lower-cased short host name). */
  home: string
  /** Local time of day, HH:MM, daily; or `every_min`, a repeat every that many minutes. One of the two. */
  at?: string
  every_min?: number
  run: { post: string } | { command: string[] }
  /** Lease length; the holder renews it every third of this while the job runs. */
  lease_host?: string
  workers?: string[]
  lease_s: number
  /** jobs.json (built-in) or a routine another project registered. */
  source?: 'built-in' | 'registered'
  /** user (default): a systemd user unit; system: a system unit run as root. */
  scope?: 'user' | 'system'
  /** Where a command runs (registered routines). */
  cwd?: string
}

const KIND = /^[a-z0-9][a-z0-9-]{0,63}$/
const AT = /^([01]\d|2[0-3]):([0-5]\d)$/

function fail(where: string, message: string): never {
  throw new Error(`jobs file: ${where}: ${message}`)
}

function text(job: Record<string, unknown>, field: string, where: string, max = 200): string {
  const value = job[field]
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    fail(`${where}.${field}`, `a text of 1 to ${max} characters`)
  return value
}

function seconds(job: Record<string, unknown>, field: string, where: string): number {
  const value = job[field]
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 86_400)
    fail(`${where}.${field}`, 'whole seconds from 1 to 86400')
  return value as number
}

/** Checks a jobs file's content; throws naming the bad field. */
export function parseJobs(value: unknown): JobDef[] {
  const jobs = (value as { jobs?: unknown } | null)?.jobs
  if (!Array.isArray(jobs)) fail('jobs', 'a list')
  const seen = new Set<string>()
  return jobs.map((raw, index) => {
    const where = `jobs[${index}]`
    if (typeof raw !== 'object' || raw === null) fail(where, 'an object')
    const job = raw as Record<string, unknown>
    const kind = text(job, 'kind', where, 64)
    if (!KIND.test(kind)) fail(`${where}.kind`, 'lower-case letters, digits and dashes')
    if (seen.has(kind)) fail(`${where}.kind`, `${kind} is listed twice`)
    seen.add(kind)
    if ((job.at === undefined) === (job.every_min === undefined))
      fail(where, 'exactly one of at (HH:MM daily) or every_min (whole minutes)')
    let when: Pick<JobDef, 'at' | 'every_min'>
    if (job.at !== undefined) {
      const at = text(job, 'at', where, 5)
      if (!AT.test(at)) fail(`${where}.at`, 'HH:MM')
      when = { at }
    } else {
      const every = job.every_min
      if (!Number.isInteger(every) || (every as number) < 1 || (every as number) > 1440)
        fail(`${where}.every_min`, 'whole minutes from 1 to 1440')
      when = { every_min: every as number }
    }
    const run = job.run as Record<string, unknown> | undefined
    let action: JobDef['run']
    if (typeof run?.post === 'string' && run.post.startsWith('/')) action = { post: run.post }
    else if (
      Array.isArray(run?.command) &&
      run.command.length > 0 &&
      run.command.every((part) => typeof part === 'string')
    )
      action = { command: run.command as string[] }
    else fail(`${where}.run`, '{post: "/path"} or {command: [argv]}')
    const leaseHost = job.lease_host
    if (leaseHost !== undefined && (typeof leaseHost !== 'string' || !KIND.test(leaseHost)))
      fail(`${where}.lease_host`, 'a machine name')
    const workers = job.workers
    if (
      workers !== undefined &&
      (!Array.isArray(workers) ||
        !workers.length ||
        workers.some((name) => typeof name !== 'string' || !KIND.test(name)))
    )
      fail(`${where}.workers`, 'a list of machine names')
    const scope = job.scope
    if (scope !== undefined && scope !== 'user' && scope !== 'system')
      fail(`${where}.scope`, 'user or system')
    return {
      kind,
      what: text(job, 'what', where, 120),
      project: text(job, 'project', where, 64),
      home: text(job, 'home', where, 64).toLowerCase(),
      ...when,
      run: action,
      ...(leaseHost !== undefined ? { lease_host: leaseHost as string } : {}),
      ...(workers !== undefined ? { workers: workers as string[] } : {}),
      ...(scope !== undefined ? { scope } : {}),
      lease_s: seconds(job, 'lease_s', where),
    }
  })
}

export function readJobs(path: string): JobDef[] {
  return parseJobs(JSON.parse(readFileSync(path, 'utf8'))).map((job) => {
    if (!('command' in job.run)) return job
    const [file, ...args] = job.run.command
    return file?.startsWith('.')
      ? { ...job, run: { command: [resolve(dirname(path), file), ...args] } }
      : job
  })
}

/** The first local `at` (HH:MM) strictly after `after`. */
export function nextAt(at: string, after: number): number {
  const [hours, minutes] = at.split(':').map(Number) as [number, number]
  const next = new Date(after)
  next.setHours(hours, minutes, 0, 0)
  if (next.getTime() <= after) {
    next.setDate(next.getDate() + 1)
    next.setHours(hours, minutes, 0, 0)
  }
  return next.getTime()
}

/** The first run strictly after `after`: the next `at` time, or `every_min` minutes on. */
export function nextRun(job: Pick<JobDef, 'at' | 'every_min'>, after: number): number {
  return job.every_min !== undefined
    ? after + job.every_min * 60_000
    : nextAt(job.at as string, after)
}

/** When a job runs, in words for its Status row. */
export function schedule(job: Pick<JobDef, 'at' | 'every_min'>): string {
  return job.every_min !== undefined
    ? `every ${job.every_min === 1 ? 'minute' : `${job.every_min} minutes`}`
    : `daily at ${job.at}`
}

/** When a resumed job is first due: an interval job at once, a daily job at its next time. */
export function resumeAt(job: Pick<JobDef, 'at' | 'every_min'>, now: number): number {
  return job.every_min !== undefined ? now : nextAt(job.at as string, now)
}
