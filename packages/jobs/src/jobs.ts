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
  /** With `at`: the day it runs instead of every day. `mon` (weekly), `1st-sat` (nth weekday of the
   * month: 1st 2nd 3rd 4th last) or `day-15` (day of the month, 1 to 28). */
  on?: string
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
  /** IANA zone `at` is read in (registered routines: the registering machine's); default the process's. */
  tz?: string
}

export const KIND = /^[a-z0-9][a-z0-9-]{0,63}$/
const AT = /^([01]\d|2[0-3]):([0-5]\d)$/
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const NTHS = ['1st', '2nd', '3rd', '4th', 'last'] as const
const NTH_WORDS = ['first', 'second', 'third', 'fourth', 'last']
/** Every month has these days, so a day-of-month schedule never skips one. */
const MAX_MONTH_DAY = 28
const ON =
  /^(?:(sun|mon|tue|wed|thu|fri|sat)|(1st|2nd|3rd|4th|last)-(sun|mon|tue|wed|thu|fri|sat)|day-(\d{1,2}))$/

/** A day rule, parsed: a weekday, the nth (or last) weekday of the month, or a day of the month. */
type DayRule = { weekday: number; nth?: number } | { monthDay: number }

/** `on` as a rule, or null when it is not one of the three forms. */
function parseOn(on: string): DayRule | null {
  const match = ON.exec(on)
  if (!match) return null
  if (match[1]) return { weekday: WEEKDAYS.indexOf(match[1] as (typeof WEEKDAYS)[number]) }
  if (match[2])
    return {
      weekday: WEEKDAYS.indexOf(match[3] as (typeof WEEKDAYS)[number]),
      nth: NTHS.indexOf(match[2] as (typeof NTHS)[number]) + 1,
    }
  const monthDay = Number(match[4])
  return monthDay >= 1 && monthDay <= MAX_MONTH_DAY ? { monthDay } : null
}

/** Whether the calendar date y-mo(0-based)-d is a day the rule names. */
function dayMatches(rule: DayRule, y: number, mo: number, d: number): boolean {
  if ('monthDay' in rule) return d === rule.monthDay
  if (new Date(Date.UTC(y, mo, d)).getUTCDay() !== rule.weekday) return false
  if (rule.nth === undefined) return true
  if (rule.nth === 5) return d + 7 > new Date(Date.UTC(y, mo + 1, 0)).getUTCDate()
  return Math.ceil(d / 7) === rule.nth
}

const ordinal = (n: number) =>
  `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')}`

/** The zone this machine's clock runs in (what built-in jobs' `at` means here). */
export const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

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
    if (job.on !== undefined && job.at === undefined)
      fail(`${where}.on`, 'needs at (HH:MM): the time of day it runs on that day')
    let when: Pick<JobDef, 'at' | 'on' | 'every_min'>
    if (job.at !== undefined) {
      const at = text(job, 'at', where, 5)
      if (!AT.test(at)) fail(`${where}.at`, 'HH:MM')
      if (job.on !== undefined) {
        const on = text(job, 'on', where, 8)
        if (!parseOn(on))
          fail(
            `${where}.on`,
            `a weekday (mon), the nth weekday of the month (1st-sat, 2nd, 3rd, 4th or last) or day-N with N from 1 to ${MAX_MONTH_DAY}`,
          )
        when = { at, on }
      } else when = { at }
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
    if (job.tz !== undefined && (job.at === undefined || !validZone(job.tz)))
      fail(`${where}.tz`, 'an IANA zone, and only with at')
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
      ...(job.tz !== undefined ? { tz: job.tz as string } : {}),
      lease_s: seconds(job, 'lease_s', where),
    }
  })
}

/** Whether `tz` names a zone this runtime knows. */
export function validZone(tz: unknown): tz is string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz as string })
    return typeof tz === 'string'
  } catch {
    return false
  }
}

/**
 * Jobs with a time of day and no `tz` of their own read it in the zone jobs.json's `zones` gives
 * for their home machine, so the zone is data the list can show, not whatever the machine's clock
 * says.
 */
function inZone(job: JobDef, zones: Record<string, unknown>): JobDef {
  const zone = zones[job.home]
  if (job.at === undefined || job.tz !== undefined || zone === undefined) return job
  if (!validZone(zone)) fail(`zones.${job.home}`, 'an IANA zone')
  return { ...job, tz: zone }
}

export function readJobs(path: string): JobDef[] {
  const data = JSON.parse(readFileSync(path, 'utf8')) as { zones?: Record<string, unknown> }
  return parseJobs(data).map((parsed) => {
    const job = inZone(parsed, data.zones ?? {})
    if (!('command' in job.run)) return job
    const [file, ...args] = job.run.command
    return file?.startsWith('.')
      ? { ...job, run: { command: [resolve(dirname(path), file), ...args] } }
      : job
  })
}

/** Milliseconds `tz` is ahead of UTC at instant `t`. */
function zoneOffset(tz: string, t: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(t))
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value)
  return (
    Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) -
    Math.floor(t / 1000) * 1000
  )
}

const DAY_MS = 86_400_000

/**
 * The instant the wall clock in `tz` reads year-month-day hours:minutes. A time the clock skips
 * (spring forward) is read with the offset from before the change, so it falls an hour later on
 * the new clock; a time that happens twice (fall back) is its first.
 */
function zonedTime(tz: string, y: number, mo: number, d: number, h: number, mi: number): number {
  const wall = Date.UTC(y, mo, d, h, mi)
  const before = wall - zoneOffset(tz, wall - DAY_MS)
  const after = wall - zoneOffset(tz, wall + DAY_MS)
  const real = [before, after].filter((t) => t + zoneOffset(tz, t) === wall)
  return real.length ? Math.min(...real) : before
}

/** Days to look ahead for a day rule: far enough for any monthly rule. */
const SEARCH_DAYS = 70

/**
 * The first `at` (HH:MM, in `tz`, default the process's local zone) strictly after `after`; with
 * `on`, the first such time on a day that rule names (the rule's days are the zone's calendar days).
 */
export function nextAt(at: string, after: number, tz?: string, on?: string): number {
  const [hours, minutes] = at.split(':').map(Number) as [number, number]
  const rule = on === undefined ? null : parseOn(on)
  if (on !== undefined && !rule) throw new Error(`jobs: '${on}' is not a day rule`)
  if (tz === undefined && !rule) {
    const next = new Date(after)
    next.setHours(hours, minutes, 0, 0)
    if (next.getTime() <= after) {
      next.setDate(next.getDate() + 1)
      next.setHours(hours, minutes, 0, 0)
    }
    return next.getTime()
  }
  const zone = tz ?? localZone()
  const wallNow = new Date(after + zoneOffset(zone, after))
  const [y, mo, d] = [
    wallNow.getUTCFullYear(),
    wallNow.getUTCMonth(),
    wallNow.getUTCDate(),
  ] as const
  for (let i = 0; i < SEARCH_DAYS; i++) {
    const day = new Date(Date.UTC(y, mo, d + i))
    if (rule && !dayMatches(rule, day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()))
      continue
    const t = zonedTime(zone, y, mo, d + i, hours, minutes)
    if (t > after) return t
  }
  throw new Error(`jobs: no run of '${on}' at ${at} within ${SEARCH_DAYS} days`)
}

/** The first run strictly after `after`: the next `at` time, or `every_min` minutes on. */
export function nextRun(
  job: Pick<JobDef, 'at' | 'on' | 'every_min' | 'tz'>,
  after: number,
): number {
  return job.every_min !== undefined
    ? after + job.every_min * 60_000
    : nextAt(job.at as string, after, job.tz, job.on)
}

/** The day part of a schedule in words: "daily", "every Monday", "the first Saturday of each month". */
function dayWords(on: string | undefined): string {
  const rule = on === undefined ? null : parseOn(on)
  if (!rule) return 'daily'
  if ('monthDay' in rule) return `on the ${ordinal(rule.monthDay)} of each month`
  const day = DAY_NAMES[rule.weekday] as string
  return rule.nth === undefined
    ? `every ${day}`
    : `the ${NTH_WORDS[rule.nth - 1]} ${day} of each month`
}

/** When a job runs, in words for its Status row. */
export function schedule(job: Pick<JobDef, 'at' | 'on' | 'every_min'>): string {
  return job.every_min !== undefined
    ? `every ${job.every_min === 1 ? 'minute' : `${job.every_min} minutes`}`
    : `${dayWords(job.on)} at ${job.at}`
}

/** When a resumed job is first due: an interval job at once, a timed job at its next time. */
export function resumeAt(job: Pick<JobDef, 'at' | 'on' | 'every_min' | 'tz'>, now: number): number {
  return job.every_min !== undefined ? now : nextAt(job.at as string, now, job.tz, job.on)
}
