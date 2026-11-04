// The job definitions (data/jobs.json) and their schedule. A job kind names
// its home machine, the only machine that runs it (leases live in each host's
// own jobs.db until M11 carries them over the fleet link, so no other machine
// can tell whether the home machine ran it); the schedule is a local time of day.

import { readFileSync } from 'node:fs'

export interface JobDef {
  kind: string
  what: string
  project: string
  /** The one machine that runs it (machine id: lower-cased short host name). */
  home: string
  /** Local time of day, HH:MM, daily. */
  at: string
  run: { post: string } | { command: string[] }
  /** Lease length; the holder renews it every third of this while the job runs. */
  lease_s: number
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
    const at = text(job, 'at', where, 5)
    if (!AT.test(at)) fail(`${where}.at`, 'HH:MM')
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
    return {
      kind,
      what: text(job, 'what', where, 120),
      project: text(job, 'project', where, 64),
      home: text(job, 'home', where, 64).toLowerCase(),
      at,
      run: action,
      lease_s: seconds(job, 'lease_s', where),
    }
  })
}

export function readJobs(path: string): JobDef[] {
  return parseJobs(JSON.parse(readFileSync(path, 'utf8')))
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
