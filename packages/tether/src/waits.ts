// General waits (docs/api-v1.md "Waits"). An agent registers a wait on its
// own session: a condition (`kind`, `ref`, `until`), a deadline and an
// optional note. Tether keeps it in SQLite and checks it at once, so a
// condition that already holds fires now (level-triggered). A wait fires once
// (a `seq` compare-and-set in the same transaction as its delivery row): when
// the condition holds (`until`), when the thing it waits on is gone (`gone`),
// or at the deadline (`timeout`, never silent). Only `cancel` ends a wait
// quietly. Firing queues one event line on the waiter's delivery queue
// (wakes, kind `event`, source `wait:<id>`), pasted once the agent is idle
// and nobody is typing. A `--block` client has no waiter: it long-polls
// `GET /v1/waits/:id?wait=55`, which keeps answering with the line after it
// fired. A wait kept past End (keepWakes) that becomes ready queues a kept
// check-in, which relaunches the conversation like a kept wake.
// An End's informed receivers cancel their armed waits on that session and
// withdraw its still-queued wait lines, just as they do its lane reports.
//
// Kind `session`: another session (here or relayed from a host) finished a
// turn since `since`, is idle, is blocked on a prompt, or ended. The pull
// kinds (src/wait-kinds.ts: job, reply, run, ask, host, tap, cmd) read their
// owner's state at arm, when it changes (a file watch, an event, a nudge),
// every 60 s and at start. Lines are built from typed values only: never
// agent reply text or an owner's free text. A `cmd` wait names no ref: the
// waiter sends the command (`argv`, `cwd`) and Tether runs it as a transient
// unit under a ref it makes (src/wait-readers.ts), stopped once the wait is over.

import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { HttpError, type Router, readJsonObject, sendJson } from './http'
import { BLOCKING_DETAILS, type LaneView, laneTitle, lineNames } from './lane-reports'
import {
  isPullKind,
  PULL_KINDS,
  PULL_REFS,
  PULL_UNTILS,
  type PullKind,
  type PullRead,
  type PullReading,
  pullLine,
  pullVerdict,
  pullWaitingOn,
} from './wait-kinds'
import type { EndedSession, WakePolicy } from './wakes'

const WAIT_KINDS = ['session', ...PULL_KINDS] as const
export type WaitKind = (typeof WAIT_KINDS)[number]
const SESSION_UNTILS = ['finished', 'idle', 'blocked', 'ended'] as const
type SessionUntil = (typeof SESSION_UNTILS)[number]
export type WaitState = 'armed' | 'fired' | 'timed_out' | 'cancelled'
export type WaitOutcome = 'until' | 'timeout' | 'gone'

const WAIT_ID = /^[0-9a-f]{12}$/
const SESSION_ID = /^[0-9a-f]{8}$/
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const THREAD = /^[0-9A-Za-z-]{8,64}$/
const NOTE_MAX_CHARS = 200
/** The longest a `GET /v1/waits/:id?wait=` holds. */
export const LONG_POLL_MAX_SECONDS = 55
/** Armed waits are looked at again at least this often. */
const RECHECK_MS = 60_000
/** With nothing armed, waits that are over are still pruned this often. */
const PRUNE_MS = 3600_000
/** A wait that is over shows in `--recent` this long. */
const RECENT_MS = 24 * 3600_000
const RECENT_MAX = 20

/** What the target looked like when last seen: the timeout line and the
 * lines after the target is gone read it. */
export interface WaitCursor {
  state: string
  detail: string | null
  title: string
  requestId: string | null
}

export interface Wait {
  id: string
  waiter: string | null
  /** A `--block` client's session (the request's `by`, schema v27): it hears
   * the line through its client, not its queue. */
  armedBy: string | null
  kind: WaitKind
  ref: string
  /** null on this computer; the peer's name for a relayed session. */
  host: string | null
  /** A SessionUntil for `session`, else one of PULL_UNTILS[kind]. */
  until: string
  since: number
  deadline: number
  key: string | null
  note: string | null
  armedAt: number
  seq: number
  cursor: WaitCursor | null
  state: WaitState
  outcome: WaitOutcome | null
  line: string | null
  firedAt: number | null
  kept: boolean
  endedSession: EndedSession | null
}

interface RawWait {
  id: string
  waiter: string | null
  armed_by?: string | null
  kind: string
  ref: string
  host: string
  until: string
  since: number
  deadline: number
  key: string | null
  note: string | null
  armed_at: number
  seq: number
  cursor: string | null
  state: WaitState
  outcome: WaitOutcome | null
  line: string | null
  fired_at: number | null
  kept: number
  ended_session: string | null
}

function parsed<T>(raw: string | null): T | null {
  try {
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function toWait(raw: RawWait): Wait {
  return {
    id: raw.id,
    waiter: raw.waiter,
    armedBy: raw.armed_by ?? null,
    kind: raw.kind as WaitKind,
    ref: raw.ref,
    host: raw.host || null,
    until: raw.until,
    since: raw.since,
    deadline: raw.deadline,
    key: raw.key,
    note: raw.note,
    armedAt: raw.armed_at,
    seq: raw.seq,
    cursor: parsed<WaitCursor>(raw.cursor),
    state: raw.state,
    outcome: raw.outcome,
    line: raw.line,
    firedAt: raw.fired_at,
    kept: raw.kept === 1,
    endedSession: parsed<EndedSession>(raw.ended_session),
  }
}

/** The public shape. A kept wait does not show the conversation ID. */
function waitJson(wait: Wait): Record<string, unknown> {
  return {
    id: wait.id,
    waiter: wait.waiter,
    kind: wait.kind,
    ref: wait.ref,
    host: wait.host,
    until: wait.until,
    since: wait.since,
    deadline: wait.deadline,
    key: wait.key,
    note: wait.note,
    armedAt: wait.armedAt,
    state: wait.state,
    outcome: wait.outcome,
    line: wait.line,
    firedAt: wait.firedAt,
    observed: wait.cursor
      ? { state: wait.cursor.state, detail: wait.cursor.detail, title: wait.cursor.title }
      : null,
    kept: wait.kept,
  }
}

// --- the store ---------------------------------------------------------------------

/** waits and session_sends (schema v19). One daemon writes them. */
export class WaitStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly random: () => string = () => randomBytes(6).toString('hex'),
  ) {}

  /** One transaction; inside an open one, the work joins it. */
  transaction<T>(work: () => T): T {
    if (this.db.isTransaction) return work()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  get(id: string): Wait | undefined {
    const raw = this.db.prepare('SELECT * FROM waits WHERE id = ?').get(id) as RawWait | undefined
    return raw ? toWait(raw) : undefined
  }

  /** The armed wait a waiter's key names. A key is let go when its wait is
   * over or kept, so it can be used again. */
  byKey(waiter: string, key: string): Wait | undefined {
    const raw = this.db
      .prepare("SELECT * FROM waits WHERE waiter = ? AND key = ? AND state = 'armed'")
      .get(waiter, key) as RawWait | undefined
    return raw ? toWait(raw) : undefined
  }

  armed(): Wait[] {
    return (
      this.db
        .prepare("SELECT * FROM waits WHERE state = 'armed' ORDER BY armed_at, id")
        .all() as unknown as RawWait[]
    ).map(toWait)
  }

  /** A waiter's armed waits, oldest first, then (with `recentSince`) the ones
   * over since then, newest first. */
  forWaiter(waiter: string, recentSince?: number): Wait[] {
    const armed = (
      this.db
        .prepare("SELECT * FROM waits WHERE waiter = ? AND state = 'armed' ORDER BY armed_at, id")
        .all(waiter) as unknown as RawWait[]
    ).map(toWait)
    if (recentSince === undefined) return armed
    const over = (
      this.db
        .prepare(
          `SELECT * FROM waits WHERE waiter = ? AND state <> 'armed'
             AND coalesce(fired_at, armed_at) >= ? ORDER BY coalesce(fired_at, armed_at) DESC LIMIT ?`,
        )
        .all(waiter, recentSince, RECENT_MAX) as unknown as RawWait[]
    ).map(toWait)
    return [...armed, ...over]
  }

  /** A receiver's waits on exactly this session, including fired receipts
   * whose delivery may still be queued. No age or recent-list limit. */
  onSession(ref: string, host: string | null, waiter: string): Wait[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM waits WHERE kind = 'session' AND ref = ? AND host = ? AND waiter = ? AND kept = 0",
        )
        .all(ref, host ?? '', waiter) as unknown as RawWait[]
    ).map(toWait)
  }

  insert(
    wait: Omit<Wait, 'id' | 'seq' | 'state' | 'outcome' | 'line' | 'firedAt' | 'armedBy'> & {
      armedBy?: string | null
    },
  ): Wait {
    const id = this.random()
    this.db
      .prepare(
        `INSERT INTO waits (id, waiter, armed_by, kind, ref, host, until, since, deadline, key, note,
           armed_at, cursor, kept, ended_session)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        wait.waiter,
        wait.armedBy ?? null,
        wait.kind,
        wait.ref,
        wait.host ?? '',
        wait.until,
        wait.since,
        wait.deadline,
        wait.key,
        wait.note,
        wait.armedAt,
        wait.cursor ? JSON.stringify(wait.cursor) : null,
        wait.kept ? 1 : 0,
        wait.endedSession ? JSON.stringify(wait.endedSession) : null,
      )
    return this.get(id) as Wait
  }

  /** End an armed wait if nobody else did first (`seq` compare-and-set). */
  settle(
    wait: Wait,
    state: Exclude<WaitState, 'armed'>,
    outcome: WaitOutcome | null,
    line: string | null,
    now: number,
  ): boolean {
    return (
      this.db
        .prepare(
          `UPDATE waits SET seq = seq + 1, state = ?, outcome = ?, line = ?, fired_at = ?, key = NULL
           WHERE id = ? AND seq = ? AND state = 'armed'`,
        )
        .run(state, outcome, line, now, wait.id, wait.seq).changes === 1
    )
  }

  saveCursor(id: string, cursor: WaitCursor): void {
    this.db.prepare('UPDATE waits SET cursor = ? WHERE id = ?').run(JSON.stringify(cursor), id)
  }

  countArmed(waiter: string): number {
    const row = this.db
      .prepare("SELECT count(*) AS n FROM waits WHERE waiter = ? AND state = 'armed'")
      .get(waiter) as { n: number }
    return row.n
  }

  /** Mark a session's armed waits to outlive its End. Returns how many. Their
   * keys go: the session that set them is gone, and kept waits of different
   * ended sessions must not collide once their waiter is cleared. */
  keep(waiter: string, ended: EndedSession): number {
    return Number(
      this.db
        .prepare(
          "UPDATE waits SET kept = 1, ended_session = ?, key = NULL WHERE waiter = ? AND state = 'armed'",
        )
        .run(JSON.stringify(ended), waiter).changes,
    )
  }

  /** Undo `keep` after an End that did not happen. */
  unkeep(waiter: string): void {
    this.db.prepare('UPDATE waits SET kept = 0, ended_session = NULL WHERE waiter = ?').run(waiter)
  }

  /** Waits that ended before `before` go. */
  prune(before: number): number {
    return Number(
      this.db
        .prepare("DELETE FROM waits WHERE state <> 'armed' AND coalesce(fired_at, armed_at) < ?")
        .run(before).changes,
    )
  }

  recordSend(sender: string, target: string, at: number): void {
    this.db
      .prepare(
        `INSERT INTO session_sends (sender, target, at) VALUES (?, ?, ?)
         ON CONFLICT (sender, target) DO UPDATE SET at = excluded.at`,
      )
      .run(sender, target, at)
  }

  /** Whether one of `by` sent to `target` (a local session) or armed a wait
   * on it (`host`: '' for this computer) after `since`, as its waiter or from
   * a `--block` client. */
  actedOn(target: string, host: string, by: readonly string[], since: number): boolean {
    if (!by.length) return false
    const marks = by.map(() => '?').join(', ')
    const sent =
      host === '' &&
      this.db
        .prepare(
          `SELECT 1 FROM session_sends WHERE target = ? AND at > ? AND sender IN (${marks}) LIMIT 1`,
        )
        .get(target, since, ...by) !== undefined
    if (sent) return true
    return (
      this.db
        .prepare(
          `SELECT 1 FROM waits WHERE kind = 'session' AND ref = ? AND host = ? AND armed_at > ?
             AND (waiter IN (${marks}) OR armed_by IN (${marks})) LIMIT 1`,
        )
        .get(target, host, since, ...by, ...by) !== undefined
    )
  }

  /**
   * Which of `sessions` hear a lane line about `target` (`host`: '' for this
   * computer) from a session wait of their own, as its waiter or the session a
   * `--block` client armed it from. A wait still armed that fires on this
   * event, or one that fired on it (at or after `at`), covers it: `finished`
   * by a wait until finished (a turn after its `since`, by `agentAt`) or idle,
   * `blocked` by one until blocked, `ended` by any (it fires ended or gone).
   * `counts` drops a wait nobody hears (a `--block` client that is gone).
   */
  heardFrom(
    target: string,
    host: string,
    sessions: readonly string[],
    event: { outcome: 'finished' | 'blocked' | 'ended'; at: number; agentAt: number },
    counts: (wait: {
      id: string
      waiter: string | null
      state: 'armed' | 'fired'
    }) => boolean = () => true,
  ): Set<string> {
    const heard = new Set<string>()
    if (!sessions.length) return heard
    const marks = sessions.map(() => '?').join(', ')
    const rows = this.db
      .prepare(
        `SELECT id, waiter, armed_by, until, since, state, outcome, fired_at FROM waits
           WHERE kind = 'session' AND ref = ? AND host = ? AND state IN ('armed', 'fired')
             AND (waiter IN (${marks}) OR armed_by IN (${marks}))`,
      )
      .all(target, host, ...sessions, ...sessions) as unknown as {
      id: string
      waiter: string | null
      armed_by: string | null
      until: string
      since: number
      state: 'armed' | 'fired'
      outcome: WaitOutcome | null
      fired_at: number | null
    }[]
    const wanted = new Set(sessions)
    for (const row of rows) {
      const armed = row.state === 'armed'
      const firedOnIt = !armed && (row.fired_at ?? 0) >= event.at
      let covers = false
      if (event.outcome === 'ended')
        covers =
          armed ||
          (firedOnIt &&
            (row.outcome === 'gone' || (row.until === 'ended' && row.outcome === 'until')))
      else if (event.outcome === 'blocked')
        covers = row.until === 'blocked' && (armed || (firedOnIt && row.outcome === 'until'))
      else if (row.until === 'idle' || (row.until === 'finished' && event.agentAt > row.since))
        covers = armed || (firedOnIt && row.outcome === 'until')
      if (!covers || !counts(row)) continue
      for (const id of [row.waiter, row.armed_by]) if (id && wanted.has(id)) heard.add(id)
    }
    return heard
  }

  lastSend(sender: string, target: string): number | null {
    const row = this.db
      .prepare('SELECT at FROM session_sends WHERE sender = ? AND target = ?')
      .get(sender, target) as { at: number } | undefined
    return row?.at ?? null
  }
}

// --- the condition -------------------------------------------------------------------

export type WaitPolicy = Pick<
  WakePolicy,
  | 'laneSettleSeconds'
  | 'laneBlockedSeconds'
  | 'waitDefaultMinutes'
  | 'waitMaxMinutes'
  | 'maxWaitsPerSession'
  | 'waitKeepDays'
>

/**
 * Whether a session wait's condition holds now: `until`, `gone` (the target
 * ended before it held), or null with when to look again (a state that has
 * not held long enough yet). `target` null means no such session any more;
 * `exited` that its agent left its pane for good.
 */
export function sessionVerdict(
  wait: { until: string; since: number },
  target: LaneView | null,
  exited: boolean,
  policy: WaitPolicy,
  now: number,
): { outcome: WaitOutcome | null; recheckAt: number | null } {
  if (!target || exited)
    return { outcome: wait.until === 'ended' ? 'until' : 'gone', recheckAt: null }
  const settle = (holdSeconds: number) => {
    const at = target.stateAt + holdSeconds * 1000
    return at <= now
      ? { outcome: 'until' as const, recheckAt: null }
      : { outcome: null, recheckAt: at }
  }
  if (wait.until === 'finished') {
    // A turn that ended after `since` by the agent's own clock (0, a first
    // sighting with no agent time, is no known turn), and the agent waits on
    // nothing of its own.
    if (target.state === 'idle' && target.stateAgentAt > wait.since && !target.waitingOn)
      return settle(policy.laneSettleSeconds)
  } else if (wait.until === 'idle') {
    if (target.state === 'idle') return settle(policy.laneSettleSeconds)
  } else if (wait.until === 'blocked') {
    if (
      target.state === 'blocked' &&
      target.stateDetail !== null &&
      BLOCKING_DETAILS.has(target.stateDetail)
    )
      return settle(policy.laneBlockedSeconds)
  }
  return { outcome: null, recheckAt: null }
}

// --- the text ------------------------------------------------------------------------

/** `2h`, `45m`, `1h30m`, `3d`. */
export function spanLabel(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  if (minutes >= 2 * 1440 && minutes % 1440 === 0) return `${minutes / 1440}d`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours}h${rest}m` : `${hours}h`
}

const UNTIL_WORDS: Record<SessionUntil, { ready: string; not: string; gone: string }> = {
  // Idle after the send is all Tether knows: never "finished" (it may be waiting on its own check).
  finished: { ready: 'went idle', not: 'not idle yet', gone: 'ended before it went idle' },
  idle: { ready: 'is idle', not: 'not idle', gone: 'ended before it was idle' },
  blocked: { ready: 'is blocked', not: 'not blocked', gone: 'ended without being blocked' },
  ended: { ready: 'ended', not: 'not ended', gone: 'ended' },
}

/** The one line a waiter gets. Built from typed values and the waiter's own
 * note only. */
export function waitLine(
  wait: Pick<Wait, 'ref' | 'host' | 'until' | 'note' | 'armedAt' | 'cursor'>,
  outcome: WaitOutcome,
  now: number,
): string {
  const cursor = wait.cursor
  const until = wait.until as SessionUntil
  const { name, look } = lineNames({
    id: wait.ref,
    host: wait.host,
    title: cursor?.title ?? wait.ref,
    requestId: cursor?.requestId ?? null,
  })
  const words = UNTIL_WORDS[until]
  const detail =
    cursor?.detail && BLOCKING_DETAILS.has(cursor.detail) ? cursor.detail : 'waiting on input'
  let head: string
  if (outcome === 'until')
    head = `[Ready] session ${name} ${until === 'blocked' ? `is blocked: ${detail}` : words.ready}`
  else if (outcome === 'gone') head = `[Wait over] session ${name} ${words.gone}`
  else {
    const state =
      cursor && cursor.state !== 'unknown'
        ? `: it is ${cursor.state === 'blocked' ? `blocked (${detail})` : cursor.state}`
        : ''
    head = `[Wait timed out] session ${name} ${words.not} after ${spanLabel(now - wait.armedAt)}${state}`
  }
  const note = wait.note ? ` · re: "${laneTitle(wait.note, NOTE_MAX_CHARS)}"` : ''
  return `${head}${note} · ${look}`
}

/** A pull wait's line: the reading as fired, or the last one seen when the
 * thing is gone or the wait timed out without a reading. */
function pullWaitLine(
  wait: Pick<Wait, 'kind' | 'ref' | 'until' | 'note' | 'armedAt' | 'cursor'>,
  outcome: WaitOutcome,
  reading: PullRead,
  now: number,
): string {
  const last: PullReading | null = wait.cursor
    ? { state: wait.cursor.state, detail: wait.cursor.detail, title: wait.cursor.title }
    : null
  const shown = outcome === 'gone' && reading === null ? null : (reading ?? last)
  return pullLine(
    { kind: wait.kind as PullKind, ref: wait.ref, until: wait.until, note: wait.note },
    outcome,
    shown,
    last?.title ?? null,
    spanLabel(now - wait.armedAt),
    NOTE_MAX_CHARS,
  )
}

function readingCursor(reading: PullReading): WaitCursor {
  return {
    state: reading.state,
    detail: reading.detail,
    title: reading.title ?? '',
    requestId: null,
  }
}

function cursorOf(view: LaneView): WaitCursor {
  return {
    state: view.state,
    detail: view.stateDetail,
    title: view.title,
    requestId: view.requestId,
  }
}

function sameCursor(a: WaitCursor | null, b: WaitCursor): boolean {
  return (
    a !== null &&
    a.state === b.state &&
    a.detail === b.detail &&
    a.title === b.title &&
    a.requestId === b.requestId
  )
}

// --- the service ---------------------------------------------------------------------

export interface WaitOperations {
  now(): number
  policy(): WaitPolicy
  /** The session `ref` names (a session id or a root request id), on this
   * computer first, then on a relayed host; null when none is known. */
  resolve(ref: string): { id: string; host: string | null } | null
  /** The session as it is now; null when it is gone. */
  view(id: string, host: string | null): LaneView | null
  /** A session that `ref` named and that has ended (its id, retired or a
   * root request's tombstone); null when `ref` never named one here. */
  endedSession(ref: string): string | null
  /** The full ref a pull wait keeps (a job id prefix made whole), or null
   * when it names nothing (an unknown or ambiguous prefix). */
  pullRef(kind: PullKind, ref: string): string | null
  /** The owner's state now (src/wait-kinds.ts PullRead). Cheap: files and
   * Tether's own state, read at once. */
  read(kind: PullKind, ref: string): PullRead
  /** Look again beyond `read` where the owner needs a probe (a job whose
   * runner may have been killed: its owner's CLI, as an idle-weight unit),
   * then poke the waits on it. `force` (a nudge) skips the throttle. */
  refresh?(kind: PullKind, ref: string, force: boolean): void
  /** The waiter already has this line another way: an ask's answer queued to
   * the session that asked, a run's pause told to the session that launched
   * it. The wait fires without a second line. */
  told?(wait: Wait): boolean
  /** Record and start a `cmd` wait's watcher (throws when it can't). */
  createCmd?(ref: string, spec: { argv: string[]; cwd: string; deadline: number }): void
  /** The argv a `cmd` wait runs, or null (a key's same-target check). */
  cmdArgv?(ref: string): string[] | null
  /** A pull wait is over (fired, timed out, cancelled): its owner may let go
   * of what it holds for it (a `cmd` watcher's unit and files). */
  settled?(wait: Wait): void
  /** The full look: `cmd` watchers whose wait is no longer armed (a waiter
   * that ended takes its waits) are stopped and dropped. */
  sweepCmd?(armed: ReadonlySet<string>): void
  /** A local session's agent left its pane for good (a clean exit, or crash
   * recovery holds it). */
  agentGone(id: string): boolean
  /** A session that can take wait lines: an agent Tether delivers to. */
  receiver(id: string): boolean
  /** Why `thread` (the caller's CODEX_THREAD_ID) is provably not `waiter`'s
   * main agent, or null when it may be. */
  notMainAgent(waiter: string, thread: string): Promise<string | null>
  /** Queue one line on the waiter's delivery queue. Runs inside the firing
   * transaction: it must only write the row. */
  deliver(waiter: string, source: string, line: string): void
  /** Withdraw a source's queued line; an in-flight paste cannot be stopped,
   * but must not restore the line on failure. */
  withdraw(waiter: string, source: string): { withdrawn: number; sending: boolean }
  /** A kept wait is ready: queue a kept check-in that relaunches the ended
   * session's conversation. Runs inside the firing transaction. */
  relaunch(ended: EndedSession, line: string): void
  /** The waiter's waits changed (its descriptor's `waitingOn`, its queue). */
  changed(waiter: string | null): void
  log(message: string): void
}

export interface ArmInput {
  waiter: string | null
  /** The session the request comes from (the waiter, or a `--block` client's
   * session): whose last send `since` defaults to. */
  by: string | null
  kind: WaitKind
  ref: string
  until: string
  since: number | null
  timeoutMinutes: number | null
  key: string | null
  note: string | null
  thread: string | null
  /** Kind `cmd`: what to run (no ref; Tether makes one). */
  cmd?: { argv: string[]; cwd: string } | null
}

export class WaitRefused extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(code)
  }
}

export class WaitService {
  private timer: NodeJS.Timeout | null = null
  private pending: Set<string> | null = null
  private pendingAll = false
  private scheduled = false
  private stopped = true
  private readonly listeners = new Map<string, Set<() => void>>()
  /** `--block` clients (no waiter), in memory: when one last asked about a
   * wait, and when one was given its line. After a restart a client counts
   * again once it asks. */
  private readonly polled = new Map<string, number>()
  private readonly answered = new Map<string, number>()

  constructor(
    readonly store: WaitStore,
    private readonly ops: WaitOperations,
  ) {}

  start(): void {
    this.stopped = false
    this.check()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    for (const set of this.listeners.values()) for (const listener of set) listener()
    this.listeners.clear()
  }

  /** A session changed or ended (local or relayed): look at the waits on it
   * soon (all of them with no id). Never inside the caller's stack, which may
   * hold a transaction. */
  poke(id?: string): void {
    this.pokeKind('session', id)
  }

  /** Something a kind's waits read changed (a file, an event): look at the
   * waits of that kind soon, on `ref` only when given. */
  pokeKind(kind: WaitKind, ref?: string): void {
    if (this.stopped) return
    this.pending ??= new Set()
    this.pending.add(ref === undefined ? `${kind}:*` : `${kind}:${ref}`)
    this.later()
  }

  /** A producer's nudge (`POST /v1/waits/check`): re-read now. It carries no
   * outcome; a lost one costs the 60 s re-read. Returns the armed waits it
   * looks at. */
  nudge(kind: WaitKind, ref?: string): number {
    const armed = this.store
      .armed()
      .filter((wait) => wait.kind === kind && (ref === undefined || wait.ref === ref))
    if (isPullKind(kind)) for (const wait of armed) this.ops.refresh?.(kind, wait.ref, true)
    this.pokeKind(kind, ref)
    return armed.length
  }

  private later(all = false): void {
    if (all) this.pendingAll = true
    if (this.scheduled) return
    this.scheduled = true
    setImmediate(() => {
      this.scheduled = false
      const ids = this.pendingAll ? undefined : (this.pending ?? undefined)
      this.pendingAll = false
      this.pending = null
      this.check(ids)
    })
  }

  /** What the waiter's descriptor says it waits on (`waitingOn`), or null. */
  waitingOn(waiter: string): string | null {
    const first = this.store.forWaiter(waiter)[0]
    if (!first) return null
    if (isPullKind(first.kind)) return pullWaitingOn(first.kind, first.ref, first.until)
    const title = laneTitle(first.cursor?.title ?? first.ref)
    return `a wait on session "${title}" (${first.until})`
  }

  async arm(input: ArmInput): Promise<{ wait: Wait; created: boolean }> {
    const now = this.ops.now()
    const policy = this.ops.policy()
    if (input.waiter !== null) {
      if (!this.ops.receiver(input.waiter)) throw new WaitRefused(409, 'wait_unsupported')
      if (input.thread) {
        const why = await this.ops.notMainAgent(input.waiter, input.thread)
        if (why) throw new WaitRefused(409, 'not_main_agent', { detail: why })
      }
    }
    if (input.key) {
      // A blocking client has no session to hold its keys; it asks again by id.
      if (input.waiter === null) throw new WaitRefused(400, 'invalid_body', { field: 'key' })
      const existing = this.store.byKey(input.waiter, input.key)
      if (existing) {
        if (
          existing.kind !== input.kind ||
          existing.until !== input.until ||
          !(input.kind === 'cmd'
            ? this.sameCmd(existing, input.cmd ?? null)
            : this.sameTarget(existing, input.ref))
        )
          throw new WaitRefused(409, 'key_conflict', { waitId: existing.id })
        return { wait: existing, created: false }
      }
    }
    if (input.timeoutMinutes !== null && input.timeoutMinutes > policy.waitMaxMinutes)
      throw new WaitRefused(400, 'invalid_body', {
        field: 'timeoutMinutes',
        max: policy.waitMaxMinutes,
      })
    if (input.waiter !== null && this.store.countArmed(input.waiter) >= policy.maxWaitsPerSession)
      throw new WaitRefused(409, 'too_many_waits', { max: policy.maxWaitsPerSession })
    if (input.kind === 'cmd') return this.armCmd(input, now)
    if (isPullKind(input.kind)) return this.armPull(input, input.kind, now)
    const target = this.ops.resolve(input.ref)
    if (!target) {
      // A session that already ended is over at once, not unknown.
      const ended = this.ops.endedSession(input.ref)
      if (ended === null) throw new WaitRefused(404, 'not_found', { field: 'ref' })
      if (ended === input.waiter || ended === input.by) throw new WaitRefused(409, 'self_wait')
      return this.armed(input, { ref: ended, since: input.since ?? now, cursor: null }, now)
    }
    if (target.host === null && (target.id === input.waiter || target.id === input.by))
      throw new WaitRefused(409, 'self_wait')
    const view = this.ops.view(target.id, target.host)
    if (!view) throw new WaitRefused(404, 'not_found', { field: 'ref' })
    const by = input.by ?? input.waiter
    let since = input.since
    if (since === null && by !== null) since = this.store.lastSend(by, target.id)
    // The launcher's prompt is its first send. Not for a session on another
    // host: a follow-up sent there goes through the hub unrecorded, and the
    // turn before it would read as finished.
    if (
      since === null &&
      by !== null &&
      target.host === null &&
      view.parentId === by &&
      view.launched
    )
      since = view.createdAt
    return this.armed(
      input,
      { ref: target.id, host: target.host, since: since ?? now, cursor: cursorOf(view) },
      now,
    )
  }

  /** A pull kind: the ref names something its owner knows now (a job, a
   * request, a run, an ask, a host), or a tap not taken in yet. */
  private armPull(input: ArmInput, kind: PullKind, now: number): { wait: Wait; created: boolean } {
    const ref = this.ops.pullRef(kind, input.ref)
    if (ref === null) throw new WaitRefused(404, 'not_found', { field: 'ref' })
    const reading = this.ops.read(kind, ref)
    if (reading === null) throw new WaitRefused(404, 'not_found', { field: 'ref' })
    return this.armed(
      input,
      { ref, since: now, cursor: reading ? readingCursor(reading) : null },
      now,
    )
  }

  /** A `cmd` wait: Tether makes the ref, records and starts the watcher
   * (deferred while admission is red), then arms on it. */
  private armCmd(input: ArmInput, now: number): { wait: Wait; created: boolean } {
    const cmd = input.cmd
    if (!cmd) throw new WaitRefused(400, 'invalid_body', { field: 'argv' })
    if (!this.ops.createCmd) throw new WaitRefused(409, 'waits_unavailable')
    const ref = randomBytes(6).toString('hex')
    const deadline = now + this.timeoutOf(input) * 60_000
    try {
      this.ops.createCmd(ref, { argv: cmd.argv, cwd: cmd.cwd, deadline })
    } catch (error) {
      this.ops.log(`cmd ${ref}: could not record it: ${(error as Error).message}`)
      throw new WaitRefused(500, 'cmd_unavailable')
    }
    const reading = this.ops.read('cmd', ref)
    return this.armed(
      input,
      { ref, since: now, cursor: reading ? readingCursor(reading) : null },
      now,
    )
  }

  private timeoutOf(input: ArmInput): number {
    return input.timeoutMinutes ?? this.ops.policy().waitDefaultMinutes
  }

  private sameCmd(wait: Wait, cmd: { argv: string[] } | null): boolean {
    const argv = this.ops.cmdArgv?.(wait.ref) ?? null
    return (
      cmd !== null &&
      argv !== null &&
      argv.length === cmd.argv.length &&
      argv.every((part, index) => part === cmd.argv[index])
    )
  }

  private armed(
    input: ArmInput,
    target: { ref: string; host?: string | null; since: number; cursor: WaitCursor | null },
    now: number,
  ): { wait: Wait; created: boolean } {
    const wait = this.store.insert({
      waiter: input.waiter,
      armedBy: input.waiter === null ? input.by : null,
      kind: input.kind,
      ref: target.ref,
      host: target.host ?? null,
      until: input.until,
      since: target.since,
      deadline: now + this.timeoutOf(input) * 60_000,
      key: input.key,
      note: input.note,
      armedAt: now,
      cursor: target.cursor,
      kept: false,
      endedSession: null,
    })
    this.ops.log(
      `armed wait=${wait.id} by ${wait.waiter ?? 'a blocking client'} on ${where(wait)} until ${wait.until}`,
    )
    this.evaluate(wait)
    this.ops.changed(wait.waiter)
    this.schedule()
    return { wait: this.store.get(wait.id) as Wait, created: true }
  }

  private sameTarget(wait: Wait, ref: string): boolean {
    if (wait.ref === ref) return true
    if (isPullKind(wait.kind)) return this.ops.pullRef(wait.kind, ref) === wait.ref
    const target = this.ops.resolve(ref)
    return target !== null && target.id === wait.ref && target.host === wait.host
  }

  /** These receivers already know the session ended (the End's requester).
   * Other watchers, the root, and non-session waits stay. */
  sessionHandled(ref: string, host: string | null, receivers: readonly string[]): void {
    this.store.transaction(() => {
      for (const receiver of receivers)
        for (const wait of this.store.onSession(ref, host, receiver)) {
          if (wait.state === 'armed') this.cancel(wait.id)
          const { withdrawn, sending } = this.ops.withdraw(receiver, `wait:${wait.id}`)
          if (withdrawn || sending)
            this.ops.log(
              `wait=${wait.id} on ${where(wait)} handled by ${receiver}: withdrew ${withdrawn} line(s)${sending ? '; delivery in flight' : ''}`,
            )
        }
    })
  }

  /** Cancel an armed wait: quiet, no line. False when it was not armed. */
  cancel(id: string): { cancelled: boolean; wait: Wait | undefined } {
    const wait = this.store.get(id)
    if (wait?.state !== 'armed') return { cancelled: false, wait }
    const cancelled = this.store.settle(wait, 'cancelled', null, null, this.ops.now())
    if (cancelled) {
      this.ops.log(`cancelled wait=${id}`)
      this.letGo(wait)
      this.notify(id)
      this.ops.changed(wait.waiter)
    }
    return { cancelled, wait: this.store.get(id) }
  }

  /** The wait once it is no longer armed, or as it is after `ms`. */
  async waitFor(id: string, ms: number, aborted?: AbortSignal): Promise<Wait | undefined> {
    const now = this.store.get(id)
    this.asked(id, now)
    // Held also before start (Tether is still starting): an answer at once
    // would set a blocking client polling in a tight loop.
    if (now?.state !== 'armed' || ms <= 0) return now
    await new Promise<void>((resolve) => {
      let set = this.listeners.get(id)
      if (!set) {
        set = new Set()
        this.listeners.set(id, set)
      }
      const done = () => {
        clearTimeout(timer)
        aborted?.removeEventListener('abort', done)
        const current = this.listeners.get(id)
        current?.delete(done)
        if (current && !current.size) this.listeners.delete(id)
        resolve()
      }
      const timer = setTimeout(done, ms)
      timer.unref?.()
      aborted?.addEventListener('abort', done)
      set.add(done)
    })
    const after = this.store.get(id)
    if (!aborted?.aborted) this.asked(id, after)
    return after
  }

  /** A `--block` client asked about `id` and is given `wait`. */
  private asked(id: string, wait: Wait | undefined): void {
    const now = this.ops.now()
    for (const seen of [this.answered, this.polled])
      for (const [key, at] of seen) if (now - at > PRUNE_MS) seen.delete(key)
    if (!wait) return
    if (wait.state === 'armed') this.polled.set(id, now)
    else {
      this.polled.delete(id)
      if (wait.state === 'fired') this.answered.set(id, now)
    }
  }

  /** Whether the session a wait is for hears it: a waiter always (its queue);
   * a `--block` client while one is asking (attached, or asked within two
   * long polls), and once fired only if one was given the line. */
  private clientHears(wait: {
    id: string
    waiter: string | null
    state: 'armed' | 'fired'
  }): boolean {
    if (wait.waiter !== null) return true
    if (wait.state === 'fired') return this.answered.has(wait.id)
    if (this.listeners.has(wait.id)) return true
    const at = this.polled.get(wait.id)
    return at !== undefined && this.ops.now() - at <= 2 * LONG_POLL_MAX_SECONDS * 1000
  }

  /** Which of `sessions` hear a lane line's event from a wait of their own
   * (WaitStore.heardFrom), counting a `--block` client only while it is there. */
  heardFrom(
    target: string,
    host: string,
    sessions: readonly string[],
    event: { outcome: 'finished' | 'blocked' | 'ended'; at: number; agentAt: number },
  ): Set<string> {
    return this.store.heardFrom(target, host, sessions, event, (wait) => this.clientHears(wait))
  }

  private notify(id: string): void {
    const set = this.listeners.get(id)
    if (!set) return
    // A client attached now is handed this wait as it is (fired: its line).
    if (this.store.get(id)?.state === 'fired') this.answered.set(id, this.ops.now())
    for (const listener of [...set]) listener()
  }

  /** Look at armed waits (all, or those on these sessions), fire the ready
   * ones, prune old ones and set the next timer. */
  check(ids?: ReadonlySet<string>): void {
    if (this.stopped) return
    const now = this.ops.now()
    for (const wait of this.store.armed()) {
      if (
        ids &&
        !ids.has(`${wait.kind}:${wait.ref}`) &&
        !ids.has(`${wait.kind}:*`) &&
        wait.deadline > now
      )
        continue
      try {
        // The 60 s look also asks owners that need a probe (a job whose
        // runner may have died); the probe pokes the wait when it answers.
        if (!ids && isPullKind(wait.kind)) this.ops.refresh?.(wait.kind, wait.ref, false)
        this.evaluate(wait)
      } catch (error) {
        this.ops.log(`wait=${wait.id} check failed: ${(error as Error).message}`)
      }
    }
    if (!ids) {
      this.lastFullCheck = now
      try {
        this.ops.sweepCmd?.(
          new Set(
            this.store
              .armed()
              .filter((wait) => wait.kind === 'cmd')
              .map((wait) => wait.ref),
          ),
        )
      } catch (error) {
        this.ops.log(`cmd sweep failed: ${(error as Error).message}`)
      }
      this.store.prune(now - this.ops.policy().waitKeepDays * 24 * 3600_000)
    }
    this.schedule()
  }

  /** When each armed wait next needs a look: the settle time of a state not
   * held long enough yet. */
  private readonly recheckAt = new Map<string, number>()
  /** A look at every armed wait at least every RECHECK_MS, however often a
   * poke looks at some of them. */
  private lastFullCheck = 0

  private evaluate(wait: Wait): void {
    const now = this.ops.now()
    const policy = this.ops.policy()
    this.recheckAt.delete(wait.id)
    if (isPullKind(wait.kind)) {
      this.evaluatePull(wait, wait.kind, now)
      return
    }
    const view = this.ops.view(wait.ref, wait.host)
    if (view) {
      const cursor = cursorOf(view)
      if (!sameCursor(wait.cursor, cursor)) {
        this.store.saveCursor(wait.id, cursor)
        wait.cursor = cursor
      }
    }
    const exited =
      view !== null &&
      wait.host === null &&
      view.state === 'unknown' &&
      this.ops.agentGone(wait.ref)
    const verdict = sessionVerdict(wait, view, exited, policy, now)
    if (verdict.outcome) {
      this.fire(wait, verdict.outcome, now)
      return
    }
    if (wait.deadline <= now) {
      this.fire(wait, 'timeout', now)
      return
    }
    if (verdict.recheckAt !== null) this.recheckAt.set(wait.id, verdict.recheckAt)
  }

  private evaluatePull(wait: Wait, kind: PullKind, now: number): void {
    const reading = this.ops.read(kind, wait.ref)
    if (reading) {
      const cursor = readingCursor(reading)
      if (!sameCursor(wait.cursor, cursor)) {
        this.store.saveCursor(wait.id, cursor)
        wait.cursor = cursor
      }
    }
    // A watcher systemd stopped at its runtime limit (deadline + grace, while
    // Tether was down past the deadline) is this wait's timeout, not a failure.
    if (kind === 'cmd' && reading?.state === 'failed' && reading.detail === 'timeout') {
      this.fire(wait, 'timeout', now, reading)
      return
    }
    const verdict = pullVerdict(kind, wait.until, reading)
    if (verdict) {
      // Told another way already (an ask's answer to the asker, a run's
      // pause to its launcher): over, without a second line.
      const quiet = verdict === 'until' && !wait.kept && (this.ops.told?.(wait) ?? false)
      this.fire(wait, verdict, now, reading, quiet)
      return
    }
    if (wait.deadline <= now) this.fire(wait, 'timeout', now, reading)
  }

  private fire(
    wait: Wait,
    outcome: WaitOutcome,
    now: number,
    reading?: PullRead,
    quiet = false,
  ): void {
    const line = isPullKind(wait.kind)
      ? pullWaitLine(wait, outcome, reading, now)
      : waitLine(wait, outcome, now)
    const fired = this.store.transaction(() => {
      if (
        !this.store.settle(wait, outcome === 'timeout' ? 'timed_out' : 'fired', outcome, line, now)
      )
        return false
      // A kept wait relaunches (also while its End is still deleting the
      // waiter, whose queue goes with it); a timeout or gone is only recorded.
      if (quiet) {
        // The waiter has this line already.
      } else if (wait.kept && wait.endedSession) {
        if (outcome === 'until') this.ops.relaunch(wait.endedSession, line)
      } else if (wait.waiter) this.ops.deliver(wait.waiter, `wait:${wait.id}`, line)
      return true
    })
    if (!fired) return
    this.recheckAt.delete(wait.id)
    this.letGo(wait)
    const to = quiet
      ? 'told already'
      : wait.kept
        ? `kept (${wait.endedSession?.id ?? '?'})`
        : (wait.waiter ?? 'a blocking client')
    this.ops.log(`wait=${wait.id} on ${where(wait)} ${outcome} -> ${to}`)
    this.notify(wait.id)
    this.ops.changed(wait.waiter)
  }

  private letGo(wait: Wait): void {
    if (!isPullKind(wait.kind)) return
    try {
      this.ops.settled?.(wait)
    } catch (error) {
      this.ops.log(`wait=${wait.id} let-go failed: ${(error as Error).message}`)
    }
  }

  private schedule(): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const now = this.ops.now()
    const armed = this.store.armed()
    // Nothing armed: still look (and prune) now and then.
    let next = Math.max(now, this.lastFullCheck + (armed.length ? RECHECK_MS : PRUNE_MS))
    for (const wait of armed) {
      next = Math.min(next, wait.deadline, this.recheckAt.get(wait.id) ?? Number.POSITIVE_INFINITY)
    }
    for (const id of this.recheckAt.keys())
      if (!armed.some((wait) => wait.id === id)) this.recheckAt.delete(id)
    this.timer = setTimeout(() => this.check(), Math.max(0, next - now) + 50)
    this.timer.unref?.()
  }

  /** A waiter's armed waits, then the ones over in the last day. */
  list(waiter: string, recent: boolean): Wait[] {
    return this.store.forWaiter(waiter, recent ? this.ops.now() - RECENT_MS : undefined)
  }

  /** End with keepWakes: the session's armed waits outlive it. */
  keep(waiter: string, ended: EndedSession): number {
    return this.store.keep(waiter, ended)
  }

  unkeep(waiter: string): void {
    this.store.unkeep(waiter)
  }
}

function where(wait: Pick<Wait, 'kind' | 'ref' | 'host'>): string {
  return `${wait.kind}=${wait.host ? `${wait.host}/${wait.ref}` : wait.ref}`
}

// --- routes ------------------------------------------------------------------------------

function only(body: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key))
  if (unknown.length) throw new HttpError(400, 'invalid_body', { fields: unknown })
}

function optionalSession(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !SESSION_ID.test(value))
    throw new HttpError(400, 'invalid_body', { field })
  return value
}

/** A note as stored: one line, at most 200 characters; null when left out. */
function waitNote(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new HttpError(400, 'invalid_body', { field: 'note' })
  const note = value.replace(/[\r\n\t]+/g, ' ').trim()
  if (!note || Array.from(note).length > NOTE_MAX_CHARS || /[\p{Cc}\p{Cs}]/u.test(note))
    throw new HttpError(400, 'invalid_body', { field: 'note' })
  return note
}

function waitKind(value: unknown): WaitKind {
  if (!(WAIT_KINDS as readonly unknown[]).includes(value))
    throw new HttpError(400, 'invalid_body', { field: 'kind', kinds: WAIT_KINDS })
  return value as WaitKind
}

function waitRef(kind: WaitKind, value: unknown): string {
  const ok =
    typeof value === 'string' &&
    (isPullKind(kind)
      ? PULL_REFS[kind].test(value)
      : SESSION_ID.test(value) || REQUEST_ID.test(value))
  if (!ok) throw new HttpError(400, 'invalid_body', { field: 'ref' })
  return value as string
}

const ARGV_MAX_ITEMS = 64
const ARGV_MAX_ITEM_CHARS = 4096
const ARGV_MAX_TOTAL_CHARS = 16_384

/** A `cmd` wait's body: `argv` (no ref) and an absolute `cwd`. Whether the
 * directory or program exists is the unit's to find: a missing directory ends
 * it `failed (exit 200)`, a program not on the user manager's PATH fails to
 * start (`could not start`). */
function cmdBody(body: Record<string, unknown>): { argv: string[]; cwd: string } {
  if (body.ref !== undefined && body.ref !== null)
    throw new HttpError(400, 'invalid_body', { field: 'ref' })
  const argv = body.argv
  if (
    !Array.isArray(argv) ||
    !argv.length ||
    argv.length > ARGV_MAX_ITEMS ||
    !argv.every(
      (part) =>
        typeof part === 'string' && part.length <= ARGV_MAX_ITEM_CHARS && !part.includes('\0'),
    ) ||
    !(argv[0] as string).length ||
    argv.reduce((total: number, part: string) => total + part.length, 0) > ARGV_MAX_TOTAL_CHARS
  )
    throw new HttpError(400, 'invalid_body', { field: 'argv' })
  const cwd = body.cwd
  if (
    typeof cwd !== 'string' ||
    !cwd.startsWith('/') ||
    cwd.length > ARGV_MAX_ITEM_CHARS ||
    /[\0\n\r]/.test(cwd)
  )
    throw new HttpError(400, 'invalid_body', { field: 'cwd' })
  return { argv: argv as string[], cwd }
}

function untilsOf(kind: WaitKind): readonly string[] {
  return isPullKind(kind) ? PULL_UNTILS[kind] : SESSION_UNTILS
}

/**
 * `POST /v1/waits`, `POST /v1/waits/check`, `GET /v1/waits/:id[?wait=N]`,
 * `DELETE /v1/waits/:id` and `GET /v1/sessions/:id/waits[?recent=1]`
 * (docs/api-v1.md "Waits").
 */
export function registerWaitRoutes(
  router: Router,
  service: () => WaitService | null,
  exists: (id: string) => boolean,
): void {
  const current = (): WaitService => {
    const waits = service()
    if (!waits) throw new HttpError(409, 'waits_unavailable')
    return waits
  }
  const requireWait = (waits: WaitService, id: string | undefined): Wait => {
    const wait = id && WAIT_ID.test(id) ? waits.store.get(id) : undefined
    if (!wait) throw new HttpError(404, 'not_found')
    return wait
  }
  router
    .add('POST', '/v1/waits', async (req, res) => {
      const body = await readJsonObject(req)
      only(body, [
        'waiter',
        'by',
        'kind',
        'ref',
        'until',
        'since',
        'timeoutMinutes',
        'key',
        'note',
        'thread',
        'argv',
        'cwd',
      ])
      const waiter = optionalSession(body.waiter, 'waiter')
      const by = optionalSession(body.by, 'by')
      const kind = waitKind(body.kind)
      // A `cmd` wait sends what to run instead of a ref; other kinds take no argv.
      const cmd = kind === 'cmd' ? cmdBody(body) : null
      if (kind !== 'cmd' && (body.argv !== undefined || body.cwd !== undefined))
        throw new HttpError(400, 'invalid_body', {
          field: body.argv !== undefined ? 'argv' : 'cwd',
        })
      const ref = cmd ? '' : waitRef(kind, body.ref)
      const untils = untilsOf(kind)
      const until = body.until ?? untils[0]
      if (!untils.includes(until as string))
        throw new HttpError(400, 'invalid_body', { field: 'until', untils })
      let since: number | null = null
      if (body.since !== undefined && body.since !== null) {
        if (!Number.isSafeInteger(body.since) || (body.since as number) < 0)
          throw new HttpError(400, 'invalid_body', { field: 'since' })
        since = body.since as number
      }
      let timeoutMinutes: number | null = null
      if (body.timeoutMinutes !== undefined && body.timeoutMinutes !== null) {
        if (!Number.isSafeInteger(body.timeoutMinutes) || (body.timeoutMinutes as number) < 1)
          throw new HttpError(400, 'invalid_body', { field: 'timeoutMinutes' })
        timeoutMinutes = body.timeoutMinutes as number
      }
      let key: string | null = null
      if (body.key !== undefined && body.key !== null) {
        if (typeof body.key !== 'string' || !KEY.test(body.key))
          throw new HttpError(400, 'invalid_body', { field: 'key' })
        key = body.key
      }
      let thread: string | null = null
      if (body.thread !== undefined && body.thread !== null) {
        if (typeof body.thread !== 'string' || !THREAD.test(body.thread))
          throw new HttpError(400, 'invalid_body', { field: 'thread' })
        thread = body.thread
      }
      const note = waitNote(body.note)
      if (waiter !== null && !exists(waiter))
        throw new HttpError(404, 'not_found', { field: 'waiter' })
      const waits = current()
      try {
        const { wait, created } = await waits.arm({
          waiter,
          by,
          kind,
          ref,
          until: until as string,
          since,
          timeoutMinutes,
          key,
          note,
          thread,
          cmd,
        })
        sendJson(res, created ? 201 : 200, { ...waitJson(wait), created })
      } catch (error) {
        if (error instanceof WaitRefused)
          throw new HttpError(error.status, error.code, error.detail)
        throw error
      }
    })
    .add('POST', '/v1/waits/check', async (req, res) => {
      // A nudge: re-read now. A hint only; it carries no outcome or text.
      const body = await readJsonObject(req)
      only(body, ['kind', 'ref'])
      const kind = waitKind(body.kind)
      const ref = body.ref === undefined || body.ref === null ? undefined : waitRef(kind, body.ref)
      sendJson(res, 200, { kind, ref: ref ?? null, armed: current().nudge(kind, ref) })
    })
    .add('GET', '/v1/waits/:waitId', async (_req, res, params, query) => {
      const waits = current()
      requireWait(waits, params.waitId)
      const raw = query.get('wait')
      let seconds = 0
      if (raw !== null) {
        seconds = Number(raw)
        if (!Number.isInteger(seconds) || seconds < 0 || seconds > LONG_POLL_MAX_SECONDS)
          throw new HttpError(400, 'invalid_query', { field: 'wait', max: LONG_POLL_MAX_SECONDS })
      }
      const abort = new AbortController()
      const onClose = () => abort.abort()
      res.on('close', onClose)
      try {
        const wait = await waits.waitFor(params.waitId as string, seconds * 1000, abort.signal)
        if (!wait) throw new HttpError(404, 'not_found')
        if (!res.destroyed) sendJson(res, 200, waitJson(wait))
      } finally {
        res.off('close', onClose)
      }
    })
    .add('DELETE', '/v1/waits/:waitId', (_req, res, params) => {
      const waits = current()
      requireWait(waits, params.waitId)
      const { cancelled, wait } = waits.cancel(params.waitId as string)
      if (!wait) throw new HttpError(404, 'not_found')
      if (!cancelled) throw new HttpError(409, 'not_armed', { state: wait.state })
      sendJson(res, 200, { cancelled: true, ...waitJson(wait) })
    })
    .add('GET', '/v1/sessions/:id/waits', (_req, res, params, query) => {
      const id = params.id
      if (!id || !SESSION_ID.test(id) || !exists(id)) throw new HttpError(404, 'not_found')
      const waits = current()
      const recent = query.get('recent') === '1'
      sendJson(res, 200, {
        items: waits.list(id, recent).map(waitJson),
      })
    })
}
