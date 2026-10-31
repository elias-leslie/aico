// Lane reports (docs/api-v1.md "Lane reports"). A lane launched with
// `st aico create` tells whoever launched it, with no subscription and no
// scheduled check-in, when it finishes a turn, is blocked on the user, or ends:
//
// - `finished` goes to the lane's launcher (`parentId`: the root coordinator
//   for an ordinary lane, the lane for a helper it started; the root when the
//   launcher can't take it); `blocked` and `ended` go to the root coordinator
//   (`coordinatorId`) and to the launcher when that is another session.
// - Receivers are worked out when the report fires, from the lane's current
//   lineage, and must be agent sessions on this computer that Tether can
//   deliver to (Claude Code, Codex, Pi, Agent Hub). Only lineage from a launch
//   counts (`launched`), never an owner's mark or join; nothing from before
//   the deploy is reported. `st aico watch` adds an explicit watch and
//   `st aico unwatch` an exception.
// - Finished is the agent's own clock, not Tether's edges: idle with a
//   `stateAgentAt` later than the last report, held `laneSettleSeconds`. It
//   catches turns too short for the poll and turns during a Tether restart,
//   and the persisted cursor never repeats one. A lane that waits on a
//   check-in of its own is not finished; a new generation (recovery, respawn,
//   reboot restore) resets the cursor quietly; at most one finished per lane
//   per `laneFinishedFloorSeconds`, later ones folding into it.
// - Blocked fires for a permission prompt or a question held
//   `laneBlockedSeconds`, never for `dialog open`.
// - Ended comes from the sessions delete trigger (lane_outbox, written in the
//   delete's own transaction), or from an agent that left its pane for good
//   (a clean exit, or crash recovery holds). It is terminal. A remote lane's
//   ended comes from the hub's relay, which drops ids it never had.
//
// Each report is one event line queued on the receiver's delivery queue
// (wakes, kind `event`): pasted once the agent is idle, nobody is typing and
// the input line is empty, or sent as an Agent Hub follow-up turn.

import type { DatabaseSync } from 'node:sqlite'
import { AGENT_STATES, type AgentState } from './agent-state'
import { HttpError, type Router, readJsonObject, sendJson } from './http'

export type LaneOutcome = 'finished' | 'blocked' | 'ended'

/** Blocked details that report `blocked`. `dialog open` (the owner opening
 * `/model` in the lane) does not. */
export const BLOCKING_DETAILS: ReadonlySet<string> = new Set(['permission prompt', 'input needed'])

const SESSION_ID = /^[0-9a-f]{8}$/
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/
const HOST_NAME = /^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/
/** Control and format characters (the asks checker, asks.ts). */
const ONE_LINE_BAD = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/gu
const TITLE_MAX_CHARS = 60

/** What the reporter reads from a session descriptor (local or relayed). */
export interface LaneView {
  id: string
  /** null on this computer; the peer's name for a relayed session. */
  host: string | null
  generation: string
  state: AgentState
  stateAt: number
  stateDetail: string | null
  stateAgentAt: number
  statePrevious: AgentState
  createdAt: number
  coordinatorId: string | null
  parentId: string | null
  launched: boolean
  title: string
  requestId: string | null
  waitingOn: string | null
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** A descriptor as a lane view, or null when it is not one. */
export function laneView(session: unknown, host: string | null): LaneView | null {
  if (!session || typeof session !== 'object') return null
  const s = session as Record<string, unknown>
  const id = str(s.id)
  const generation = str(s.generation)
  if (!id || !SESSION_ID.test(id) || !generation) return null
  const stateOf = (value: unknown): AgentState =>
    (AGENT_STATES as readonly unknown[]).includes(value) ? (value as AgentState) : 'unknown'
  const state = stateOf(s.state)
  const coordinatorId = str(s.coordinatorId)
  const parentId = str(s.parentId)
  return {
    id,
    host,
    generation,
    state,
    stateAt: num(s.stateAt),
    stateDetail: str(s.stateDetail),
    stateAgentAt: num(s.stateAgentAt),
    statePrevious: stateOf(s.statePrevious),
    createdAt: num(s.createdAt),
    coordinatorId: coordinatorId && SESSION_ID.test(coordinatorId) ? coordinatorId : null,
    parentId: parentId && SESSION_ID.test(parentId) ? parentId : null,
    launched: s.launched === true,
    title: str(s.displayTitle) ?? str(s.label) ?? id,
    requestId: str(s.rootRequestId),
    waitingOn: str(s.waitingOn),
  }
}

// --- the text ---------------------------------------------------------------------

/** A title safe inside a pasted line: no control, bidi or zero-width
 * characters, no brackets, quotes or backticks, no leading `/` or `!`, at most
 * 60 characters. */
export function laneTitle(raw: string, max = TITLE_MAX_CHARS): string {
  let title = raw
    .replace(ONE_LINE_BAD, ' ')
    .replace(/[[\]"`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  title = title.replace(/^[/!\s]+/, '')
  const chars = Array.from(title)
  if (chars.length > max) title = `${chars.slice(0, max - 1).join('')}…`
  return title || 'untitled'
}

/** What a report's line names: never agent reply text. */
export interface LaneSnapshot {
  id: string
  host: string | null
  title: string
  requestId: string | null
  coordinatorId: string | null
  parentId: string | null
  launched: boolean
}

/** The one line a receiver gets. Built from typed values only. */
export function laneLine(
  outcome: LaneOutcome,
  lane: LaneSnapshot,
  extra: { minutes?: number | null; detail?: string | null; exited?: boolean } = {},
): string {
  const what =
    outcome === 'finished'
      ? `finished${extra.minutes && extra.minutes >= 1 ? ` after ${extra.minutes}m` : ''}`
      : outcome === 'blocked'
        ? `is blocked: ${extra.detail && BLOCKING_DETAILS.has(extra.detail) ? extra.detail : 'waiting on input'}`
        : `ended${extra.exited ? ' (its agent exited)' : ''}`
  const { name, look } = lineNames(lane)
  return `[Ready] lane ${name} ${what} · ${look}`
}

/** A session as a line names it (its quoted title, host and request) and the
 * command to look at it with. */
export function lineNames(lane: {
  id: string
  host: string | null
  title: string
  requestId: string | null
}): { name: string; look: string } {
  const host = lane.host && HOST_NAME.test(lane.host) ? ` on ${lane.host}` : ''
  const request = lane.requestId && REQUEST_ID.test(lane.requestId) ? lane.requestId : null
  return {
    name: `"${laneTitle(lane.title)}"${host}${request ? ` (req ${request})` : ''}`,
    look: request
      ? `st aico root status ${request}`
      : `st aico widget status --widget-id ${lane.id}`,
  }
}

// --- the store ------------------------------------------------------------------------

export interface LaneCursor {
  host: string
  lane: string
  generation: string | null
  /** The agent's own time of the last finished turn reported or absorbed. */
  finishedAt: number
  /** When the last finished line was queued (the rate floor). */
  finishedSentAt: number
  /** The `stateAt` of the last blocked episode reported. */
  blockedAt: number
  /** The first idle after a new generation is absorbed, not reported. */
  reset: boolean
  ended: boolean
  title: string | null
  requestId: string | null
  coordinatorId: string | null
  parentId: string | null
  launched: boolean
}

interface RawCursor {
  host: string
  lane: string
  generation: string | null
  finished_at: number
  finished_sent_at: number
  blocked_at: number
  reset: number
  ended: number
  title: string | null
  request_id: string | null
  coordinator_id: string | null
  parent_id: string | null
  launched: number
}

function toCursor(raw: RawCursor): LaneCursor {
  return {
    host: raw.host,
    lane: raw.lane,
    generation: raw.generation,
    finishedAt: raw.finished_at,
    finishedSentAt: raw.finished_sent_at,
    blockedAt: raw.blocked_at,
    reset: raw.reset === 1,
    ended: raw.ended === 1,
    title: raw.title,
    requestId: raw.request_id,
    coordinatorId: raw.coordinator_id,
    parentId: raw.parent_id,
    launched: raw.launched === 1,
  }
}

export type WatchMode = 'watch' | 'unwatch'

export interface LaneWatch {
  watcher: string
  lane: string
  mode: WatchMode
  createdAt: number
}

export interface OutboxRow {
  id: number
  lane: string
  at: number
  coordinatorId: string | null
  parentId: string | null
  launched: boolean
  title: string | null
  requestId: string | null
}

/** lane_reports, lane_watches and lane_outbox (schema v18). One daemon writes them. */
export class LaneReportStore {
  private depth = 0

  constructor(private readonly db: DatabaseSync) {}

  transaction<T>(work: () => T): T {
    if (this.depth > 0) return work()
    this.db.exec('BEGIN IMMEDIATE')
    this.depth += 1
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    } finally {
      this.depth -= 1
    }
  }

  get(host: string, lane: string): LaneCursor | undefined {
    const raw = this.db
      .prepare('SELECT * FROM lane_reports WHERE host = ? AND lane = ?')
      .get(host, lane) as RawCursor | undefined
    return raw ? toCursor(raw) : undefined
  }

  cursors(): LaneCursor[] {
    return (this.db.prepare('SELECT * FROM lane_reports').all() as unknown as RawCursor[]).map(
      toCursor,
    )
  }

  save(cursor: LaneCursor, now: number): void {
    this.db
      .prepare(
        `INSERT INTO lane_reports (host, lane, generation, finished_at, finished_sent_at, blocked_at,
           reset, ended, title, request_id, coordinator_id, parent_id, launched, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (host, lane) DO UPDATE SET generation = excluded.generation,
           finished_at = excluded.finished_at, finished_sent_at = excluded.finished_sent_at,
           blocked_at = excluded.blocked_at, reset = excluded.reset, ended = excluded.ended,
           title = excluded.title, request_id = excluded.request_id,
           coordinator_id = excluded.coordinator_id, parent_id = excluded.parent_id,
           launched = excluded.launched, updated_at = excluded.updated_at`,
      )
      .run(
        cursor.host,
        cursor.lane,
        cursor.generation,
        cursor.finishedAt,
        cursor.finishedSentAt,
        cursor.blockedAt,
        cursor.reset ? 1 : 0,
        cursor.ended ? 1 : 0,
        cursor.title,
        cursor.requestId,
        cursor.coordinatorId,
        cursor.parentId,
        cursor.launched ? 1 : 0,
        now,
      )
  }

  /** A lane that ended: its cursor and the watches on it go. */
  forget(host: string, lane: string): void {
    this.db.prepare('DELETE FROM lane_reports WHERE host = ? AND lane = ?').run(host, lane)
    this.db.prepare('DELETE FROM lane_watches WHERE lane = ?').run(lane)
  }

  watches(): LaneWatch[] {
    return (
      this.db.prepare('SELECT * FROM lane_watches ORDER BY created_at').all() as {
        watcher: string
        lane: string
        mode: WatchMode
        created_at: number
      }[]
    ).map((row) => ({
      watcher: row.watcher,
      lane: row.lane,
      mode: row.mode,
      createdAt: row.created_at,
    }))
  }

  setWatch(watcher: string, lane: string, mode: WatchMode | null, now: number): void {
    if (mode === null)
      this.db.prepare('DELETE FROM lane_watches WHERE watcher = ? AND lane = ?').run(watcher, lane)
    else
      this.db
        .prepare(
          `INSERT INTO lane_watches (watcher, lane, mode, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (watcher, lane) DO UPDATE SET mode = excluded.mode, created_at = excluded.created_at`,
        )
        .run(watcher, lane, mode, now)
  }

  outbox(): OutboxRow[] {
    return (
      this.db.prepare('SELECT * FROM lane_outbox ORDER BY id').all() as {
        id: number
        lane: string
        at: number
        coordinator_id: string | null
        parent_id: string | null
        launched: number
        title: string | null
        request_id: string | null
      }[]
    ).map((row) => ({
      id: row.id,
      lane: row.lane,
      at: row.at,
      coordinatorId: row.coordinator_id,
      parentId: row.parent_id,
      launched: row.launched === 1,
      title: row.title,
      requestId: row.request_id,
    }))
  }

  takeOutbox(id: number): void {
    this.db.prepare('DELETE FROM lane_outbox WHERE id = ?').run(id)
  }

  /** Cursors of local sessions that ended without an `ended` to send (a lane
   * that stopped being reported, such as one an owner marked coordinator). */
  pruneLocal(): void {
    this.db
      .prepare(
        `DELETE FROM lane_reports WHERE host = ''
           AND lane NOT IN (SELECT id FROM sessions) AND lane NOT IN (SELECT lane FROM lane_outbox)`,
      )
      .run()
  }
}

// --- the reporter ------------------------------------------------------------------------

export interface LaneReportPolicy {
  laneSettleSeconds: number
  laneBlockedSeconds: number
  laneFinishedFloorSeconds: number
}

/** A local session's lineage, for receivers and watch cycles. */
export interface LocalLineage {
  id: string
  coordinatorId: string | null
  parentId: string | null
  launched: boolean
}

export interface LaneReportOperations {
  now(): number
  policy(): LaneReportPolicy
  /** A session on this computer that can take lane reports: an agent Tether
   * delivers to (Claude Code, Codex, Pi, agy, Agent Hub), not a shell. */
  receiver(id: string): boolean
  /** Local sessions' lineage (watch cycles, lineage receivers). */
  sessions(): LocalLineage[]
  /** Queue one line on the receiver's delivery queue (coalescing by source). */
  deliver(receiver: string, source: string, line: string): void
  /** A local lane's agent has left its pane for good: a clean exit, or crash
   * recovery holds it. */
  agentGone(id: string): boolean
  log(message: string): void
}

interface Memory {
  view: LaneView
  /** The observation the settle and blocked timers measure from. */
  key: string
  seenAt: number
  /** When this turn was first seen working (for "finished after Nm"). */
  workingSeenAt: number | null
  /** A state other than unknown was seen (in this generation or before). */
  known: boolean
  timer: NodeJS.Timeout | null
}

export class WatchRefused extends Error {
  constructor(readonly code: 'self_watch' | 'watch_cycle') {
    super(code)
  }
}

function memoryKey(host: string | null, id: string): string {
  return `${host ?? ''}/${id}`
}

function snapshotOf(view: LaneView): LaneSnapshot {
  return {
    id: view.id,
    host: view.host,
    title: view.title,
    requestId: view.requestId,
    coordinatorId: view.coordinatorId,
    parentId: view.parentId,
    launched: view.launched,
  }
}

function cursorSnapshot(cursor: LaneCursor): LaneSnapshot {
  return {
    id: cursor.lane,
    host: cursor.host || null,
    title: cursor.title ?? cursor.lane,
    requestId: cursor.requestId,
    coordinatorId: cursor.coordinatorId,
    parentId: cursor.parentId,
    launched: cursor.launched,
  }
}

export class LaneReporter {
  private readonly memory = new Map<string, Memory>()
  /** Lanes with an explicit watch (any host). */
  private watched = new Set<string>()
  private stopped = false
  /** Lanes created after this saw their whole life here. */
  private readonly startedAt: number

  constructor(
    readonly store: LaneReportStore,
    private readonly ops: LaneReportOperations,
  ) {
    this.startedAt = ops.now()
    this.refreshWatched()
  }

  stop(): void {
    this.stopped = true
    for (const memory of this.memory.values()) if (memory.timer) clearTimeout(memory.timer)
    this.memory.clear()
  }

  private refreshWatched(): void {
    this.watched = new Set(
      this.store
        .watches()
        .filter((watch) => watch.mode === 'watch')
        .map((watch) => watch.lane),
    )
  }

  /** A session descriptor arrived (created or updated, local or relayed). */
  observe(view: LaneView): void {
    if (this.stopped) return
    const key = memoryKey(view.host, view.id)
    const reportable = (view.launched && view.coordinatorId !== null) || this.watched.has(view.id)
    if (!reportable) {
      this.drop(key)
      return
    }
    const now = this.ops.now()
    const host = view.host ?? ''
    let cursor = this.store.get(host, view.id)
    let dirty = false
    if (cursor?.ended) {
      // Its agent left (exit or held recovery), and has come back in the same
      // session (`tether recovery resume`): report it again from here on.
      if (view.state === 'unknown' || (view.host === null && this.ops.agentGone(view.id))) return
      cursor.ended = false
      cursor.reset = true
      dirty = true
    }
    if (!cursor) {
      // A lane launched while Tether runs: every turn counts, its first
      // included, even one that ended before the poll found the agent. One
      // seen for the first time otherwise (at startup): its idle is absorbed.
      const fresh = view.createdAt >= this.startedAt
      cursor = {
        host,
        lane: view.id,
        generation: view.generation,
        finishedAt: fresh ? view.createdAt : 0,
        finishedSentAt: 0,
        blockedAt: 0,
        reset: !fresh,
        ended: false,
        title: null,
        requestId: null,
        coordinatorId: null,
        parentId: null,
        launched: false,
      }
      dirty = true
    }
    const stateKey = `${view.state}|${view.stateDetail ?? ''}|${view.stateAgentAt}|${view.stateAt}`
    let memory = this.memory.get(key)
    const before = memory?.view ?? null
    if (cursor.generation !== view.generation) {
      // Recovery, respawn or reboot restore: quietly, never "finished". A
      // launch's own generation changes (before any agent state) are not one.
      cursor.generation = view.generation
      if (!memory || memory.known) cursor.reset = true
      dirty = true
    }
    const snapshot = snapshotOf(view)
    if (
      cursor.title !== snapshot.title ||
      cursor.requestId !== snapshot.requestId ||
      cursor.coordinatorId !== snapshot.coordinatorId ||
      cursor.parentId !== snapshot.parentId ||
      cursor.launched !== snapshot.launched
    ) {
      cursor.title = snapshot.title
      cursor.requestId = snapshot.requestId
      cursor.coordinatorId = snapshot.coordinatorId
      cursor.parentId = snapshot.parentId
      cursor.launched = snapshot.launched
      dirty = true
    }
    if (!memory) {
      memory = { view, key: stateKey, seenAt: now, workingSeenAt: null, known: false, timer: null }
      this.memory.set(key, memory)
    } else if (memory.key !== stateKey) {
      memory.key = stateKey
      memory.seenAt = now
    }
    memory.view = view
    if (view.state !== 'unknown') memory.known = true
    const blocking =
      view.state === 'blocked' &&
      view.stateDetail !== null &&
      BLOCKING_DETAILS.has(view.stateDetail)
    if (view.state === 'working' || blocking) {
      // The agent is in a turn: the next idle is a real one.
      if (cursor.reset) {
        cursor.reset = false
        dirty = true
      }
      memory.workingSeenAt ??= now
    }
    if ((view.state === 'working' || view.state === 'idle') && cursor.blockedAt !== 0) {
      // The reported blocked episode is over; the next one is new.
      cursor.blockedAt = 0
      dirty = true
    }
    if (
      blocking &&
      view.statePrevious === 'unknown' &&
      cursor.blockedAt > 0 &&
      view.stateAt > cursor.blockedAt
    ) {
      // Still the episode reported before Tether (or the lane's host) restarted.
      cursor.blockedAt = view.stateAt
      dirty = true
    }
    if (
      view.state === 'idle' &&
      before?.state === 'blocked' &&
      !(before.stateDetail !== null && BLOCKING_DETAILS.has(before.stateDetail)) &&
      memory.workingSeenAt === null &&
      view.stateAgentAt > cursor.finishedAt
    ) {
      // A dialog the owner opened and closed (`/model`), not a turn.
      cursor.finishedAt = view.stateAgentAt
      dirty = true
    }
    if (dirty) this.store.save(cursor, now)
    this.evaluate(key)
  }

  private drop(key: string): void {
    const memory = this.memory.get(key)
    if (memory?.timer) clearTimeout(memory.timer)
    this.memory.delete(key)
  }

  private evaluate(key: string): void {
    const memory = this.memory.get(key)
    if (!memory || this.stopped) return
    if (memory.timer) clearTimeout(memory.timer)
    memory.timer = null
    const view = memory.view
    const host = view.host ?? ''
    const cursor = this.store.get(host, view.id)
    if (!cursor || cursor.ended) return
    const now = this.ops.now()
    const policy = this.ops.policy()
    const held = now - memory.seenAt
    let wait: number | null = null
    if (view.state === 'idle' && view.stateAgentAt > cursor.finishedAt) {
      if (cursor.reset || view.waitingOn) {
        // Came up idle after a restart, or waits on something of its own.
        cursor.finishedAt = view.stateAgentAt
        cursor.reset = false
        this.store.save(cursor, now)
        memory.workingSeenAt = null
        return
      }
      const settle = policy.laneSettleSeconds * 1000 - held
      const floor = cursor.finishedSentAt
        ? policy.laneFinishedFloorSeconds * 1000 - (now - cursor.finishedSentAt)
        : 0
      const remaining = Math.max(settle, floor)
      if (remaining > 0) wait = remaining
      else {
        const minutes =
          memory.workingSeenAt !== null
            ? Math.floor((memory.seenAt - memory.workingSeenAt) / 60_000)
            : null
        this.store.transaction(() => {
          this.fire('finished', snapshotOf(view), { minutes })
          cursor.finishedAt = view.stateAgentAt
          cursor.finishedSentAt = now
          this.store.save(cursor, now)
        })
        memory.workingSeenAt = null
      }
    } else if (
      view.state === 'blocked' &&
      view.stateDetail !== null &&
      BLOCKING_DETAILS.has(view.stateDetail) &&
      view.stateAt > cursor.blockedAt
    ) {
      const remaining = policy.laneBlockedSeconds * 1000 - held
      if (remaining > 0) wait = remaining
      else
        this.store.transaction(() => {
          this.fire('blocked', snapshotOf(view), { detail: view.stateDetail })
          cursor.blockedAt = view.stateAt
          this.store.save(cursor, now)
        })
    } else if (view.state === 'unknown' && view.host === null && this.ops.agentGone(view.id)) {
      // Left to the shell and crash recovery won't bring it back.
      const remaining = policy.laneSettleSeconds * 1000 - held
      if (remaining > 0) wait = remaining
      else
        this.store.transaction(() => {
          this.fire('ended', snapshotOf(view), { exited: true })
          cursor.ended = true
          this.store.save(cursor, now)
        })
    }
    if (wait !== null) {
      memory.timer = setTimeout(() => this.evaluate(key), wait)
      memory.timer.unref?.()
    }
  }

  /** The sessions that get this report now, from the lane's current lineage. */
  receivers(outcome: LaneOutcome, lane: LaneSnapshot): string[] {
    const out = new Set<string>()
    if (lane.launched && lane.coordinatorId) {
      const root = lane.coordinatorId
      const parent = lane.parentId ?? root
      if (outcome === 'finished') {
        // The root stands in for a launcher here that can't take it; a
        // launcher on the lane's own host hears it from that host's Tether.
        if (this.ops.receiver(parent)) out.add(parent)
        else if (lane.host === null || this.ops.sessions().some((s) => s.id === parent))
          out.add(root)
      } else {
        out.add(root)
        out.add(parent)
      }
    }
    const unwatched = new Set<string>()
    for (const watch of this.store.watches()) {
      if (watch.lane !== lane.id) continue
      if (watch.mode === 'watch') out.add(watch.watcher)
      else unwatched.add(watch.watcher)
    }
    return [...out].filter((id) => id !== lane.id && !unwatched.has(id) && this.ops.receiver(id))
  }

  private fire(
    outcome: LaneOutcome,
    lane: LaneSnapshot,
    extra: Parameters<typeof laneLine>[2] = {},
  ): void {
    const receivers = this.receivers(outcome, lane)
    const where = lane.host ? `${lane.host}/${lane.id}` : lane.id
    if (!receivers.length) {
      this.ops.log(`lane=${where} ${outcome}: no receiver`)
      return
    }
    const line = laneLine(outcome, lane, extra)
    for (const receiver of receivers) this.ops.deliver(receiver, `lane:${where}:${outcome}`, line)
    this.ops.log(`lane=${where} ${outcome} -> ${receivers.join(',')}`)
  }

  /** Ended lanes the delete trigger recorded on this computer. */
  drainOutbox(): void {
    if (this.stopped) return
    for (const row of this.store.outbox()) {
      this.store.transaction(() => {
        const cursor = this.store.get('', row.lane)
        if (!cursor?.ended)
          this.fire('ended', {
            id: row.lane,
            host: null,
            title: row.title ?? cursor?.title ?? row.lane,
            requestId: row.requestId ?? cursor?.requestId ?? null,
            coordinatorId: row.coordinatorId,
            parentId: row.parentId,
            launched: row.launched,
          })
        this.store.forget('', row.lane)
        this.store.takeOutbox(row.id)
      })
      this.drop(memoryKey(null, row.lane))
    }
    this.store.pruneLocal()
    this.refreshWatched()
  }

  /** A relayed lane ended on its host (the hub relays each id once). */
  ended(id: string, host: string): void {
    if (this.stopped) return
    const cursor = this.store.get(host, id)
    if (!cursor) return
    this.store.transaction(() => {
      if (!cursor.ended) this.fire('ended', cursorSnapshot(cursor))
      this.store.forget(host, id)
    })
    this.drop(memoryKey(host, id))
    this.refreshWatched()
  }

  // --- watch / unwatch ---------------------------------------------------------

  /** Whether `watcher` gets this lane's reports through lineage: all of them
   * (it is the launcher), or `some` (blocked and ended, as its root). */
  private lineageReceiver(watcher: string, lane: string, some: boolean): boolean {
    const local = this.ops.sessions().find((session) => session.id === lane)
    const lineages: { coordinatorId: string | null; parentId: string | null; launched: boolean }[] =
      local ? [local] : this.store.cursors().filter((cursor) => cursor.lane === lane)
    return lineages.some(
      (item) =>
        item.launched &&
        item.coordinatorId !== null &&
        ((item.parentId ?? item.coordinatorId) === watcher ||
          (some && item.coordinatorId === watcher)),
    )
  }

  /** Who each lane reports to (lineage and explicit watches). */
  private edges(): Map<string, Set<string>> {
    const edges = new Map<string, Set<string>>()
    const add = (from: string, to: string | null) => {
      if (!to || from === to) return
      let set = edges.get(from)
      if (!set) {
        set = new Set()
        edges.set(from, set)
      }
      set.add(to)
    }
    for (const item of [...this.ops.sessions(), ...this.store.cursors().map(cursorSnapshot)])
      if (item.launched && item.coordinatorId) {
        add(item.id, item.coordinatorId)
        add(item.id, item.parentId)
      }
    for (const watch of this.store.watches())
      if (watch.mode === 'watch') add(watch.lane, watch.watcher)
    return edges
  }

  /** `st aico watch` / `st aico unwatch`. Returns how the watcher hears the
   * lane now: `lineage`, `watch` or `none`. */
  setWatch(watcher: string, lane: string, mode: WatchMode): 'lineage' | 'watch' | 'none' {
    if (watcher === lane) throw new WatchRefused('self_watch')
    const now = this.ops.now()
    const lineage = this.lineageReceiver(watcher, lane, mode === 'unwatch')
    if (mode === 'watch') {
      if (lineage) {
        this.store.setWatch(watcher, lane, null, now)
        this.refreshWatched()
        return 'lineage'
      }
      // The new edge lane -> watcher closes a cycle when watcher reaches lane.
      const edges = this.edges()
      const seen = new Set<string>()
      const stack = [watcher]
      while (stack.length) {
        const at = stack.pop() as string
        if (at === lane) throw new WatchRefused('watch_cycle')
        if (seen.has(at)) continue
        seen.add(at)
        for (const next of edges.get(at) ?? []) stack.push(next)
      }
      this.store.setWatch(watcher, lane, 'watch', now)
      this.refreshWatched()
      return 'watch'
    }
    this.store.setWatch(watcher, lane, lineage ? 'unwatch' : null, now)
    this.refreshWatched()
    return 'none'
  }

  watchesOf(watcher: string): LaneWatch[] {
    return this.store.watches().filter((watch) => watch.watcher === watcher)
  }
}

// --- routes ------------------------------------------------------------------------------

/** `GET/POST /v1/sessions/:id/watches` (docs/api-v1.md "Lane reports"). `:id`
 * is the watcher (the caller's own session). */
export function registerLaneRoutes(
  router: Router,
  reporter: () => LaneReporter | null,
  exists: (id: string) => boolean,
): void {
  const watcherOf = (id: string | undefined): string => {
    if (!id || !SESSION_ID.test(id) || !exists(id)) throw new HttpError(404, 'not_found')
    return id
  }
  const json = (watch: LaneWatch) => ({
    lane: watch.lane,
    mode: watch.mode,
    createdAt: watch.createdAt,
  })
  router
    .add('GET', '/v1/sessions/:id/watches', (_req, res, params) => {
      const watcher = watcherOf(params.id)
      sendJson(res, 200, { items: reporter()?.watchesOf(watcher).map(json) ?? [] })
    })
    .add('POST', '/v1/sessions/:id/watches', async (req, res, params) => {
      const body = await readJsonObject(req)
      const unknown = Object.keys(body).filter((key) => key !== 'lane' && key !== 'mode')
      if (unknown.length) throw new HttpError(400, 'invalid_body', { fields: unknown })
      const watcher = watcherOf(params.id)
      if (typeof body.lane !== 'string' || !SESSION_ID.test(body.lane))
        throw new HttpError(400, 'invalid_body', { field: 'lane' })
      if (body.mode !== 'watch' && body.mode !== 'unwatch')
        throw new HttpError(400, 'invalid_body', { field: 'mode' })
      const current = reporter()
      if (!current) throw new HttpError(409, 'lane_reports_unavailable')
      try {
        const hears = current.setWatch(watcher, body.lane, body.mode)
        sendJson(res, 200, { watcher, lane: body.lane, mode: body.mode, hears })
      } catch (error) {
        if (error instanceof WatchRefused) throw new HttpError(409, error.code)
        throw error
      }
    })
}
