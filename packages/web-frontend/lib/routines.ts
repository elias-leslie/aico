// Routines: every scheduled routine Aico knows (its own jobs and those other projects register),
// as GET /api/routines gives them, and the words the list uses for them.

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

/** "daily at 19:00" as a sentence start. */
export const scheduleText = (routine: Routine) =>
  routine.schedule.charAt(0).toUpperCase() + routine.schedule.slice(1)

/** Where it runs, in words: one machine, or whichever of several is online. */
export const hostsText = (routine: Routine) =>
  routine.hosts.length > 1
    ? `either ${routine.hosts.join(' or ')}`
    : routine.home

/** Failed routines first, then warnings, then the rest by project and name. */
export function sortRoutines(list: readonly Routine[]): Routine[] {
  const rank = (r: Routine) =>
    r.unreadable || r.lastState === 'failed'
      ? 0
      : r.lastState === 'warn'
        ? 1
        : 2
  return [...list].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      a.project.localeCompare(b.project) ||
      a.what.localeCompare(b.what),
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
