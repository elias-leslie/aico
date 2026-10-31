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
//
// P1b has one kind, `session`: another session (here or relayed from a host)
// finished a turn since `since`, is idle, is blocked on a prompt, or ended.
// Lines are built from typed values only: never agent reply text.

import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { HttpError, type Router, readJsonObject, sendJson } from './http'
import { BLOCKING_DETAILS, type LaneView, laneTitle, lineNames } from './lane-reports'
import type { EndedSession, WakePolicy } from './wakes'

export const WAIT_KINDS = ['session'] as const
export type WaitKind = (typeof WAIT_KINDS)[number]
export const SESSION_UNTILS = ['finished', 'idle', 'blocked', 'ended'] as const
export type SessionUntil = (typeof SESSION_UNTILS)[number]
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
  kind: WaitKind
  ref: string
  /** null on this computer; the peer's name for a relayed session. */
  host: string | null
  until: SessionUntil
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
    kind: raw.kind as WaitKind,
    ref: raw.ref,
    host: raw.host || null,
    until: raw.until as SessionUntil,
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
export function waitJson(wait: Wait): Record<string, unknown> {
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

  /** The wait a waiter's key names (armed or over, not cancelled). */
  byKey(waiter: string | null, key: string): Wait | undefined {
    const raw = this.db
      .prepare(
        "SELECT * FROM waits WHERE coalesce(waiter, '') = ? AND key = ? AND state <> 'cancelled'",
      )
      .get(waiter ?? '', key) as RawWait | undefined
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

  insert(wait: Omit<Wait, 'id' | 'seq' | 'state' | 'outcome' | 'line' | 'firedAt'>): Wait {
    const id = this.random()
    this.db
      .prepare(
        `INSERT INTO waits (id, waiter, kind, ref, host, until, since, deadline, key, note, armed_at,
           cursor, kept, ended_session)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        wait.waiter,
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
          `UPDATE waits SET seq = seq + 1, state = ?, outcome = ?, line = ?, fired_at = ?
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

  /** Mark a session's armed waits to outlive its End. Returns how many. */
  keep(waiter: string, ended: EndedSession): number {
    return Number(
      this.db
        .prepare(
          "UPDATE waits SET kept = 1, ended_session = ? WHERE waiter = ? AND state = 'armed'",
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

/** The agent's own time of the state (Tether's observation where it gives none). */
function agentAt(view: LaneView): number {
  return view.stateAgentAt || view.stateAt
}

/**
 * Whether a session wait's condition holds now: `until`, `gone` (the target
 * ended before it held), or null with when to look again (a state that has
 * not held long enough yet). `target` null means no such session any more;
 * `exited` that its agent left its pane for good.
 */
export function sessionVerdict(
  wait: Pick<Wait, 'until' | 'since'>,
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
    // A turn that ended after `since`, and the agent waits on nothing of its own.
    if (target.state === 'idle' && agentAt(target) > wait.since && !target.waitingOn)
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
  finished: { ready: 'finished', not: 'not finished', gone: 'ended before it finished' },
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
  const { name, look } = lineNames({
    id: wait.ref,
    host: wait.host,
    title: cursor?.title ?? wait.ref,
    requestId: cursor?.requestId ?? null,
  })
  const words = UNTIL_WORDS[wait.until]
  const detail =
    cursor?.detail && BLOCKING_DETAILS.has(cursor.detail) ? cursor.detail : 'waiting on input'
  let head: string
  if (outcome === 'until')
    head = `[Ready] session ${name} ${wait.until === 'blocked' ? `is blocked: ${detail}` : words.ready}`
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
  until: SessionUntil
  since: number | null
  timeoutMinutes: number | null
  key: string | null
  note: string | null
  thread: string | null
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
    if (this.stopped) return
    if (id === undefined) this.pendingAll = true
    else {
      this.pending ??= new Set()
      this.pending.add(id)
    }
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
      const existing = this.store.byKey(input.waiter, input.key)
      if (existing) return { wait: existing, created: false }
    }
    const target = this.ops.resolve(input.ref)
    if (!target) throw new WaitRefused(404, 'not_found', { field: 'ref' })
    if (target.host === null && (target.id === input.waiter || target.id === input.by))
      throw new WaitRefused(409, 'self_wait')
    if (input.waiter !== null && this.store.countArmed(input.waiter) >= policy.maxWaitsPerSession)
      throw new WaitRefused(409, 'too_many_waits', { max: policy.maxWaitsPerSession })
    if (input.timeoutMinutes !== null && input.timeoutMinutes > policy.waitMaxMinutes)
      throw new WaitRefused(400, 'invalid_body', {
        field: 'timeoutMinutes',
        max: policy.waitMaxMinutes,
      })
    const view = this.ops.view(target.id, target.host)
    if (!view) throw new WaitRefused(404, 'not_found', { field: 'ref' })
    const by = input.by ?? input.waiter
    let since = input.since
    if (since === null && by !== null && target.host === null)
      since = this.store.lastSend(by, target.id)
    // The launcher's prompt is its first send.
    if (since === null && by !== null && view.parentId === by && view.launched)
      since = view.createdAt
    const wait = this.store.insert({
      waiter: input.waiter,
      kind: input.kind,
      ref: target.id,
      host: target.host,
      until: input.until,
      since: since ?? now,
      deadline: now + (input.timeoutMinutes ?? policy.waitDefaultMinutes) * 60_000,
      key: input.key,
      note: input.note,
      armedAt: now,
      cursor: cursorOf(view),
      kept: false,
      endedSession: null,
    })
    this.ops.log(
      `armed wait=${wait.id} by ${wait.waiter ?? 'a blocking client'} on session=${where(wait)} until ${wait.until}`,
    )
    this.evaluate(wait)
    this.ops.changed(wait.waiter)
    this.schedule()
    return { wait: this.store.get(wait.id) as Wait, created: true }
  }

  /** Cancel an armed wait: quiet, no line. False when it was not armed. */
  cancel(id: string): { cancelled: boolean; wait: Wait | undefined } {
    const wait = this.store.get(id)
    if (wait?.state !== 'armed') return { cancelled: false, wait }
    const cancelled = this.store.settle(wait, 'cancelled', null, null, this.ops.now())
    if (cancelled) {
      this.ops.log(`cancelled wait=${id}`)
      this.notify(id)
      this.ops.changed(wait.waiter)
    }
    return { cancelled, wait: this.store.get(id) }
  }

  /** The wait once it is no longer armed, or as it is after `ms`. */
  async waitFor(id: string, ms: number, aborted?: AbortSignal): Promise<Wait | undefined> {
    const now = this.store.get(id)
    if (now?.state !== 'armed' || ms <= 0 || this.stopped) return now
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
    return this.store.get(id)
  }

  private notify(id: string): void {
    const set = this.listeners.get(id)
    if (!set) return
    for (const listener of [...set]) listener()
  }

  /** Look at armed waits (all, or those on these sessions), fire the ready
   * ones, prune old ones and set the next timer. */
  check(ids?: ReadonlySet<string>): void {
    if (this.stopped) return
    const now = this.ops.now()
    for (const wait of this.store.armed()) {
      if (ids && !ids.has(wait.ref) && wait.deadline > now) continue
      try {
        this.evaluate(wait)
      } catch (error) {
        this.ops.log(`wait=${wait.id} check failed: ${(error as Error).message}`)
      }
    }
    if (!ids) this.store.prune(now - this.ops.policy().waitKeepDays * 24 * 3600_000)
    this.schedule()
  }

  /** When each armed wait next needs a look: the settle time of a state not
   * held long enough yet. */
  private readonly recheckAt = new Map<string, number>()

  private evaluate(wait: Wait): void {
    const now = this.ops.now()
    const policy = this.ops.policy()
    this.recheckAt.delete(wait.id)
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

  private fire(wait: Wait, outcome: WaitOutcome, now: number): void {
    const line = waitLine(wait, outcome, now)
    const fired = this.store.transaction(() => {
      if (
        !this.store.settle(wait, outcome === 'timeout' ? 'timed_out' : 'fired', outcome, line, now)
      )
        return false
      if (wait.waiter) this.ops.deliver(wait.waiter, `wait:${wait.id}`, line)
      else if (wait.kept && wait.endedSession && outcome === 'until')
        this.ops.relaunch(wait.endedSession, line)
      return true
    })
    if (!fired) return
    this.recheckAt.delete(wait.id)
    const to =
      wait.waiter ?? (wait.kept ? `kept (${wait.endedSession?.id ?? '?'})` : 'a blocking client')
    this.ops.log(`wait=${wait.id} on session=${where(wait)} ${outcome} -> ${to}`)
    this.notify(wait.id)
    this.ops.changed(wait.waiter)
  }

  private schedule(): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const now = this.ops.now()
    let next = now + RECHECK_MS
    const armed = this.store.armed()
    if (!armed.length) return
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

function where(wait: Pick<Wait, 'ref' | 'host'>): string {
  return wait.host ? `${wait.host}/${wait.ref}` : wait.ref
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

/**
 * `POST /v1/waits`, `GET /v1/waits/:id[?wait=N]`, `DELETE /v1/waits/:id` and
 * `GET /v1/sessions/:id/waits[?recent=1]` (docs/api-v1.md "Waits").
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
      ])
      const waiter = optionalSession(body.waiter, 'waiter')
      const by = optionalSession(body.by, 'by')
      if (!(WAIT_KINDS as readonly unknown[]).includes(body.kind))
        throw new HttpError(400, 'invalid_body', { field: 'kind', kinds: WAIT_KINDS })
      if (typeof body.ref !== 'string' || !(SESSION_ID.test(body.ref) || REQUEST_ID.test(body.ref)))
        throw new HttpError(400, 'invalid_body', { field: 'ref' })
      const until = body.until ?? 'finished'
      if (!(SESSION_UNTILS as readonly unknown[]).includes(until))
        throw new HttpError(400, 'invalid_body', { field: 'until', untils: SESSION_UNTILS })
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
          kind: body.kind as WaitKind,
          ref: body.ref,
          until: until as SessionUntil,
          since,
          timeoutMinutes,
          key,
          note,
          thread,
        })
        sendJson(res, created ? 201 : 200, { ...waitJson(wait), created })
      } catch (error) {
        if (error instanceof WaitRefused)
          throw new HttpError(error.status, error.code, error.detail)
        throw error
      }
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
