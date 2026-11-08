// The pull kinds of a wait (docs/api-v1.md "Waits"): things whose truth stays
// with their owner and that Tether reads, never pushed to it. Each kind names
// its conditions (`until`), how to read a ref, when a reading means ready or
// gone, and the one line the waiter gets. Lines are built from typed values
// only (ids, owner state words, names that pass the title cleaner), never from
// free text an owner or agent wrote.
//
//   job    a SummitFlow service job (`st service rebuild --detach`): done
//   reply  a coordination request this agent sent (`st sessions send`): acked, closed
//   ask    an ask to the owner (`tether ask create`): answered
//   host   a remote host of this hub: connected
//   cmd    a bounded watcher command Tether runs as a transient user unit
//          (`aico-wait-<ref>`): succeeded (exit 0); any other end is over
//
// `session` (another Aico session) lives in waits.ts.

import { laneTitle } from './lane-reports'

export const PULL_KINDS = ['job', 'reply', 'ask', 'host', 'cmd'] as const
export type PullKind = (typeof PULL_KINDS)[number]

export const PULL_UNTILS: Readonly<Record<PullKind, readonly string[]>> = Object.freeze({
  job: ['done'],
  reply: ['acked', 'closed'],
  ask: ['answered'],
  host: ['connected'],
  cmd: ['succeeded'],
})

/** What a ref looks like, per kind (`job` takes an 8+ hex prefix). */
export const PULL_REFS: Readonly<Record<PullKind, RegExp>> = Object.freeze({
  job: /^[0-9a-f]{8,32}$/,
  reply: /^[0-9a-f]{6,12}$/,
  ask: /^[0-9a-f]{12}$/,
  host: /^[a-z0-9][a-z0-9-]{0,63}$/,
  cmd: /^[0-9a-f]{12}$/,
})

export function isPullKind(kind: string): kind is PullKind {
  return (PULL_KINDS as readonly string[]).includes(kind)
}

/**
 * The owner's state as Tether last read it. `state` is the owner's own word
 * (job `running`, reply `acked`, host `connected`, …), `detail` a typed extra (a reply's intent, a job's exit code),
 * `title` what the line names (a job's project, a reply's recipient).
 */
export interface PullReading {
  state: string
  detail: string | null
  title: string | null
  /** A reply's note, trimmed to one line for the waiter. */
  note?: string | null
}

/** A reading: the thing as it is now, `null` when it is gone (no such job,
 * request, ask or host any more), `undefined` when Tether cannot tell
 * right now (an unreadable file). */
export type PullRead = PullReading | null | undefined

export const JOB_FINAL = new Set(['succeeded', 'failed', 'interrupted'])

/** Whether a reading is ready (`until`), over without being ready (`gone`), or neither. */
export function pullVerdict(
  kind: PullKind,
  until: string,
  reading: PullRead,
): 'until' | 'gone' | null {
  if (reading === undefined) return null
  if (reading === null) return 'gone'
  const { state } = reading
  switch (kind) {
    case 'job':
      return JOB_FINAL.has(state) ? 'until' : null
    case 'reply':
      if (until === 'closed') return state === 'closed' ? 'until' : null
      if ((state === 'acked' || state === 'closed') && reading.detail) return 'until'
      return state === 'closed' ? 'gone' : null
    case 'ask':
      if (state === 'answered' || state === 'done') return 'until'
      return state === 'withdrawn' ? 'gone' : null
    case 'host':
      return state === 'connected' ? 'until' : null
    case 'cmd':
      if (state === 'succeeded') return 'until'
      return state === 'failed' ? 'gone' : null
  }
}

/** A typed word as a line may show it: letters, digits, `_` and `-`, short. */
function word(value: string | null | undefined, fallback: string): string {
  const clean = (value ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24)
  return clean || fallback
}

/** The thing a line names, and the command that shows it. */
function names(kind: PullKind, ref: string, title: string | null): { name: string; look: string } {
  const label = title ? laneTitle(title, 40) : null
  switch (kind) {
    case 'job':
      return {
        name: `service job ${ref.slice(0, 8)}${label ? ` (${label})` : ''}`,
        look: `st service result ${ref}`,
      }
    case 'reply': {
      // The recipient's window title with its id ("Title (cc:x)") fits in 60.
      const to = title ? laneTitle(title, 60) : null
      return {
        name: `request ${ref}${to ? ` to ${to}` : ''}`,
        look: 'st sessions inbox',
      }
    }
    case 'ask':
      return { name: `ask${label ? ` "${label}"` : ''} (${ref})`, look: `tether ask get ${ref}` }
    case 'host':
      return { name: `host ${ref}`, look: 'st aico placement' }
    case 'cmd':
      return {
        name: `command${label ? ` "${label}"` : ''} (${CMD_UNIT_PREFIX}${ref})`,
        look: `journalctl --user -u ${CMD_UNIT_PREFIX}${ref}`,
      }
  }
}

/** A `cmd` wait's transient unit is `aico-wait-<ref>`. */
export const CMD_UNIT_PREFIX = 'aico-wait-'

/** What of a reply's text the waiter's line carries: the sender needs no second command. */
const REPLY_MAX = 300

const NOT_WORDS: Record<string, string> = {
  done: 'not done',
  acked: 'not answered',
  closed: 'not closed',
  finished: 'not finished',
  'needs-you': 'not waiting on the owner',
  answered: 'not answered',
  connected: 'not connected',
  succeeded: 'not finished',
}

function readyWords(kind: PullKind, until: string, reading: PullReading | null): string {
  const state = reading?.state ?? ''
  switch (kind) {
    case 'job': {
      const exit = reading?.detail ? ` (exit ${word(reading.detail, '?')})` : ''
      return `${word(state, 'done')}${state === 'failed' ? exit : ''}`
    }
    case 'reply':
      return until === 'closed'
        ? 'closed'
        : `answered: ${word(reading?.detail, 'yes')}${state === 'closed' ? ' (closed)' : ''}${reading?.note ? `: ${laneTitle(reading.note, REPLY_MAX)}` : ''}`
    case 'ask':
      return 'answered'
    case 'host':
      return 'connected'
    case 'cmd':
      return 'succeeded'
  }
}

function goneWords(kind: PullKind, until: string, reading: PullReading | null): string {
  if (reading === null) return 'is gone'
  switch (kind) {
    case 'reply':
      return 'was closed without an answer'
    case 'ask':
      return 'was withdrawn'
    case 'cmd':
      // Typed systemd words (wait-readers.ts cmdDetail): exit-1, signal-TERM,
      // timeout, oom-kill, start-failed.
      return reading.detail === 'start-failed'
        ? 'could not start'
        : `failed (${word(reading.detail, 'failed').replace('-', ' ')})`
    default:
      return `is over: ${word(reading.state, 'over')} (${until})`
  }
}

/** The one line a pull wait's waiter gets. */
export function pullLine(
  wait: { kind: PullKind; ref: string; until: string; note: string | null },
  outcome: 'until' | 'gone' | 'timeout',
  reading: PullReading | null,
  /** The title last seen, for a line with no reading (gone, timed out). */
  lastTitle: string | null,
  span: string,
  noteMax: number,
): string {
  const { name, look } = names(wait.kind, wait.ref, reading?.title ?? lastTitle)
  let head: string
  if (outcome === 'until') head = `[Ready] ${name} ${readyWords(wait.kind, wait.until, reading)}`
  else if (outcome === 'gone')
    head = `[Wait over] ${name} ${goneWords(wait.kind, wait.until, reading)}`
  else {
    const state = reading ? `: it is ${word(reading.state, 'unknown')}` : ''
    head = `[Wait timed out] ${name} ${NOT_WORDS[wait.until] ?? `not ${wait.until}`} after ${span}${state}`
  }
  const note = wait.note ? ` · re: "${laneTitle(wait.note, noteMax)}"` : ''
  return `${head}${note} · ${look}`
}

/** What a waiter's descriptor says it waits on. */
export function pullWaitingOn(kind: PullKind, ref: string, until: string): string {
  const short = kind === 'job' ? ref.slice(0, 8) : ref
  if (kind === 'cmd') return `a wait on command ${CMD_UNIT_PREFIX}${ref} (${until})`
  return `a wait on ${kind} ${short} (${until})`
}
