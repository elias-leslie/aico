// Session wakes: scheduled check-ins (docs/plans/session-wakes.md). A wake is
// a time and a note on a session. Once due, Tether pastes the note into the
// session's agent, but only while the agent is idle, its input line is empty
// and nobody has typed for a moment, so it never types over the owner. A wake
// the owner kept past End relaunches the conversation in a new session.
// Tether is the only scheduler; the wakes table survives restarts and reboots.

import { createHash, randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

// --- policy ----------------------------------------------------------------------

/** Owner settings for wakes (the `settings` row `wake_policy`). The apps read
 * their quick choices from here. */
export interface WakePolicy {
  /** "In 1 hour": minutes from now. */
  laterMinutes: number
  /** "Tonight": this hour today (tomorrow once it has passed). */
  tonightHour: number
  /** "Tomorrow morning": this hour tomorrow. */
  morningHour: number
  maxPerSession: number
  noteMaxChars: number
  /** No attached client may have sent a key for this long before a delivery. */
  quietSeconds: number
  /** A delivery later than this says how late it is. */
  lateNoticeMinutes: number
  /** Failed relaunches of a kept wake before it stops trying. */
  relaunchAttempts: number
  /** Lane reports: a lane counts as finished once idle has held this long
   * (Claude's Stop hooks can leave a short idle blip mid-turn). */
  laneSettleSeconds: number
  /** Lane reports: a permission prompt or question held this long is `blocked`. */
  laneBlockedSeconds: number
  /** Lane reports: at most one `finished` per lane this often; later ones fold into it. */
  laneFinishedFloorSeconds: number
  /** Lane reports: a repeat went-idle line (its receiver neither sent to the
   * lane nor armed a wait on it since the last one) needs the lane idle this
   * long, doubling per repeat; 0 turns the backoff off. */
  laneRepeatQuietSeconds: number
  /** Lane reports: the most quiet a repeat needs (the doubling's cap). */
  laneRepeatQuietMaxSeconds: number
  /** Waits: the deadline when none is given. */
  waitDefaultMinutes: number
  /** Waits: the furthest deadline. */
  waitMaxMinutes: number
  /** Waits: armed waits one session may hold. */
  maxWaitsPerSession: number
  /** Waits: a wait that is over is kept this long (its line stays readable). */
  waitKeepDays: number
}

export const DEFAULT_WAKE_POLICY: Readonly<WakePolicy> = Object.freeze({
  laterMinutes: 60,
  tonightHour: 21,
  morningHour: 8,
  maxPerSession: 5,
  noteMaxChars: 500,
  quietSeconds: 15,
  lateNoticeMinutes: 5,
  relaunchAttempts: 15,
  laneSettleSeconds: 12,
  laneBlockedSeconds: 3,
  laneFinishedFloorSeconds: 120,
  laneRepeatQuietSeconds: 600,
  laneRepeatQuietMaxSeconds: 1800,
  waitDefaultMinutes: 1440,
  waitMaxMinutes: 10080,
  maxWaitsPerSession: 20,
  waitKeepDays: 7,
})

const WAKE_POLICY_BOUNDS: Readonly<Record<keyof WakePolicy, { min: number; max: number }>> =
  Object.freeze({
    laterMinutes: { min: 5, max: 1440 },
    tonightHour: { min: 0, max: 23 },
    morningHour: { min: 0, max: 23 },
    maxPerSession: { min: 1, max: 20 },
    noteMaxChars: { min: 20, max: 1500 },
    quietSeconds: { min: 0, max: 300 },
    lateNoticeMinutes: { min: 1, max: 1440 },
    relaunchAttempts: { min: 1, max: 100 },
    laneSettleSeconds: { min: 0, max: 300 },
    laneBlockedSeconds: { min: 0, max: 300 },
    laneFinishedFloorSeconds: { min: 0, max: 3600 },
    laneRepeatQuietSeconds: { min: 0, max: 3600 },
    laneRepeatQuietMaxSeconds: { min: 0, max: 14400 },
    waitDefaultMinutes: { min: 1, max: 10080 },
    waitMaxMinutes: { min: 1, max: 43200 },
    maxWaitsPerSession: { min: 1, max: 100 },
    waitKeepDays: { min: 1, max: 30 },
  })

export class WakePolicyError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message)
  }
}

export function applyWakePolicyPatch(base: WakePolicy, patch: Record<string, unknown>): WakePolicy {
  const next: WakePolicy = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const bound = WAKE_POLICY_BOUNDS[key as keyof WakePolicy]
    if (!bound) throw new WakePolicyError(key, 'unknown field')
    if (
      !Number.isSafeInteger(value) ||
      (value as number) < bound.min ||
      (value as number) > bound.max
    )
      throw new WakePolicyError(key, `must be a whole number from ${bound.min} to ${bound.max}`)
    next[key as keyof WakePolicy] = value as number
  }
  return next
}

/** A stored value, read leniently: a bad field falls back to its default. */
export function parseStoredWakePolicy(raw: string | null): WakePolicy {
  const policy: WakePolicy = { ...DEFAULT_WAKE_POLICY }
  let parsed: unknown = null
  try {
    parsed = raw ? JSON.parse(raw) : null
  } catch {
    return policy
  }
  if (parsed && typeof parsed === 'object')
    for (const [key, value] of Object.entries(parsed)) {
      try {
        Object.assign(policy, applyWakePolicyPatch(policy, { [key]: value }))
      } catch {
        // keep the default for this field
      }
    }
  return policy
}

// --- rows ------------------------------------------------------------------------

/** What a kept wake needs to start the conversation again after End. */
export interface EndedSession {
  id: string
  tool: string
  projectId: string | null
  projectRoot: string | null
  name: string | null
  origin: string
  coordinator: boolean
  coordinatorId: string | null
  /** The session that launched it (absent on wakes kept before it was recorded). */
  parentId?: string | null
  /** The agent's native conversation ID at End, if Tether saw one. */
  resumeId: string | null
  /** The session ran through an entry (src/lifecycle/entries.ts): it is never
   * started again, since the place the entry led to is gone with End. */
  entry?: { name: string; arg: string } | null
}

/** A delivery row's kind: a scheduled check-in, or an event line Tether
 * queued (a lane report). Only check-ins count against the cap, show in the
 * check-in lists and can be kept past End. */
export type WakeKind = 'time' | 'event'

export interface Wake {
  id: string
  kind: WakeKind
  /** What an event reports (`lane:<id>:finished`); null on a check-in. */
  source: string | null
  /** The session; null once a kept wake outlived it (see `endedSession`). */
  sessionId: string | null
  dueAt: number
  note: string
  createdAt: number
  createdBy: 'agent' | 'owner'
  kept: boolean
  endedSession: EndedSession | null
  attempts: number
  lastError: string | null
  /** Delivery class of an event line: ride-along (never pastes or wakes a
   * session on its own; it joins the next wake paste or the session's next
   * natural turn). A check-in and every other line is wake class. */
  ride: boolean
  /** A wake-class event line that came from outside the session (schema v29):
   * a delivery from another session, or Tether's own `lane:`, `run:` or
   * `ask:` line. Not one the session's own watcher queued for itself. */
  reached: boolean
  /** Sessions whose ride-along reply this row carries (schema v29). */
  replyFrom: string[]
}

interface RawWake {
  id: string
  kind: WakeKind | null
  source: string | null
  session_id: string | null
  due_at: number
  note: string
  created_at: number
  created_by: 'agent' | 'owner'
  kept: number
  ended_session: string | null
  attempts: number
  last_error: string | null
  ride?: number | null
  reached?: number | null
  reply_from?: string | null
}

/** Tether's own event sources that reach a session from outside it (a `wait:`
 * line goes to the session that armed the wait). */
const REACHING_SOURCES = ['lane:', 'run:', 'ask:']

function replyFromOf(raw: string | null | undefined): string[] {
  try {
    const value: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

/** Whether this row alone justifies waking the session (anything but a ride-along line). */
function isWakeClass(wake: Pick<Wake, 'kind' | 'ride'>): boolean {
  return wake.kind !== 'event' || !wake.ride
}

/** The line that carries an owner's answer to an ask (`ask:<id>`, not the
 * launcher's `ask:<id>:filed` or a hand-off). */
const ANSWER_SOURCE = /^ask:[0-9a-f]{12}$/

/** Whether the session's next natural turn (a prompt, a tool result) may take
 * this row: every ride-along line, and an owner's answer to an ask. An answer
 * is also a wake (it pastes once the agent can take a line: idle, or Claude
 * Code with its own turn over and only background agents running), but a
 * session whose agent stays busy must still get it with its next turn, never
 * wait for an idle that may not come. */
function ridesAlong(wake: Pick<Wake, 'kind' | 'ride' | 'source'>): boolean {
  return wake.kind === 'event' && (wake.ride || ANSWER_SOURCE.test(wake.source ?? ''))
}

/** How long, for a log line: seconds under a minute, else whole minutes. */
export function durationLabel(ms: number): string {
  return ms < 60_000 ? `${Math.max(0, Math.floor(ms / 1000))} s` : `${Math.floor(ms / 60_000)} min`
}

/** Whether this row reached the session from outside: a wake-class event
 * line marked `reached` (from another session, or Tether's own lane, run or
 * ask line), or a check-in the owner set. Never a ride-along line (another
 * lane's repeat, an FYI, a bare yes: nothing to act on), a line the session's
 * own watcher queued (an eta reminder, a memory notice), a wait of its own or
 * an agent's check-in (a self-wake). A lane's next went-idle line after such
 * a row is a first line (LaneReporter.reached). */
export function reachesSession(
  wake: Pick<Wake, 'kind' | 'createdBy' | 'ride' | 'reached'>,
): boolean {
  if (wake.kind !== 'event') return wake.createdBy === 'owner'
  return !wake.ride && wake.reached
}

function toWake(raw: RawWake): Wake {
  let ended: EndedSession | null = null
  try {
    ended = raw.ended_session ? (JSON.parse(raw.ended_session) as EndedSession) : null
  } catch {
    ended = null
  }
  return {
    id: raw.id,
    kind: raw.kind ?? 'time',
    source: raw.source ?? null,
    sessionId: raw.session_id,
    dueAt: raw.due_at,
    note: raw.note,
    createdAt: raw.created_at,
    createdBy: raw.created_by,
    kept: raw.kept === 1,
    endedSession: ended,
    attempts: raw.attempts,
    lastError: raw.last_error,
    ride: raw.ride === 1,
    reached: raw.reached === 1,
    replyFrom: replyFromOf(raw.reply_from),
  }
}

/** The public shape (`GET /v1/wakes`). A kept wake names its ended session but
 * not the conversation ID. */
export function wakeJson(wake: Wake): Record<string, unknown> {
  const ended = wake.endedSession
  return {
    id: wake.id,
    sessionId: wake.sessionId,
    dueAt: wake.dueAt,
    note: wake.note,
    createdAt: wake.createdAt,
    createdBy: wake.createdBy,
    kept: wake.kept,
    ...(wake.sessionId === null && ended
      ? {
          endedSession: {
            id: ended.id,
            name: ended.name,
            tool: ended.tool,
            projectId: ended.projectId,
          },
        }
      : {}),
    attempts: wake.attempts,
    lastError: wake.lastError,
  }
}

/** The wakes table (schema v10). One daemon writes it. */
export class WakeStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly random: () => string = () => randomBytes(6).toString('hex'),
  ) {}

  /** Every row, check-ins and events: what the scheduler delivers. */
  list(): Wake[] {
    return (
      this.db.prepare('SELECT * FROM wakes ORDER BY due_at, id').all() as unknown as RawWake[]
    ).map(toWake)
  }

  /** Every row of a session, check-ins and events. */
  forSession(sessionId: string): Wake[] {
    return (
      this.db
        .prepare('SELECT * FROM wakes WHERE session_id = ? ORDER BY due_at, id')
        .all(sessionId) as unknown as RawWake[]
    ).map(toWake)
  }

  /** The check-ins only (`kind = 'time'`): the lists, the cap, End's keep. */
  checkIns(sessionId?: string): Wake[] {
    return (
      sessionId === undefined
        ? this.db.prepare("SELECT * FROM wakes WHERE kind = 'time' ORDER BY due_at, id").all()
        : this.db
            .prepare(
              "SELECT * FROM wakes WHERE kind = 'time' AND session_id = ? ORDER BY due_at, id",
            )
            .all(sessionId)
    ).map((raw) => toWake(raw as unknown as RawWake))
  }

  /** Queue an event line for a session, due now. An undelivered row with the
   * same source takes the newer line instead (coalescing). A merge never makes
   * a queued wake ride-along: the row stays a wake until it goes out or its
   * source withdraws it. Nor does it take back `reached` or `replyFrom`. */
  addEvent(input: {
    sessionId: string
    source: string
    note: string
    now: number
    /** Ride-along class (default: wake class). Merged into a queued wake, it
     * stays a wake. */
    ride?: boolean
    /** It came from outside the session (default: Tether's own lane, run
     * and ask lines). Counts only on a wake-class line. */
    reached?: boolean
    /** Sessions whose ride-along reply it carries. */
    replyFrom?: readonly string[]
  }): Wake {
    const ride = input.ride ? 1 : 0
    const outside =
      input.reached ?? REACHING_SOURCES.some((prefix) => input.source.startsWith(prefix))
    const reached = outside && !input.ride ? 1 : 0
    const replyFrom = input.replyFrom ?? []
    const pending = this.db
      .prepare("SELECT id FROM wakes WHERE kind = 'event' AND session_id = ? AND source = ?")
      .get(input.sessionId, input.source) as { id: string } | undefined
    if (pending) {
      const ids = [...new Set([...(this.get(pending.id)?.replyFrom ?? []), ...replyFrom])]
      this.db
        .prepare(
          'UPDATE wakes SET note = ?, ride = min(ride, ?), reached = max(reached, ?), reply_from = ? WHERE id = ?',
        )
        .run(input.note, ride, reached, ids.length ? JSON.stringify(ids) : null, pending.id)
      return this.get(pending.id) as Wake
    }
    const id = this.random()
    this.db
      .prepare(
        `INSERT INTO wakes (id, session_id, due_at, note, created_at, created_by, kind, source, ride,
           reached, reply_from)
         VALUES (?, ?, ?, ?, ?, 'agent', 'event', ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.sessionId,
        input.now,
        input.note,
        input.now,
        input.source,
        ride,
        reached,
        replyFrom.length ? JSON.stringify([...new Set(replyFrom)]) : null,
      )
    return this.get(id) as Wake
  }

  /** A lane went idle without a went-idle line to carry its ride-along
   * replies (it waits on something of its own): the still-queued ride-along
   * rows carrying one to these receivers become wakes, from outside as a
   * reply posted as a wake is. Returns the sessions whose row changed. */
  promoteReplies(lane: string, receivers: readonly string[]): string[] {
    const promote = this.db.prepare(
      `UPDATE wakes SET ride = 0, reached = 1
        WHERE kind = 'event' AND ride = 1 AND session_id = ? AND reply_from IS NOT NULL
          AND EXISTS (SELECT 1 FROM json_each(wakes.reply_from) WHERE value = ?)`,
    )
    return receivers.filter((receiver) => Number(promote.run(receiver, lane).changes) > 0)
  }

  /** Take back the undelivered event line(s) a source queued (on one session,
   * or on any with null). Returns the rows taken. */
  removeEvents(sessionId: string | null, source: string): Wake[] {
    const rows = (
      sessionId === null
        ? this.db.prepare("SELECT * FROM wakes WHERE kind = 'event' AND source = ?").all(source)
        : this.db
            .prepare("SELECT * FROM wakes WHERE kind = 'event' AND session_id = ? AND source = ?")
            .all(sessionId, source)
    ).map((raw) => toWake(raw as unknown as RawWake))
    for (const row of rows) this.remove(row.id)
    return rows
  }

  /** A kept check-in due now for an ended session (a kept wait that became
   * ready): the scheduler relaunches its conversation with the note. */
  addKept(input: { ended: EndedSession; note: string; now: number }): Wake {
    const id = this.random()
    this.db
      .prepare(
        `INSERT INTO wakes (id, session_id, due_at, note, created_at, created_by, kept, ended_session)
         VALUES (?, NULL, ?, ?, ?, 'agent', 1, ?)`,
      )
      .run(id, input.now, input.note, input.now, JSON.stringify(input.ended))
    return this.get(id) as Wake
  }

  get(id: string): Wake | undefined {
    const raw = this.db.prepare('SELECT * FROM wakes WHERE id = ?').get(id) as RawWake | undefined
    return raw ? toWake(raw) : undefined
  }

  add(input: {
    sessionId: string
    dueAt: number
    note: string
    createdBy: 'agent' | 'owner'
    now: number
  }): Wake {
    const id = this.random()
    this.db
      .prepare(
        'INSERT INTO wakes (id, session_id, due_at, note, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, input.sessionId, input.dueAt, input.note, input.now, input.createdBy)
    return this.get(id) as Wake
  }

  /** Put back a wake taken for a delivery that did not happen. */
  restore(wake: Wake): void {
    // A newer line for the same report arrived while the paste was out: it
    // stands, and stays a wake when the line it replaces was one.
    const newer =
      wake.kind === 'event'
        ? (this.db
            .prepare("SELECT id FROM wakes WHERE kind = 'event' AND session_id = ? AND source = ?")
            .get(wake.sessionId, wake.source) as { id: string } | undefined)
        : undefined
    if (newer) {
      if (!wake.ride) this.db.prepare('UPDATE wakes SET ride = 0 WHERE id = ?').run(newer.id)
      const ids = [...new Set([...(this.get(newer.id)?.replyFrom ?? []), ...wake.replyFrom])]
      this.db
        .prepare('UPDATE wakes SET reached = max(reached, ?), reply_from = ? WHERE id = ?')
        .run(wake.reached ? 1 : 0, ids.length ? JSON.stringify(ids) : null, newer.id)
      return
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO wakes (id, session_id, due_at, note, created_at, created_by, kept,
           ended_session, attempts, last_error, kind, source, ride, reached, reply_from)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        wake.id,
        wake.sessionId,
        wake.dueAt,
        wake.note,
        wake.createdAt,
        wake.createdBy,
        wake.kept ? 1 : 0,
        wake.endedSession ? JSON.stringify(wake.endedSession) : null,
        wake.attempts,
        wake.lastError,
        wake.kind,
        wake.source,
        wake.ride ? 1 : 0,
        wake.reached ? 1 : 0,
        wake.replyFrom.length ? JSON.stringify(wake.replyFrom) : null,
      )
  }

  update(id: string, patch: { dueAt?: number; note?: string }): Wake | undefined {
    const wake = this.get(id)
    if (!wake) return undefined
    this.db
      .prepare(
        'UPDATE wakes SET due_at = ?, note = ?, attempts = 0, last_error = NULL WHERE id = ?',
      )
      .run(patch.dueAt ?? wake.dueAt, patch.note ?? wake.note, id)
    return this.get(id)
  }

  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM wakes WHERE id = ?').run(id).changes === 1
  }

  /** Mark a session's check-ins to outlive its End, with what a relaunch
   * needs (event lines go with the session). Returns how many. */
  keep(sessionId: string, ended: EndedSession): number {
    return Number(
      this.db
        .prepare(
          "UPDATE wakes SET kept = 1, ended_session = ? WHERE session_id = ? AND kind = 'time'",
        )
        .run(JSON.stringify(ended), sessionId).changes,
    )
  }

  /** Undo `keep` after an End that did not happen. */
  unkeep(sessionId: string): void {
    this.db
      .prepare('UPDATE wakes SET kept = 0, ended_session = NULL WHERE session_id = ?')
      .run(sessionId)
  }

  /** Give a kept wake back to a running session that holds its conversation. */
  attach(id: string, sessionId: string): void {
    this.db
      .prepare(
        'UPDATE wakes SET session_id = ?, kept = 0, ended_session = NULL, attempts = 0, last_error = NULL WHERE id = ?',
      )
      .run(sessionId, id)
  }

  failed(id: string, error: string): void {
    this.db
      .prepare('UPDATE wakes SET attempts = attempts + 1, last_error = ? WHERE id = ?')
      .run(error.slice(0, 500), id)
  }
}

// --- the message -----------------------------------------------------------------

/** `5:30 PM`, with the weekday when it is not the same day as `now`. */
export function clockLabel(at: number, now: number): string {
  const time = new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (new Date(at).toDateString() === new Date(now).toDateString()) return time
  return `${new Date(at).toLocaleDateString('en-US', { weekday: 'short' })} ${time}`
}

/** One paste stays under this many bytes (the terminal paste cap is 2000,
 * lifecycle/tmux.ts `isBoundedTerminalText`); what does not fit waits for the
 * next delivery. */
const DELIVERY_BUDGET_BYTES = 1800
const SEPARATOR = ' / '
const ELLIPSIS = '…'

function bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** `text` cut to at most `max` bytes, ending in an ellipsis when cut. */
function cutToBytes(text: string, max: number): string {
  if (bytes(text) <= max) return text
  const room = max - bytes(ELLIPSIS)
  let out = ''
  for (const character of text) {
    if (bytes(out + character) > room) break
    out += character
  }
  return out + ELLIPSIS
}

/** One paste for a session's due rows: wake-class event lines first (oldest
 * first), then the check-ins under their `[Scheduled check-in …]` header, then
 * ride-along lines, all on one line joined with ` / `, under `budget` bytes. `taken` are the rows it
 * carries; the rest stay queued. The first row always goes, cut to fit, so an
 * oversized row can never wedge the session's deliveries. */
export function composeDelivery(
  rows: readonly Wake[],
  now: number,
  policy: WakePolicy,
  budget = DELIVERY_BUDGET_BYTES,
): { text: string; taken: Wake[] } {
  // Wake-class lines first, the check-ins, then the ride-along lines that
  // came with them (they never crowd out what woke the session).
  const events = rows.filter((row) => row.kind === 'event' && !row.ride)
  const ride = rows.filter((row) => row.kind === 'event' && row.ride)
  const checkIns = rows.filter((row) => row.kind !== 'event')
  const header = checkIns[0] ? checkInHeader(checkIns[0].dueAt, now, policy) : ''
  const pieces = [
    ...events.map((row) => ({ row, text: row.note })),
    ...checkIns.map((row, index) => ({
      row,
      text: index === 0 ? `${header} ${row.note}` : row.note,
    })),
    ...ride.map((row) => ({ row, text: row.note })),
  ]
  let text = ''
  const taken: Wake[] = []
  for (const piece of pieces) {
    const next = text ? `${text}${SEPARATOR}${piece.text}` : piece.text
    if (bytes(next) <= budget) {
      text = next
      taken.push(piece.row)
    } else if (!taken.length) {
      text = cutToBytes(piece.text, budget)
      taken.push(piece.row)
    } else break
  }
  return { text, taken }
}

function checkInHeader(
  dueAt: number,
  now: number,
  policy: WakePolicy,
  options: { resumed?: boolean } = {},
): string {
  const parts = [`[Scheduled check-in for ${clockLabel(dueAt, now)}`]
  const lateMinutes = Math.floor((now - dueAt) / 60_000)
  if (lateMinutes > policy.lateNoticeMinutes) parts.push(`${lateMinutes} min late`)
  if (options.resumed) parts.push('resumed after End')
  return `${parts.join(', ')}]`
}

/** What the agent receives for its due wakes, oldest first (a kept wake's
 * relaunch prompt, which is not pasted). */
export function wakeMessage(
  wakes: readonly Wake[],
  now: number,
  policy: WakePolicy,
  options: { resumed?: boolean } = {},
): string {
  const first = wakes[0]
  if (!first) return ''
  return `${checkInHeader(first.dueAt, now, policy, options)} ${wakes.map((wake) => wake.note).join(SEPARATOR)}`
}

/** A note as stored: one line, trimmed, at most `max` characters. Null when
 * empty or carrying control characters other than line breaks and tabs. */
export function cleanNote(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const note = value.replace(/[\r\n\t]+/g, ' ').trim()
  if (!note || Array.from(note).length > max) return null
  for (const character of note) {
    const code = character.codePointAt(0) ?? 0
    if (code < 32 || (code >= 127 && code <= 159) || (code >= 0xd800 && code <= 0xdfff)) return null
  }
  return note
}

// --- the input line ----------------------------------------------------------------

// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are what it parses
const ESCAPE = /\x1b\[([0-9;:?]*)([A-Za-z])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g
/** Claude Code draws `❯`, Codex `›`, older Claude Code `│ >`, agy a bare `>`
 * (nothing after it while the input is empty). A `>` mark counts only right
 * under a rule (the input box's top): a draft line that is just `>` is not one. */
const PROMPT = /^[\s│]*(?:❯|›|>(?=\s|$))/
const ARROW_PROMPT = /^[\s│]*(?:❯|›)/
const RULE = /^[\s│╭╰╮╯]*[─━]{8,}/
/** A line that is only a rule: Pi's editor borders. A border carrying text
 * (Pi's `── ⠧ Working ──`, `─── ↑ 2 more ───`) is not one. */
const BARE_RULE = /^\s*[─━]{8,}\s*$/

/** One captured line (with escapes) as plain text, dim runs left out: the
 * agents draw their input placeholders dim. */
function visibleText(line: string): string {
  let out = ''
  let dim = false
  let last = 0
  for (const match of line.matchAll(ESCAPE)) {
    if (!dim) out += line.slice(last, match.index)
    last = (match.index ?? 0) + match[0].length
    if (match[2] !== 'm') continue
    // A `38:2:r:g:b` group is one parameter; in `38;2;r;g;b` and `38;5;n` the
    // color's numbers follow as their own parameters and are not attributes.
    const codes = (match[1] ?? '').split(';')
    for (let index = 0; index < codes.length; index += 1) {
      const code = codes[index] === '' ? 0 : Number(codes[index])
      if (code === 38 || code === 48 || code === 58)
        index += codes[index + 1] === '5' ? 2 : codes[index + 1] === '2' ? 4 : 0
      else if (code === 2) dim = true
      else if (code === 0 || code === 22) dim = false
    }
  }
  if (!dim) out += line.slice(last)
  return out
}

/**
 * True when the agent's input line on this screen (`capture-pane -p -e`) holds
 * no draft. With a prompt mark, the input is the last prompt line and the lines
 * under it up to a rule or a blank line. `ruled` (Pi) has no mark: the input is
 * every line between the last two bare rules, at least one. A screen without
 * that shape counts as a draft: Tether cannot tell, so it waits.
 */
export function inputLineEmpty(screen: string, shape: 'prompt' | 'ruled' = 'prompt'): boolean {
  const lines = screen.split('\n')
  if (shape === 'ruled') return ruledInputEmpty(lines.map(visibleText))
  let start = -1
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const text = visibleText(lines[index] ?? '')
    if (
      ARROW_PROMPT.test(text) ||
      (PROMPT.test(text) && index > 0 && RULE.test(visibleText(lines[index - 1] ?? '')))
    ) {
      start = index
      break
    }
  }
  if (start < 0) return false
  for (let index = start; index < lines.length; index += 1) {
    const text = visibleText(lines[index] ?? '')
    if (index > start && (RULE.test(text) || !text.trim())) break
    const content = index === start ? text.replace(PROMPT, '') : text.replace(/^[\s│]*/, '')
    if (content.replace(/[\s│]/g, '')) return false
  }
  return true
}

function ruledInputEmpty(texts: readonly string[]): boolean {
  const bottom = texts.findLastIndex((text) => BARE_RULE.test(text))
  const top = texts.slice(0, Math.max(bottom, 0)).findLastIndex((text) => BARE_RULE.test(text))
  if (top < 0 || bottom - top < 2) return false
  return texts.slice(top + 1, bottom).every((text) => !text.trim())
}

// --- the scheduler -------------------------------------------------------------------

/** What the scheduler needs from the running daemon (wake-runtime.ts). */
export interface WakeOperations {
  now(): number
  policy(): WakePolicy
  /** Why the session's agent cannot take a check-in right now (not running, not
   * idle), or null when it is running and idle. */
  busy(sessionId: string): Promise<string | null>
  /** The agent's input line holds no draft. */
  inputEmpty(sessionId: string): Promise<boolean>
  /** When an attached client last sent a key (ms), or null with none attached. */
  lastKeyAt(sessionId: string): Promise<number | null>
  /** Paste and submit; false when the session is not running. */
  deliver(sessionId: string, text: string): Promise<boolean>
  /** The rows went out (`paste`: the gated paste; `native`: a native puller took them). */
  delivered?(sessionId: string, rows: readonly Wake[], via: 'paste' | 'native'): void
  /** The running session that holds this conversation, if any. */
  conversationHolder(resumeId: string): Promise<string | null>
  relaunch(
    ended: EndedSession,
    message: string,
  ): Promise<{ status: 'started'; id: string } | { status: 'retry' | 'failed'; reason: string }>
  /** Wakes changed: republish the session (or the kept list, for null). */
  changed(sessionId: string | null): void
  log(message: string): void
}

/** Re-check due wakes this often while any waits on its gates. */
const WAKE_RECHECK_MS = 3_000
/** A native puller (Claude's asyncRewake hook, Pi's extension) that took a
 * delivery or whose long poll ended re-attaches within this long: the gated
 * paste holds for it meanwhile, so a line is never pasted under it. */
export const PULLER_GRACE_MS = 30_000

/** A native puller waiting on a session's due lines (`GET /v1/sessions/:id/due`). */
interface Puller {
  /** Hand the text over; false when the puller is gone (its request closed). */
  take(text: string): boolean
}
/** One ride-along row as a client saw it: its id and its line's hash. */
function rideMark(wake: Wake): string {
  return `${wake.id}.${createHash('sha256').update(wake.note).digest('hex').slice(0, 8)}`
}

/** A `peekRide` token: up to 64 row marks. */
export const RIDE_TOKEN = /^[\w-]{1,64}\.[0-9a-f]{8}(,[\w-]{1,64}\.[0-9a-f]{8}){0,63}$/

/** Why a session's due rows wait when all of them are ride-along. */
const RIDE_ONLY = 'only ride-along lines are queued: they join the next wake or turn'
/** A kept wake whose relaunch failed tries again after this. */
export const WAKE_RELAUNCH_RETRY_MS = 60_000
/** setTimeout's ceiling is 2^31-1 ms; re-arm before it. */
const MAX_TIMER_MS = 2 ** 31 - 1

export class WakeScheduler {
  private timer: NodeJS.Timeout | null = null
  private recheck: NodeJS.Timeout | null = null
  private running: Promise<void> | null = null
  private again = false
  private stopped = true
  /** Wakes already republished as due. */
  private readonly announced = new Set<string>()
  /** Kept wakes waiting out a failed relaunch. */
  private readonly retryAt = new Map<string, number>()
  /** Why each session's due wakes are not delivered yet. */
  private readonly held = new Map<string, string>()
  /** When each session last took a paste: what did not fit waits for the
   * agent to take that one first, never a second paste on a stale idle. */
  private readonly deliveredAt = new Map<string, number>()
  /** Native pullers attached now, one per session (the newest wins). */
  private readonly pullers = new Map<string, Puller>()
  /** Rows taken out for a delivery that has not settled yet. */
  private readonly sending = new Map<string, Wake>()
  /** Rows in flight whose source took them back: not restored if the
   * delivery fails. */
  private readonly withdrawn = new Set<string>()
  /** When each session's native puller was last attached. */
  private readonly pulledAt = new Map<string, number>()

  constructor(
    private readonly store: WakeStore,
    private readonly ops: WakeOperations,
  ) {}

  start(): void {
    this.stopped = false
    this.nudge()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    if (this.recheck) clearInterval(this.recheck)
    this.timer = null
    this.recheck = null
  }

  /** Why the session's due wakes wait, or null when none waits. */
  heldReason(sessionId: string): string | null {
    return this.held.get(sessionId) ?? null
  }

  /** Whether this queued row is going out right now (a paste in flight): it
   * is neither queued nor dropped. */
  inFlight(wakeId: string): boolean {
    return this.sending.has(wakeId)
  }

  /** A producer takes back its undelivered line (source `<owner>:<what>`) on
   * a session, or on every session with null: the queued rows go; a row in a
   * paste going out now cannot be stopped (`sending`), but does not come back
   * if that paste fails. */
  withdraw(sessionId: string | null, source: string): { withdrawn: Wake[]; sending: boolean } {
    const withdrawn = this.store.removeEvents(sessionId, source)
    let sending = false
    for (const wake of this.sending.values())
      if (
        wake.kind === 'event' &&
        wake.source === source &&
        (sessionId === null || wake.sessionId === sessionId)
      ) {
        this.withdrawn.add(wake.id)
        sending = true
      }
    return { withdrawn, sending }
  }

  /** Whether a native puller is attached to the session, or was within the
   * grace (between two long polls). */
  pulling(sessionId: string): boolean {
    if (this.pullers.has(sessionId)) return true
    const at = this.pulledAt.get(sessionId)
    return at !== undefined && this.ops.now() - at < PULLER_GRACE_MS
  }

  /**
   * A native puller long-polls the session's due lines: resolves with the text
   * of one delivery (the same rows and budget as a paste, gated on the agent
   * being idle but not on typing or the input line: the harness shows it as a
   * notice, never in the owner's input), or null after `ms` or an abort. While
   * one is attached, and for PULLER_GRACE_MS after, nothing is pasted to the
   * session. A newer puller replaces an older one, which gets null. A poll
   * that does not wait (`ms` 0) gets null and holds nothing. `alive` says the
   * client can still be answered; a line is never taken for one that cannot.
   */
  pull(
    sessionId: string,
    ms: number,
    aborted?: AbortSignal,
    alive?: () => boolean,
  ): Promise<string | null> {
    if (ms <= 0) return Promise.resolve(null)
    return new Promise((resolve) => {
      let done = false
      const finish = (text: string | null): boolean => {
        if (done) return false
        done = true
        clearTimeout(timer)
        aborted?.removeEventListener('abort', onAbort)
        if (this.pullers.get(sessionId) === puller) this.pullers.delete(sessionId)
        this.pulledAt.set(sessionId, this.ops.now())
        resolve(text)
        return true
      }
      const puller: Puller = {
        take: (text) => {
          if (aborted?.aborted) return false
          // The client went away unnoticed: end this poll, keep the line.
          if (alive && !alive()) return finish(null) && false
          return finish(text)
        },
      }
      const onAbort = () => finish(null)
      const timer = setTimeout(() => finish(null), ms)
      timer.unref?.()
      if (aborted?.aborted) {
        finish(null)
        return
      }
      aborted?.addEventListener('abort', onAbort)
      const previous = this.pullers.get(sessionId)
      this.pullers.set(sessionId, puller)
      this.pulledAt.set(sessionId, this.ops.now())
      // A replaced puller's request ends empty; its client polls again.
      previous?.take('')
      this.nudge()
    })
  }

  /** The session's due ride-along lines, taken now for its next natural turn
   * (a prompt hook, a tool result): one text under the paste budget, or null
   * with none. The wake-class rows are not touched: they go by the gated
   * paste or the puller. */
  takeRide(sessionId: string): string | null {
    const now = this.ops.now()
    const rows = this.store
      .forSession(sessionId)
      .filter((wake) => ridesAlong(wake) && wake.dueAt <= now)
    if (!rows.length) return null
    const { text, taken } = composeDelivery(rows, now, this.ops.policy())
    this.deliverRide(sessionId, taken, 'natural turn')
    return text
  }

  /** The session's due ride-along lines for its next natural turn, left
   * queued: the text and a token that names exactly these rows as they are
   * now. The client shows the text, then hands the token to `confirmRide`, so
   * a client that times out or dies before showing them loses nothing (the
   * lines stay for the next turn or wake). Null with none. */
  peekRide(sessionId: string): { text: string; token: string } | null {
    const now = this.ops.now()
    const rows = this.store
      .forSession(sessionId)
      .filter((wake) => ridesAlong(wake) && wake.dueAt <= now)
    if (!rows.length) return null
    const { text, taken } = composeDelivery(rows, now, this.ops.policy())
    return { text, token: taken.map(rideMark).join(',') }
  }

  /** The client showed what `peekRide` gave it: those rows go, as a native
   * delivery. A row replaced (a newer line of its source) or made a wake
   * since stays queued. Returns how many went. */
  confirmRide(sessionId: string, token: string): number {
    const marks = new Set(token.split(','))
    const taken = this.store
      .forSession(sessionId)
      .filter((wake) => ridesAlong(wake) && marks.has(rideMark(wake)))
    if (!taken.length) return 0
    this.deliverRide(sessionId, taken, 'natural turn, confirmed')
    return taken.length
  }

  /** Ride-along lines the session has now seen: they go, and the delivery is recorded and logged. */
  private deliverRide(sessionId: string, taken: Wake[], how: string): void {
    // Before the rows go: a pass that sees none clears why the session was held.
    const held = this.heldNote(sessionId, taken)
    for (const wake of taken) this.store.remove(wake.id)
    try {
      this.ops.delivered?.(sessionId, taken, 'native')
    } catch (error) {
      this.ops.log(`delivery record failed: ${(error as Error).message}`)
    }
    this.ops.changed(sessionId)
    this.ops.log(
      `delivered ${taken.length} ride-along line(s) to session=${sessionId} (${how})${held}`,
    )
  }

  /** Something changed (a wake, an agent state): look again soon. */
  nudge(): void {
    if (this.stopped) return
    void this.tick()
  }

  /** One pass; concurrent calls fold into one more pass. */
  tick(): Promise<void> {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = (async () => {
      do {
        this.again = false
        await this.pass().catch((error) =>
          this.ops.log(`wake pass failed: ${(error as Error).message}`),
        )
      } while (this.again && !this.stopped)
    })().finally(() => {
      this.running = null
      this.arm()
    })
    return this.running
  }

  private arm(): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const now = this.ops.now()
    const wakes = this.store.list()
    // Ride-along lines wait for a wake or a natural turn: they are no reason
    // to look again every few seconds.
    const wakeSessions = new Set(
      wakes.filter((wake) => wake.dueAt <= now && isWakeClass(wake)).map((wake) => wake.sessionId),
    )
    const waiting = wakes.filter(
      (wake) =>
        wake.dueAt <= now &&
        !this.stalled(wake) &&
        (isWakeClass(wake) || wake.sessionId === null || wakeSessions.has(wake.sessionId)),
    )
    if (waiting.length && !this.recheck) {
      this.recheck = setInterval(() => void this.tick(), WAKE_RECHECK_MS)
      this.recheck.unref()
    } else if (!waiting.length && this.recheck) {
      clearInterval(this.recheck)
      this.recheck = null
    }
    const next = wakes.find((wake) => wake.dueAt > now)
    if (!next) return
    this.timer = setTimeout(() => void this.tick(), Math.min(next.dueAt - now, MAX_TIMER_MS))
    this.timer.unref()
  }

  /** A kept wake that ran out of relaunch attempts waits for the owner. */
  private stalled(wake: Wake): boolean {
    return wake.sessionId === null && wake.attempts >= this.ops.policy().relaunchAttempts
  }

  private async pass(): Promise<void> {
    const now = this.ops.now()
    const due = this.store.list().filter((wake) => wake.dueAt <= now)
    const live = new Map<string, Wake[]>()
    const kept = new Map<string, Wake[]>()
    for (const wake of due) {
      if (wake.sessionId) live.set(wake.sessionId, [...(live.get(wake.sessionId) ?? []), wake])
      else if (wake.endedSession && !this.stalled(wake))
        kept.set(wake.endedSession.id, [...(kept.get(wake.endedSession.id) ?? []), wake])
    }
    for (const [sessionId, wakes] of live) await this.deliverLive(sessionId, wakes)
    for (const sessionId of this.held.keys()) if (!live.has(sessionId)) this.held.delete(sessionId)
    for (const [sessionId, at] of this.deliveredAt)
      if (now - at > 3_600_000) this.deliveredAt.delete(sessionId)
    for (const [sessionId, at] of this.pulledAt)
      if (!this.pullers.has(sessionId) && now - at > PULLER_GRACE_MS)
        this.pulledAt.delete(sessionId)
    for (const wakes of kept.values()) await this.relaunchKept(wakes)
    for (const id of this.announced) if (!this.store.get(id)) this.announced.delete(id)
  }

  private async deliverLive(sessionId: string, wakes: Wake[]): Promise<void> {
    const fresh = wakes.filter((wake) => !this.announced.has(wake.id))
    if (fresh.length) {
      for (const wake of fresh) this.announced.add(wake.id)
      // Now due: the apps word it as waiting rather than as a time ahead.
      this.ops.changed(sessionId)
    }
    // Ride-along lines never wake a session on their own: they stay queued for
    // the next wake paste or the session's next natural turn (`takeRide`).
    if (!wakes.some(isWakeClass)) {
      this.held.set(sessionId, RIDE_ONLY)
      return
    }
    const native = this.pulling(sessionId)
    const reason = await this.gate(sessionId, native)
    if (reason) {
      this.hold(sessionId, reason)
      return
    }
    // Re-read: a wake cancelled meanwhile must not go out.
    const due = this.store.forSession(sessionId).filter((wake) => wake.dueAt <= this.ops.now())
    if (!due.some(isWakeClass)) return
    const puller = native ? this.pullers.get(sessionId) : undefined
    if (native && !puller) {
      this.hold(sessionId, 'its native puller is between polls')
      return
    }
    const { text: message, taken: current } = composeDelivery(
      due,
      this.ops.now(),
      this.ops.policy(),
    )
    // At most once: the rows go before the paste and come back only when it
    // certainly did not happen.
    for (const wake of current) {
      this.sending.set(wake.id, wake)
      this.store.remove(wake.id)
    }
    let delivered = false
    try {
      delivered = puller ? puller.take(message) : await this.ops.deliver(sessionId, message)
    } finally {
      if (!delivered)
        for (const wake of current) if (!this.withdrawn.has(wake.id)) this.store.restore(wake)
      for (const wake of current) {
        this.sending.delete(wake.id)
        this.withdrawn.delete(wake.id)
      }
      this.ops.changed(sessionId)
    }
    if (!delivered) {
      this.hold(
        sessionId,
        puller ? 'its native puller left before taking it' : 'the paste did not go through',
      )
      if (puller) this.again = true
      return
    }
    try {
      this.ops.delivered?.(sessionId, current, puller ? 'native' : 'paste')
    } catch (error) {
      this.ops.log(`delivery record failed: ${(error as Error).message}`)
    }
    const heldNow = this.held.get(sessionId)
    const held = heldNow === RIDE_ONLY ? undefined : heldNow
    this.held.delete(sessionId)
    const late = durationLabel(this.ops.now() - (current[0]?.dueAt ?? 0))
    const events = current.filter((wake) => wake.kind === 'event').length
    this.ops.log(
      `delivered ${current.length - events} check-in(s)${events ? ` and ${events} event line(s)` : ''} to session=${sessionId}${puller ? ' (native)' : ''}` +
        (held ? `, ${late} after due (held: ${held})` : '') +
        (current.length < due.length
          ? `; ${due.length - current.length} left for the next paste`
          : ''),
    )
    this.deliveredAt.set(sessionId, this.ops.now())
  }

  /** The first gate a due wake fails, or null when it may go out now. A
   * native puller's delivery shows as a notice, not in the input line, so it
   * waits only for the agent to be idle. */
  private async gate(sessionId: string, native = false): Promise<string | null> {
    const busy = await this.ops.busy(sessionId)
    if (busy) return busy
    const quietSeconds = this.ops.policy().quietSeconds
    const last = this.deliveredAt.get(sessionId)
    if (last !== undefined && this.ops.now() - last < quietSeconds * 1000)
      return `a delivery went out in the last ${quietSeconds}s`
    if (native) return null
    const lastKey = await this.ops.lastKeyAt(sessionId)
    if (lastKey !== null && this.ops.now() - lastKey < quietSeconds * 1000)
      return `someone typed in the last ${quietSeconds}s`
    if (!(await this.ops.inputEmpty(sessionId))) return 'the input line holds a draft'
    return null
  }

  /** For a log line: how long the oldest of these rows sat queued, and why
   * the session's delivery was held, when it was held at all. */
  private heldNote(sessionId: string, rows: readonly Wake[]): string {
    const reason = this.held.get(sessionId)
    const queued = Math.min(...rows.map((wake) => wake.dueAt))
    const age = this.ops.now() - queued
    if (!reason && age < 5_000) return ''
    return `, queued ${durationLabel(age)} earlier${reason ? ` (held: ${reason})` : ''}`
  }

  /** Log each new reason a session's due rows wait, once. */
  private hold(sessionId: string, reason: string): void {
    if (this.held.get(sessionId) === reason) return
    this.held.set(sessionId, reason)
    this.ops.log(`delivery for session=${sessionId} waits: ${reason}`)
  }

  private async relaunchKept(wakes: Wake[]): Promise<void> {
    const first = wakes[0]
    const ended = first?.endedSession
    if (!first || !ended) return
    if ((this.retryAt.get(ended.id) ?? 0) > this.ops.now()) return
    if (ended.resumeId) {
      const holder = await this.ops.conversationHolder(ended.resumeId)
      if (holder) {
        // Resumed by hand meanwhile: that session gets the check-in.
        for (const wake of wakes) this.store.attach(wake.id, holder)
        this.ops.changed(null)
        this.ops.changed(holder)
        this.again = true
        return
      }
    }
    const message = wakeMessage(wakes, this.ops.now(), this.ops.policy(), {
      resumed: Boolean(ended.resumeId),
    })
    for (const wake of wakes) this.store.remove(wake.id)
    let outcome: Awaited<ReturnType<WakeOperations['relaunch']>> = {
      status: 'retry',
      reason: 'relaunch did not finish',
    }
    try {
      outcome = await this.ops.relaunch(ended, message)
    } finally {
      if (outcome.status !== 'started') {
        for (const wake of wakes) this.store.restore(wake)
        this.retryAt.set(ended.id, this.ops.now() + WAKE_RELAUNCH_RETRY_MS)
        // An admission refusal is the host saying "not now", not a failure.
        if (outcome.status === 'failed')
          for (const wake of wakes) this.store.failed(wake.id, outcome.reason)
      } else this.retryAt.delete(ended.id)
      this.ops.changed(null)
    }
    if (outcome.status === 'started')
      this.ops.log(`relaunched ended session=${ended.id} as session=${outcome.id} for a check-in`)
    else this.ops.log(`check-in relaunch of session=${ended.id} waits: ${outcome.reason}`)
  }
}
