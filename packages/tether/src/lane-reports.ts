// Lane reports (docs/api-v1.md "Lane reports"). A lane launched with
// `st aico create` tells whoever launched it, with no subscription and no
// scheduled check-in, when it finishes a turn, is blocked on the user, or ends:
//
// - Every line (`finished`, `blocked`, `ended`) goes to the lane's launcher
//   (`parentId`: the root coordinator for an ordinary lane, the lane for a
//   helper it started). The root (`coordinatorId`) gets it only when it is
//   the launcher, or stands in when the launcher is gone: ended, its agent
//   exited, or a session that can't take lines. A launcher on a remote lane's
//   own host hears it from that host's Tether. A receiver with a session wait
//   of its own on the lane that fires on this event (as its waiter, or the
//   session a `--block` client armed it from) hears it from the wait: no line
//   for it, and nobody stands in. Only a wait that fired on this event counts
//   (at or after this Tether first saw the state), and a `--block` client
//   only while it is there.
// - Receivers are worked out when the report fires, from the lane's current
//   lineage, and must be agent sessions on this computer that Tether can
//   deliver to (Claude Code, Codex, Pi). Only lineage from a launch
//   counts (`launched`), never an owner's mark or join; nothing from before
//   the deploy is reported. `st aico watch` adds an explicit watch and
//   `st aico unwatch` an exception.
// - Finished is the agent's own clock, not Tether's edges: idle with a
//   `stateAgentAt` later than the last report, held `laneSettleSeconds`, and no
//   background shells of its own still running. Those hold the line: their end
//   starts its next turn. Past `laneBackgroundHoldSeconds` the line goes out
//   saying they still run (a dev server left behind must not hide a finished
//   lane), and it does not count as a repeat. It
//   catches turns too short for the poll and turns during a Tether restart,
//   and the persisted cursor never repeats one. A lane that waits on a
//   check-in of its own is not finished; a new generation (recovery, respawn,
//   reboot restore) resets the cursor quietly; at most one finished per lane
//   per `laneFinishedFloorSeconds`, later ones folding into it. A repeat
//   (no send or wait from its receiver on the lane since the last line) needs
//   the lane quiet, idle with no turn, `laneRepeatQuietSeconds`, doubling per
//   repeat up to `laneRepeatQuietMaxSeconds`: a lane waiting on its own work
//   with short turns in between stays quiet, one that stalls is heard within
//   the cap. A send or wait from the receiver, a new generation, blocked or
//   ended starts over at the normal floor. Once that quiet has passed the line
//   wakes its receiver: a coordinator with nothing else to do would otherwise
//   never learn the lane is done.
// - Blocked fires for a permission prompt or a question held
//   `laneBlockedSeconds`, never for `dialog open`.
// - Ended comes from the sessions delete trigger (lane_outbox, written in the
//   delete's own transaction), or from an agent that left its pane for good
//   (a clean exit, or crash recovery holds). It is terminal. A remote lane's
//   ended comes from the hub's relay, which drops ids it never had. The
//   session that asked for the End (`endedBy`, recorded in the outbox row)
//   gets no line for it, nor does the root when that session is the lane's
//   launcher; an explicit watcher and everyone else do. Without `endedBy` all do.
//   A remote lane's asker comes from the End the hub forwarded there (the
//   `Tether-Ended-By` header, `remoteEnd`).
//   Those spared sessions also lose the lane's lines still queued for them
//   (went idle, blocked, an exit's ended): they ended it, so the lines are
//   stale. A line already delivered (or going out now) stays.
//   The ender itself also cancels its armed session waits on the lane and
//   withdraws its queued wait lines; those report the same handled work. A
//   root spared only because its helper ended the lane keeps its own wait.
//
// - A finished line the receiver does not need is dropped: the lane told
//   that receiver with a request (`st sessions send`; never an ack, which may
//   open a turn of work) during the turn that just ended, so it heard from the
//   lane already (the explicit message carries the report path).
// - A finished line carries the lane's last message, cleaned and cut to
//   `laneClosingMaxChars`, so the coordinator needn't go and read the lane.
//
// Each report is one event line queued on the receiver's delivery queue
// (wakes, kind `event`): pasted once the agent is idle, nobody is typing and
// the input line is empty.

import { AGENT_STATES, type AgentState } from '@aico/session-engine/agent-state'
import type { Db } from '@aico/session-engine/store'
import { BACKGROUND_SHELLS } from '@aico/session-engine/tui/adapters/contract'
import { HttpError, onlyFields, type Router, readJsonObject, sendJson } from '@aico/shared/http'
import { type ModelSwitch, modelSwitchOf, modelSwitchText } from './model-switch'

const LANE_OUTCOMES = ['finished', 'blocked', 'ended'] as const
export type LaneOutcome = (typeof LANE_OUTCOMES)[number]

/** Blocked details that report `blocked`. `dialog open` (the owner opening
 * `/model` in the lane) does not. */
export const BLOCKING_DETAILS: ReadonlySet<string> = new Set([
  'permission prompt',
  'input needed',
  'startup dialog',
])

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
  /** The agent tool (`claude-code`, `codex`, `pi`). */
  tool: string | null
  /** The standing model switch (src/model-switch.ts). */
  modelSwitch: ModelSwitch | null
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
    tool: str(s.tool),
    modelSwitch: modelSwitchOf(s.modelSwitch),
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

/** What a report's line names. The only agent reply text a line carries is a finished lane's
 * last message (`closingWords`). */
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
  extra: {
    minutes?: number | null
    detail?: string | null
    exited?: boolean
    /** Its background shells still run (the hold ran out). */
    shells?: boolean
    /** Its last message, already cleaned (`closingWords`). */
    closing?: string | null
  } = {},
): string {
  const after = extra.minutes && extra.minutes >= 1 ? ` after ${extra.minutes}m` : ''
  const what =
    outcome === 'finished'
      ? extra.shells
        ? `went idle${after}; background shells still running`
        : `finished its turn${after}`
      : outcome === 'blocked'
        ? `is blocked: ${extra.detail && BLOCKING_DETAILS.has(extra.detail) ? extra.detail : 'waiting on input'}`
        : extra.exited
          ? 'has no running agent; the session is still open'
          : 'ended'
  const { name, look, report } = lineNames(lane)
  if (outcome === 'finished' && extra.closing)
    return `[Ready] lane ${name} ${what} · ${report} · says: ${extra.closing}`
  return `[Ready] lane ${name} ${what} · ${look}`
}

/** An agent's last message as a line carries it: one line, no control or direction marks, at
 * most `max` characters. Last in the line, so a delivery cut loses only its tail. */
export function closingWords(text: string | null | undefined, max: number): string | null {
  if (!text || max <= 0) return null
  const flat = text
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]+/g, ' ')
    // A lone surrogate is refused by the paste and would block the receiver's queue.
    .replace(/\p{Cs}/gu, '')
    .replace(/ {2,}/g, ' ')
    .trim()
  if (!flat) return null
  const chars = [...flat]
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : flat
}

/** The one line a model switch gets (src/model-switch.ts). */
function modelLine(lane: LaneSnapshot, change: ModelSwitch, tool: string | null): string {
  const { name } = lineNames(lane)
  const request = lane.requestId && REQUEST_ID.test(lane.requestId) ? lane.requestId : null
  const { tag, what, tail } = modelSwitchText(change, tool, request)
  return `${tag} lane ${name} ${what} · ${tail}`
}

/** A session as a line names it (its quoted title, host and request) and the
 * command to look at it with. */
export function lineNames(lane: {
  id: string
  host: string | null
  title: string
  requestId: string | null
}): { name: string; look: string; report: string } {
  const host = lane.host && HOST_NAME.test(lane.host) ? ` on ${lane.host}` : ''
  const request = lane.requestId && REQUEST_ID.test(lane.requestId) ? lane.requestId : null
  return {
    name: `"${laneTitle(lane.title)}"${host}${request ? ` (req ${request})` : ''}`,
    look: request
      ? `st aico root status ${request}`
      : `st aico widget status --widget-id ${lane.id}`,
    report: request
      ? `st aico root report ${request}`
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
  /** Went-idle lines sent since the receiver last acted on the lane,
   * something reached the lane (`LaneReporter.reached`), the generation
   * changed, or it was blocked or ended (schema v25). */
  finishedStreak: number
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
  /** The last model switch told (schema v26). */
  modelKey: string | null
  /** Something reached the lane while this idle (`stateAgentAt`) was still
   * unreported (its line held): that idle's line goes with
   * `streakBeforeReach`, and the idle after it is a first line. Kept across a
   * restart (schema v29). */
  reachedAfter: number | null
  streakBeforeReach: number
}

interface RawCursor {
  host: string
  lane: string
  generation: string | null
  finished_at: number
  finished_sent_at: number
  finished_streak: number
  blocked_at: number
  reset: number
  ended: number
  title: string | null
  request_id: string | null
  coordinator_id: string | null
  parent_id: string | null
  launched: number
  model_key: string | null
  reached_after?: number | null
  streak_before_reach?: number | null
}

function toCursor(raw: RawCursor): LaneCursor {
  return {
    host: raw.host,
    lane: raw.lane,
    generation: raw.generation,
    finishedAt: raw.finished_at,
    finishedSentAt: raw.finished_sent_at,
    finishedStreak: raw.finished_streak,
    blockedAt: raw.blocked_at,
    reset: raw.reset === 1,
    ended: raw.ended === 1,
    title: raw.title,
    requestId: raw.request_id,
    coordinatorId: raw.coordinator_id,
    parentId: raw.parent_id,
    launched: raw.launched === 1,
    modelKey: raw.model_key ?? null,
    reachedAfter: raw.reached_after ?? null,
    streakBeforeReach: raw.streak_before_reach ?? 0,
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
  /** The session whose End deleted the lane (schema v24); null when unknown. */
  endedBy: string | null
}

/** lane_reports, lane_watches and lane_outbox (schema v18), and
 * session_end_requests (v24). One daemon writes them. */
export class LaneReportStore {
  private depth = 0

  constructor(private readonly db: Db) {}

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
        `INSERT INTO lane_reports (host, lane, generation, finished_at, finished_sent_at,
           finished_streak, blocked_at, reset, ended, title, request_id, coordinator_id, parent_id,
           launched, model_key, reached_after, streak_before_reach, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (host, lane) DO UPDATE SET generation = excluded.generation,
           finished_at = excluded.finished_at, finished_sent_at = excluded.finished_sent_at,
           finished_streak = excluded.finished_streak,
           blocked_at = excluded.blocked_at, reset = excluded.reset, ended = excluded.ended,
           title = excluded.title, request_id = excluded.request_id,
           coordinator_id = excluded.coordinator_id, parent_id = excluded.parent_id,
           launched = excluded.launched, model_key = excluded.model_key,
           reached_after = excluded.reached_after,
           streak_before_reach = excluded.streak_before_reach,
           updated_at = excluded.updated_at`,
      )
      .run(
        cursor.host,
        cursor.lane,
        cursor.generation,
        cursor.finishedAt,
        cursor.finishedSentAt,
        cursor.finishedStreak,
        cursor.blockedAt,
        cursor.reset ? 1 : 0,
        cursor.ended ? 1 : 0,
        cursor.title,
        cursor.requestId,
        cursor.coordinatorId,
        cursor.parentId,
        cursor.launched ? 1 : 0,
        cursor.modelKey,
        cursor.reachedAfter,
        cursor.streakBeforeReach,
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
        ended_by?: string | null
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
      endedBy: row.ended_by && SESSION_ID.test(row.ended_by) ? row.ended_by : null,
    }))
  }

  /** An End that `endedBy` asked for is about to run on `session`. Returns
   * false (nothing written) when another End's mark is already there. */
  markEnd(session: string, endedBy: string, now: number): boolean {
    return (
      this.db
        .prepare(
          `INSERT INTO session_end_requests (session_id, ended_by, at) VALUES (?, ?, ?)
           ON CONFLICT (session_id) DO NOTHING`,
        )
        .run(session, endedBy, now).changes === 1
    )
  }

  /** The End answered (the delete trigger already copied the mark if it ran). */
  unmarkEnd(session: string): void {
    this.db.prepare('DELETE FROM session_end_requests WHERE session_id = ?').run(session)
  }

  /** Marks from Ends a crash interrupted. */
  clearEndMarks(): void {
    this.db.prepare('DELETE FROM session_end_requests').run()
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
  laneRepeatQuietSeconds: number
  laneRepeatQuietMaxSeconds: number
  laneBackgroundHoldSeconds: number
  laneClosingMaxChars: number
}

/** A local session's lineage, for receivers and watch cycles. */
export interface LocalLineage {
  id: string
  coordinatorId: string | null
  parentId: string | null
  launched: boolean
}

export interface LaneReportOperations {
  /** A confirmed process exit, including a failed exit; distinct from clean completion suppression. */
  childGone?(id: string): boolean
  now(): number
  policy(): LaneReportPolicy
  /** A session on this computer that can take lane reports: an agent Tether
   * delivers to (Claude Code, Codex, Pi, agy), not a shell. */
  receiver(id: string): boolean
  /** Local sessions' lineage (watch cycles, lineage receivers). */
  sessions(): LocalLineage[]
  /** Queue one line on the receiver's delivery queue (coalescing by source).
   */
  /** `repeat`: a line the receiver may have ignored already. It wakes, but it is no news from
   * outside: the receiver's own next finished line stays a repeat, so backoff holds up a chain. */
  deliver(receiver: string, source: string, line: string, repeat?: boolean): void
  /** A local lane's last message, as it wrote it; null when none can be read. */
  closing?(lane: string): string | null
  /** Whether the lane (a session here) told `receiver` with a wake-class
   * message at or after `since` (src/wake-runtime.ts `toldSince`). */
  told?(lane: string, receiver: string, since: number): boolean
  /** Take back the receiver's still-queued line from this source (the queue's
   * withdraw: a row going out right now is not stopped). Returns rows taken. */
  withdraw(receiver: string, source: string): number
  /** An End's informed receivers no longer need waits on this session. */
  handled(lane: string, host: string | null, receivers: readonly string[]): void
  /** Whether one of `by` sent to this lane (`inject` with `from`) or armed a
   * wait on it after `since`: it acted on the lane, so its next finished line
   * is no repeat. */
  acted(lane: string, host: string | null, by: readonly string[], since: number): boolean
  /** A local lane's agent has left its pane for good: a clean exit, or crash
   * recovery holds it. */
  agentGone(id: string): boolean
  /** The host a session lives on when it is a live session there (relayed
   * by the hub), else null. */
  elsewhere(id: string): string | null
  /** Which of `receivers` hear this event from a session wait of their own on
   * the lane (src/waits.ts `heardFrom`). */
  heardFrom(
    lane: string,
    host: string | null,
    receivers: readonly string[],
    event: LaneEvent,
  ): Set<string>
  /** A lane's model switch had no receiver (the owner's notice takes it). */
  unheard?(lane: string): void
  /** The lane went idle waiting on something of its own (no finished line):
   * its still-queued ride-along replies to `receivers` become wakes. Returns
   * the receivers whose line did. */
  promoteReplies?(lane: string, receivers: readonly string[]): string[]
  log(message: string): void
}

/** The event a line reports, for the waits that may already cover it: when
 * this Tether first saw the lane's current state (`at`, its own clock, less
 * SAME_EVENT_SLACK_MS) and the agent's own time of it (`agentAt`). A wait
 * that fired before `at` fired on something earlier. */
export interface LaneEvent {
  outcome: LaneOutcome
  at: number
  agentAt: number
}

interface Memory {
  view: LaneView
  /** The observation the settle and blocked timers measure from. */
  key: string
  seenAt: number
  /** When this turn was first seen working (for "finished after Nm"). */
  workingSeenAt: number | null
  /** The idle (`stateAgentAt`) that ended the previous turn while its line
   * was still held: this turn began after it, whatever was said before. */
  heldIdleAt: number
  /** A state other than unknown was seen (in this generation or before). */
  known: boolean
  timer: NodeJS.Timeout | null
  /** The idle (`stateAgentAt`) whose backoff hold was logged. */
  holdLogged: number
}

export class WatchRefused extends Error {
  constructor(readonly code: 'self_watch' | 'watch_cycle') {
    super(code)
  }
}

function memoryKey(host: string | null, id: string): string {
  return `${host ?? ''}/${id}`
}

function laneWhere(lane: { id: string; host: string | null }): string {
  return lane.host ? `${lane.host}/${lane.id}` : lane.id
}

/** How long a finished line must hold idle after `streak` lines with no
 * act from the receiver: none extra for the first, then the quiet doubling
 * per repeat up to its cap. */
function repeatQuietMs(
  policy: Pick<LaneReportPolicy, 'laneRepeatQuietSeconds' | 'laneRepeatQuietMaxSeconds'>,
  streak: number,
): number {
  if (streak < 1 || policy.laneRepeatQuietSeconds <= 0) return 0
  const cap = Math.max(policy.laneRepeatQuietSeconds, policy.laneRepeatQuietMaxSeconds)
  return Math.min(policy.laneRepeatQuietSeconds * 2 ** Math.min(streak - 1, 20), cap) * 1000
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

/** How long a forwarded End's asker is kept for the relayed `ended`. */
const REMOTE_END_MS = 10 * 60_000

/** A message sent as the turn began may reach Tether before it saw the lane work. */
const TURN_SLACK_MS = 3000

/** A wait may fire on the same observation a moment before the reporter
 * sees it (another subscriber of the same event). */
const SAME_EVENT_SLACK_MS = 1000

/** An end, after the lane's last state seen here (0: none seen since start). */
function endedEvent(memory: Memory | undefined): LaneEvent {
  return {
    outcome: 'ended',
    at: memory ? memory.seenAt - SAME_EVENT_SLACK_MS : 0,
    agentAt: memory?.view.stateAgentAt ?? 0,
  }
}

export class LaneReporter {
  children(): {
    id: string
    parent: string
    host: string | null
    title: string
    state: 'live' | 'vanished' | 'unknown'
  }[] {
    const local = new Map(this.ops.sessions().map((s) => [s.id, s]))
    const known = new Map(
      this.store
        .cursors()
        .filter((c) => c.launched && !c.ended && c.coordinatorId)
        .map((c) => [
          `${c.host ?? ''}/${c.lane}`,
          {
            id: c.lane,
            parent: c.parentId ?? (c.coordinatorId as string),
            host: c.host || null,
            title: c.title ?? c.lane,
          },
        ]),
    )
    for (const s of local.values())
      if (s.launched && s.coordinatorId)
        known.set(`/${s.id}`, {
          id: s.id,
          parent: s.parentId ?? s.coordinatorId,
          host: null,
          title: this.memory.get(memoryKey(null, s.id))?.view.title ?? s.id,
        })
    return [...known.values()].map((c) => ({
      ...c,
      state: c.host
        ? 'unknown'
        : !local.has(c.id) || (this.ops.childGone ?? this.ops.agentGone)?.(c.id)
          ? 'vanished'
          : 'live',
    }))
  }
  private readonly memory = new Map<string, Memory>()
  /** Lanes with an explicit watch (any host). */
  private watched = new Set<string>()
  /** Ends this hub forwarded to another host, by `host/id`: who asked, when. */
  private readonly remoteEnds = new Map<string, { by: string; at: number }>()
  private stopped = false
  /** Lanes created after this saw their whole life here. */
  private readonly startedAt: number

  constructor(
    readonly store: LaneReportStore,
    private readonly ops: LaneReportOperations,
  ) {
    this.startedAt = ops.now()
    // No End is running yet: a mark left here was a crash's.
    store.clearEndMarks()
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

  /**
   * Something reached this local lane: a line pasted into it or taken by it
   * (not a check-in or wait line it set itself), a send typed into it, or its
   * own reply to a message. Its next finished line is a first line (a wake),
   * never a ride-along repeat: what reached it may be work whose end its
   * receivers still need to hear. Counted when the lane got it, not when it
   * was sent: a request sent before the lane's last finished line but pasted
   * after it must still wake.
   */
  reached(lane: string, why: string): void {
    if (this.stopped) return
    const cursor = this.store.get('', lane)
    if (!cursor || cursor.ended) return
    const memory = this.memory.get(memoryKey(null, lane))
    let marked = false
    if (memory?.view.state === 'idle' && memory.view.stateAgentAt > cursor.finishedAt) {
      // An idle not reported yet (its line held) came before this. Should its
      // line still go before the new turn is seen (a restart in between
      // included), it goes as it would have and must not use up the reset:
      // the end of the work this starts would then be the repeat.
      if (cursor.reachedAfter !== memory.view.stateAgentAt) {
        cursor.streakBeforeReach = cursor.finishedStreak
        cursor.reachedAfter = memory.view.stateAgentAt
        marked = true
      }
    }
    if (cursor.finishedStreak === 0 && !marked) return
    cursor.finishedStreak = 0
    this.store.save(cursor, this.ops.now())
    this.ops.log(`lane=${lane} ${why}: its next finished line is a first line`)
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
      cursor.finishedStreak = 0
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
        finishedStreak: 0,
        blockedAt: 0,
        reset: !fresh,
        ended: false,
        title: null,
        requestId: null,
        coordinatorId: null,
        parentId: null,
        launched: false,
        modelKey: null,
        reachedAfter: null,
        streakBeforeReach: 0,
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
      cursor.finishedStreak = 0
      dirty = true
    }
    const snapshot = snapshotOf(view)
    if (cursor.coordinatorId !== snapshot.coordinatorId || cursor.parentId !== snapshot.parentId) {
      // An in-place transfer keeps the event cursor, but an undelivered line
      // must not wake a former coordinator. Explicit watches still count.
      const current = new Set(this.receivers(snapshot))
      for (const receiver of this.receivers(cursorSnapshot(cursor))) {
        if (current.has(receiver)) continue
        for (const outcome of [...LANE_OUTCOMES, 'model'])
          this.ops.withdraw(receiver, `lane:${laneWhere(snapshot)}:${outcome}`)
      }
    }
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
      memory = {
        view,
        key: stateKey,
        seenAt: now,
        workingSeenAt: null,
        heldIdleAt: 0,
        known: false,
        timer: null,
        holdLogged: 0,
      }
      this.memory.set(key, memory)
    }
    // How long the previous observation (an idle, say) held.
    const lastHeld = now - memory.seenAt
    if (memory.key !== stateKey) {
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
      if (
        before?.state === 'idle' &&
        before.stateAgentAt > cursor.finishedAt &&
        before.stateAgentAt > memory.heldIdleAt
      ) {
        // A new turn began while the last idle's line was held (settle, floor
        // or quiet): a message sent before that idle never hides this turn's
        // idle (when in doubt, wake). The turn's length starts over only when
        // that idle had settled: a shorter one is not a finish.
        memory.heldIdleAt = before.stateAgentAt
        if (lastHeld >= this.ops.policy().laneSettleSeconds * 1000) memory.workingSeenAt = now
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
    const change = view.modelSwitch
    if (change?.checked && change.key !== cursor.modelKey) {
      // Each switch once, when its worktree has been looked at.
      const told = cursor
      this.store.transaction(() => {
        this.fireModel(snapshot, change, view.tool)
        told.modelKey = change.key
        this.store.save(told, now)
      })
      dirty = false
    }
    if (dirty) this.store.save(cursor, now)
    this.evaluate(key)
  }

  /** A model switch goes to the lane's launcher, the root in its place, and its watchers. */
  private fireModel(lane: LaneSnapshot, change: ModelSwitch, tool: string | null): void {
    const where = laneWhere(lane)
    const receivers = this.receivers(lane)
    if (!receivers.length) {
      this.ops.log(`lane=${where} model ${change.kind}: no receiver, the owner is told`)
      this.ops.unheard?.(lane.id)
      return
    }
    const line = modelLine(lane, change, tool)
    for (const receiver of receivers) this.ops.deliver(receiver, `lane:${where}:model`, line)
    this.ops.log(`lane=${where} model ${change.kind} -> ${receivers.join(',')}`)
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
        memory.heldIdleAt = 0
        if (view.waitingOn) {
          // No finished line carries a ride-along reply it sent this turn (a
          // noted yes to its launcher): that reply wakes its receiver now,
          // not when the lane's own wait fires.
          const promoted =
            this.ops.promoteReplies?.(view.id, this.receivers(snapshotOf(view))) ?? []
          if (promoted.length)
            this.ops.log(
              `lane=${laneWhere(view)} idle on its own wait: its ride-along reply wakes ${promoted.join(',')}`,
            )
        }
        return
      }
      // An idle from before something reached the lane (its line still held)
      // keeps the streak it had then; the next idle is the first line.
      const beforeReach = cursor.reachedAfter !== null && view.stateAgentAt <= cursor.reachedAfter
      if (!beforeReach && cursor.reachedAfter !== null) {
        cursor.reachedAfter = null
        cursor.streakBeforeReach = 0
        this.store.save(cursor, now)
      }
      let streak = beforeReach ? cursor.streakBeforeReach : cursor.finishedStreak
      if (
        streak > 0 &&
        this.ops.acted(view.id, view.host, this.receivers(snapshotOf(view)), cursor.finishedSentAt)
      ) {
        // Its receiver sent to the lane or armed a wait on it: no repeat.
        streak = 0
        if (cursor.finishedStreak > 0) {
          cursor.finishedStreak = 0
          this.store.save(cursor, now)
        }
      }
      const quiet = repeatQuietMs(policy, streak)
      // Not finished while its own background shells run; past the hold, it says they do.
      const shells = view.stateDetail === BACKGROUND_SHELLS
      const hold = shells ? policy.laneBackgroundHoldSeconds * 1000 : 0
      // The hold runs on the agent's own clock, so a Tether restart doesn't start it over.
      const heldShells = view.stateAgentAt > 0 ? Math.max(now - view.stateAgentAt, held) : held
      const settle = Math.max(
        Math.max(policy.laneSettleSeconds * 1000, quiet) - held,
        hold - heldShells,
      )
      const floor = cursor.finishedSentAt
        ? policy.laneFinishedFloorSeconds * 1000 - (now - cursor.finishedSentAt)
        : 0
      const remaining = Math.max(settle, floor)
      if (remaining > 0) {
        wait = remaining
        if ((quiet > 0 || hold > 0) && memory.holdLogged !== view.stateAgentAt) {
          memory.holdLogged = view.stateAgentAt
          this.ops.log(
            hold > 0
              ? `lane=${laneWhere(view)} idle with background shells running: held up to ${Math.round(hold / 1000)}s`
              : `lane=${laneWhere(view)} idle again: repeat ${streak} goes out after ${Math.round(quiet / 1000)}s quiet`,
          )
        }
      } else {
        const minutes =
          memory.workingSeenAt !== null
            ? Math.floor((memory.seenAt - memory.workingSeenAt) / 60_000)
            : null
        // The turn that just ended began when it was first seen working (a
        // message sent as it began may reach Tether a moment before that),
        // never before the previous idle (reported, or held when this turn
        // began): a turn too short to see began after it. A message from an
        // earlier turn never hides this one's idle.
        const afterLastIdle = Math.max(cursor.finishedAt, memory.heldIdleAt) + 1
        const toldSince =
          memory.workingSeenAt !== null
            ? Math.max(memory.workingSeenAt - TURN_SLACK_MS, afterLastIdle)
            : afterLastIdle
        this.store.transaction(() => {
          const told = this.fire(
            {
              outcome: 'finished',
              at: memory.seenAt - SAME_EVENT_SLACK_MS,
              agentAt: view.stateAgentAt,
            },
            snapshotOf(view),
            {
              minutes,
              shells,
              closing:
                view.host === null
                  ? closingWords(this.ops.closing?.(view.id), policy.laneClosingMaxChars)
                  : null,
            },
            null,
            { toldSince, repeat: streak > 0 },
          )
          cursor.finishedAt = view.stateAgentAt
          // A turn the lane reported itself is no finished line sent: it
          // neither starts the floor nor counts toward the repeat backoff.
          // A line for an idle from before something reached the lane leaves
          // the streak at 0: the idle after it is still a first line, as is
          // the turn after a line that said its background shells still run.
          if (!told) {
            cursor.finishedSentAt = now
            if (!beforeReach && !shells) cursor.finishedStreak += 1
          }
          this.store.save(cursor, now)
        })
        memory.workingSeenAt = null
        memory.heldIdleAt = 0
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
          this.fire(
            {
              outcome: 'blocked',
              at: memory.seenAt - SAME_EVENT_SLACK_MS,
              agentAt: view.stateAgentAt,
            },
            snapshotOf(view),
            { detail: view.stateDetail },
          )
          cursor.blockedAt = view.stateAt
          cursor.finishedStreak = 0
          this.store.save(cursor, now)
        })
    } else if (view.state === 'unknown' && view.host === null && this.ops.agentGone(view.id)) {
      // Left to the shell and crash recovery won't bring it back.
      const remaining = policy.laneSettleSeconds * 1000 - held
      if (remaining > 0) wait = remaining
      else
        this.store.transaction(() => {
          this.fire(endedEvent(memory), snapshotOf(view), { exited: true })
          cursor.ended = true
          cursor.finishedStreak = 0
          this.store.save(cursor, now)
        })
    }
    if (wait !== null) {
      memory.timer = setTimeout(() => this.evaluate(key), wait)
      memory.timer.unref?.()
    }
  }

  /** The sessions that get a report now, from the lane's current lineage:
   * its launcher, or the root standing in for a launcher that is gone. */
  receivers(lane: LaneSnapshot): string[] {
    const out = new Set<string>()
    if (lane.launched && lane.coordinatorId) {
      const root = lane.coordinatorId
      const launcher = lane.parentId ?? root
      if (this.ops.receiver(launcher) && !this.ops.agentGone(launcher)) out.add(launcher)
      else if (this.launcherGone(launcher, lane)) out.add(root)
    }
    const unwatched = new Set<string>()
    for (const watch of this.store.watches()) {
      if (watch.lane !== lane.id) continue
      if (watch.mode === 'watch') out.add(watch.watcher)
      else unwatched.add(watch.watcher)
    }
    return [...out].filter((id) => id !== lane.id && !unwatched.has(id) && this.ops.receiver(id))
  }

  /** Nobody else would hear the lane in its launcher's place: the launcher
   * is here and can't take it (a shell, an agent that exited) or has ended.
   * A launcher that lives on a remote lane's own host is that host's to tell. */
  private launcherGone(launcher: string, lane: LaneSnapshot): boolean {
    if (lane.host === null || this.ops.sessions().some((s) => s.id === launcher)) return true
    return this.ops.elsewhere(launcher) !== lane.host
  }

  /** Who gets no `ended` line because `endedBy` ended the lane: the ender,
   * and the root when the ender is the lane's launcher; never an explicit
   * watcher other than the ender. */
  private endSkip(
    lane: LaneSnapshot,
    endedBy: string | null,
  ): { skip: Set<string>; launcher: boolean } {
    const skip = new Set<string>()
    if (!endedBy) return { skip, launcher: false }
    // The session that ended the lane itself already knows. A lane its own
    // launcher ended is that launcher's business: its root hears nothing
    // either (an explicit watcher still does).
    const launcher =
      lane.launched &&
      lane.coordinatorId !== null &&
      endedBy === (lane.parentId ?? lane.coordinatorId)
    skip.add(endedBy)
    if (launcher && lane.coordinatorId) skip.add(lane.coordinatorId)
    for (const watch of this.store.watches())
      if (watch.lane === lane.id && watch.mode === 'watch' && watch.watcher !== endedBy)
        skip.delete(watch.watcher)
    return { skip, launcher }
  }

  private fire(
    event: LaneEvent,
    lane: LaneSnapshot,
    extra: Parameters<typeof laneLine>[2] = {},
    endedBy: string | null = null,
    delivery: { toldSince?: number; repeat?: boolean } = {},
  ): boolean {
    const { outcome } = event
    const all = this.receivers(lane)
    const { skip, launcher } = this.endSkip(lane, endedBy)
    const where = laneWhere(lane)
    const dropped = all.filter((id) => skip.has(id))
    let skipped = dropped.length
      ? ` (skipped ${dropped.join(',')}: ended by ${launcher ? 'its launcher ' : ''}${endedBy})`
      : ''
    const left = all.filter((id) => !skip.has(id))
    // A receiver waiting on the lane hears this from its wait.
    const heard = left.length ? this.ops.heardFrom(lane.id, lane.host, left, event) : new Set()
    let receivers = left.filter((id) => !heard.has(id))
    let toldAll = false
    if (heard.size) skipped += ` (heard from its wait: ${[...heard].join(',')})`
    // A finished line after the lane told the receiver in that turn adds nothing.
    if (
      outcome === 'finished' &&
      lane.host === null &&
      delivery.toldSince !== undefined &&
      this.ops.told
    ) {
      const since = delivery.toldSince
      const told = receivers.filter((id) => this.ops.told?.(lane.id, id, since))
      if (told.length) {
        skipped += ` (told in that turn: ${told.join(',')})`
        receivers = receivers.filter((id) => !told.includes(id))
        toldAll = receivers.length === 0
      }
    }
    if (!receivers.length) {
      this.ops.log(`lane=${where} ${outcome}: no receiver${skipped}`)
      return toldAll
    }
    const line = laneLine(outcome, lane, extra)
    for (const receiver of receivers)
      this.ops.deliver(receiver, `lane:${where}:${outcome}`, line, delivery.repeat)
    this.ops.log(`lane=${where} ${outcome} -> ${receivers.join(',')}${skipped}`)
    return false
  }

  /** The sessions an End spared the `ended` line lose the lane's lines still
   * queued for them: they ended it themselves (or their lane did). */
  private withdrawStale(lane: LaneSnapshot, endedBy: string | null): void {
    const { skip } = this.endSkip(lane, endedBy)
    // Only the ender itself handled the End: a root spared the line because
    // its helper ended the lane still hears from its own wait on the lane.
    if (endedBy) this.ops.handled(lane.id, lane.host, [endedBy])
    const where = laneWhere(lane)
    const taken: string[] = []
    for (const receiver of skip)
      for (const outcome of [...LANE_OUTCOMES, 'model']) {
        const n = this.ops.withdraw(receiver, `lane:${where}:${outcome}`)
        if (n > 0) taken.push(`${receiver}:${outcome}${n > 1 ? `x${n}` : ''}`)
      }
    if (taken.length)
      this.ops.log(`lane=${where} ended: withdrew queued ${taken.join(',')} (ended by ${endedBy})`)
  }

  /** Ended lanes the delete trigger recorded on this computer. */
  drainOutbox(): void {
    if (this.stopped) return
    for (const row of this.store.outbox()) {
      this.store.transaction(() => {
        const cursor = this.store.get('', row.lane)
        const lane: LaneSnapshot = {
          id: row.lane,
          host: null,
          title: row.title ?? cursor?.title ?? row.lane,
          requestId: row.requestId ?? cursor?.requestId ?? null,
          coordinatorId: row.coordinatorId,
          parentId: row.parentId,
          launched: row.launched,
        }
        this.withdrawStale(lane, row.endedBy)
        if (!cursor?.ended)
          this.fire(endedEvent(this.memory.get(memoryKey(null, row.lane))), lane, {}, row.endedBy)
        this.store.forget('', row.lane)
        this.store.takeOutbox(row.id)
      })
      this.drop(memoryKey(null, row.lane))
    }
    this.store.pruneLocal()
    this.refreshWatched()
  }

  /** An End this hub forwarded to `host` named the session asking for it
   * (`by`), or null: that End did not end it. Kept in memory a short while. */
  remoteEnd(host: string, id: string, by: string | null): void {
    const key = memoryKey(host, id)
    if (by) this.remoteEnds.set(key, { by, at: this.ops.now() })
    else this.remoteEnds.delete(key)
  }

  /** A relayed lane ended on its host (the hub relays each id once). */
  ended(id: string, host: string): void {
    if (this.stopped) return
    const key = memoryKey(host, id)
    const mark = this.remoteEnds.get(key)
    this.remoteEnds.delete(key)
    const now = this.ops.now()
    for (const [other, { at }] of this.remoteEnds)
      if (now - at > REMOTE_END_MS) this.remoteEnds.delete(other)
    const cursor = this.store.get(host, id)
    if (!cursor) return
    const endedBy = mark && now - mark.at <= REMOTE_END_MS ? mark.by : null
    this.store.transaction(() => {
      const lane = cursorSnapshot(cursor)
      this.withdrawStale(lane, endedBy)
      if (!cursor.ended) this.fire(endedEvent(this.memory.get(key)), lane, {}, endedBy)
      this.store.forget(host, id)
    })
    this.drop(memoryKey(host, id))
    this.refreshWatched()
  }

  // --- watch / unwatch ---------------------------------------------------------

  /** Whether `watcher` gets this lane's reports through lineage: as its
   * launcher, or (`some`, for an unwatch) as the root that stands in for it. */
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
    .add('GET', '/v1/children', (_req, res) => {
      const current = reporter()
      if (!current) throw new HttpError(503, 'lane_reports_unavailable')
      sendJson(res, 200, { items: current.children() })
    })
    .add('GET', '/v1/sessions/:id/watches', (_req, res, params) => {
      const watcher = watcherOf(params.id)
      sendJson(res, 200, { items: reporter()?.watchesOf(watcher).map(json) ?? [] })
    })
    .add('POST', '/v1/sessions/:id/watches', async (req, res, params) => {
      const body = await readJsonObject(req)
      onlyFields(body, ['lane', 'mode'])
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
