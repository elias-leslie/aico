// Routines: every scheduled routine Aico knows (its own jobs and those other projects register),
// as GET /api/routines gives them, and the words the list uses for them.

import { shortWhen } from './short-when'
import { plural } from './status'

/** One routine, as `aico routines list --json` reads it. */
export interface Routine {
  kind: string
  what: string
  project: string
  /** systemd: a timer that stays in systemd, listed read-only (Run now starts it, Pause disables it). */
  source: 'built-in' | 'registered' | 'systemd'
  home: string
  /** Every machine that may run it; more than one means whichever is online. */
  hosts: string[]
  schedule: string
  /** The zone its times of day are read in (IANA name); absent for an interval. */
  tz?: string
  /** With a time of day: the day it runs on (mon, 1st-sat, day-15); absent: daily. */
  on?: string
  at?: string
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
  /** Why its state could not be read (its machine did not answer). */
  unreadable?: string
}

export type RoutineChip =
  | 'ok'
  | 'warn'
  | 'failed'
  | 'off'
  | 'running'
  | 'unknown'

/** The status chip a routine wears, with its word. Running and paused come before the last result. */
export function chipOf(routine: Routine): { chip: RoutineChip; word: string } {
  if (routine.unreadable) return { chip: 'unknown', word: 'Not known' }
  if (routine.running) return { chip: 'running', word: 'Running' }
  if (routine.paused) return { chip: 'off', word: 'Paused' }
  if (routine.lastState === 'failed') return { chip: 'failed', word: 'Failed' }
  if (routine.lastState === 'warn') return { chip: 'warn', word: 'Warning' }
  if (routine.lastState === 'ok') return { chip: 'ok', word: 'OK' }
  return { chip: 'off', word: 'Not run yet' }
}

const viewerZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

/** The zone's short name at that moment: "UTC", "EST". */
function zoneLabel(tz: string, at: number): string {
  try {
    return (
      new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
        .formatToParts(new Date(at))
        .find((part) => part.type === 'timeZoneName')?.value ?? tz
    )
  } catch {
    return tz
  }
}

/** A moment in the viewer's own time: the owner never has to convert a zone. */
export function whenIn(_routine: Routine, at: number): string {
  return shortWhen(at)
}

const timeOfDay = (at: number) =>
  new Date(at).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  })

/** The same for a row's one line: a run due later today is just its time of day, one due tomorrow
 * names the day ("Mon 3:05 AM"), so it can't read as a time already gone by. */
export function soonIn(routine: Routine, at: number, now = Date.now()): string {
  if (at < now) return whenIn(routine, at)
  const day = new Date(at).toDateString()
  if (day === new Date(now).toDateString()) return timeOfDay(at)
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  return day === tomorrow.toDateString()
    ? `${new Date(at).toLocaleDateString('en-US', { weekday: 'short' })} ${timeOfDay(at)}`
    : whenIn(routine, at)
}

/** "daily at 03:30" as a sentence start. A time of day in another zone than the viewer's names its
 * zone and the viewer's time for it: "Daily at 03:30 UTC (10:30 PM here)". */
export function scheduleText(routine: Routine): string {
  const text =
    routine.schedule.charAt(0).toUpperCase() + routine.schedule.slice(1)
  if (!routine.tz || routine.tz === viewerZone() || !/\d:\d\d/.test(text))
    return text
  const at = routine.nextRun ?? Date.now()
  const named = `${text} ${zoneLabel(routine.tz, at)}`
  return routine.nextRun === null
    ? named
    : `${named} (${timeOfDay(scheduledAt(text, routine.tz, routine.nextRun))} here)`
}

const DAY_MIN = 24 * 60

/** The scheduled time behind a next run, which a timer's random delay can put minutes after it. */
function scheduledAt(text: string, tz: string, nextRun: number): number {
  const [, hour, minute] = text.match(/(\d{1,2}):(\d\d)/) ?? []
  const clock = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(nextRun)
  const part = (type: string) =>
    Number(clock.find((item) => item.type === type)?.value)
  const late =
    part('hour') * 60 + part('minute') - (Number(hour) * 60 + Number(minute))
  // The shorter way round the clock: a run at 00:10 for 23:50 is 20 minutes late.
  const wrapped = ((late + DAY_MIN + DAY_MIN / 2) % DAY_MIN) - DAY_MIN / 2
  return nextRun - wrapped * 60_000
}

/** Where it runs, in words: one machine, or whichever of several is online. */
export const hostsText = (routine: Routine) =>
  routine.hosts.length > 1
    ? `either ${routine.hosts.join(' or ')}`
    : routine.home

const rank = (r: Routine) =>
  r.unreadable || r.lastState === 'failed' ? 0 : r.lastState === 'warn' ? 1 : 2

/** Failed routines first, then warnings, then the rest by project and name. */
function sortRoutines(list: readonly Routine[]): Routine[] {
  return [...list].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      a.project.localeCompare(b.project) ||
      a.what.localeCompare(b.what),
  )
}

/** The routines of one machine, failed ones first. */
export interface RoutineGroup {
  host: string
  routines: Routine[]
  failed: number
  /** Whose state could not be read. */
  unknown: number
  /** Something here is failed, not known, warning, paused or running. */
  attention: boolean
}

/** Routines grouped by the machine they run on (the one that prefers them), groups with a problem first. */
export function groupRoutines(list: readonly Routine[]): RoutineGroup[] {
  const hosts = new Map<string, Routine[]>()
  for (const routine of list)
    hosts.set(routine.home, [...(hosts.get(routine.home) ?? []), routine])
  return [...hosts]
    .map(([host, routines]) => ({
      host,
      routines: sortRoutines(routines),
      failed: routines.filter(
        (r) => r.lastState === 'failed' && !r.paused && !r.unreadable,
      ).length,
      unknown: routines.filter((r) => r.unreadable).length,
      attention: routines.some((r) => rank(r) < 2 || r.paused || r.running),
    }))
    .sort(
      (a, b) =>
        Number(b.failed + b.unknown > 0) - Number(a.failed + a.unknown > 0) ||
        Number(b.attention) - Number(a.attention) ||
        a.host.localeCompare(b.host),
    )
}

/** The collapsed row's value: "12 routines · 1 failed · 2 paused". */
export function headOf(list: readonly Routine[]): {
  value: string
  tone: 'ok' | 'warn' | 'failed' | null
} {
  const failed = list.filter(
    (r) => r.lastState === 'failed' && !r.paused,
  ).length
  const warn = list.filter((r) => r.lastState === 'warn' && !r.paused).length
  const unknown = list.filter((r) => r.unreadable).length
  const paused = list.filter((r) => r.paused).length
  const parts = [
    plural(list.length, 'routine'),
    failed ? `${failed} failed` : '',
    warn ? plural(warn, 'warning') : '',
    unknown ? `${unknown} not known` : '',
    paused ? `${paused} paused` : '',
  ].filter(Boolean)
  return {
    value: parts.join(' · '),
    tone: failed || unknown ? 'failed' : warn ? 'warn' : null,
  }
}
