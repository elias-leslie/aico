// Session wakes: scheduled check-ins (docs/plans/session-wakes.md). A wake is
// a time and a note on a session. Once due, Tether pastes the note into the
// session's agent, but only while the agent is idle, its input line is empty
// and nobody has typed for a moment, so it never types over the owner. A wake
// the owner kept past End relaunches the conversation in a new session.
// Tether is the only scheduler; the wakes table survives restarts and reboots.

import { randomBytes } from 'node:crypto'
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
})

export const WAKE_POLICY_BOUNDS: Readonly<Record<keyof WakePolicy, { min: number; max: number }>> =
  Object.freeze({
    laterMinutes: { min: 5, max: 1440 },
    tonightHour: { min: 0, max: 23 },
    morningHour: { min: 0, max: 23 },
    maxPerSession: { min: 1, max: 20 },
    noteMaxChars: { min: 20, max: 1500 },
    quietSeconds: { min: 0, max: 300 },
    lateNoticeMinutes: { min: 1, max: 1440 },
    relaunchAttempts: { min: 1, max: 100 },
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
}

export interface Wake {
  id: string
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
}

interface RawWake {
  id: string
  session_id: string | null
  due_at: number
  note: string
  created_at: number
  created_by: 'agent' | 'owner'
  kept: number
  ended_session: string | null
  attempts: number
  last_error: string | null
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
    sessionId: raw.session_id,
    dueAt: raw.due_at,
    note: raw.note,
    createdAt: raw.created_at,
    createdBy: raw.created_by,
    kept: raw.kept === 1,
    endedSession: ended,
    attempts: raw.attempts,
    lastError: raw.last_error,
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

  list(): Wake[] {
    return (
      this.db.prepare('SELECT * FROM wakes ORDER BY due_at, id').all() as unknown as RawWake[]
    ).map(toWake)
  }

  forSession(sessionId: string): Wake[] {
    return (
      this.db
        .prepare('SELECT * FROM wakes WHERE session_id = ? ORDER BY due_at, id')
        .all(sessionId) as unknown as RawWake[]
    ).map(toWake)
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
    this.db
      .prepare(
        `INSERT OR IGNORE INTO wakes (id, session_id, due_at, note, created_at, created_by, kept,
           ended_session, attempts, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

  /** Mark a session's wakes to outlive its End, with what a relaunch needs.
   * Returns how many. */
  keep(sessionId: string, ended: EndedSession): number {
    return Number(
      this.db
        .prepare('UPDATE wakes SET kept = 1, ended_session = ? WHERE session_id = ?')
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

/** What the agent receives for its due wakes, oldest first. */
export function wakeMessage(
  wakes: readonly Wake[],
  now: number,
  policy: WakePolicy,
  options: { resumed?: boolean } = {},
): string {
  const first = wakes[0]
  if (!first) return ''
  const parts = [`[Scheduled check-in for ${clockLabel(first.dueAt, now)}`]
  const lateMinutes = Math.floor((now - first.dueAt) / 60_000)
  if (lateMinutes > policy.lateNoticeMinutes) parts.push(`${lateMinutes} min late`)
  if (options.resumed) parts.push('resumed after End')
  return `${parts.join(', ')}] ${wakes.map((wake) => wake.note).join(' / ')}`
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
/** Claude Code draws `❯`, Codex `›`, older Claude Code `│ >`. */
const PROMPT = /^[\s│]*(?:❯|›|>(?=\s))/
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
    if (PROMPT.test(visibleText(lines[index] ?? ''))) {
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
  /** Ask the desktop to reopen a closed window of a session it has shown. */
  reopen(sessionId: string): void
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
export const WAKE_RECHECK_MS = 3_000
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
  /** Wakes whose window reopen was already asked for. */
  private readonly reopened = new Set<string>()
  /** Kept wakes waiting out a failed relaunch. */
  private readonly retryAt = new Map<string, number>()
  /** Why each session's due wakes are not delivered yet. */
  private readonly held = new Map<string, string>()

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
    const waiting = wakes.filter((wake) => wake.dueAt <= now && !this.stalled(wake))
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
    for (const wakes of kept.values()) await this.relaunchKept(wakes)
    for (const id of this.reopened) if (!this.store.get(id)) this.reopened.delete(id)
  }

  private async deliverLive(sessionId: string, wakes: Wake[]): Promise<void> {
    const fresh = wakes.filter((wake) => !this.reopened.has(wake.id))
    if (fresh.length) {
      for (const wake of fresh) this.reopened.add(wake.id)
      this.ops.reopen(sessionId)
      // Now due: the apps word it as waiting rather than as a time ahead.
      this.ops.changed(sessionId)
    }
    const reason = await this.gate(sessionId)
    if (reason) {
      this.hold(sessionId, reason)
      return
    }
    // Re-read: a wake cancelled meanwhile must not go out.
    const current = this.store.forSession(sessionId).filter((wake) => wake.dueAt <= this.ops.now())
    if (!current.length) return
    const message = wakeMessage(current, this.ops.now(), this.ops.policy())
    // At most once: the rows go before the paste and come back only when it
    // certainly did not happen.
    for (const wake of current) this.store.remove(wake.id)
    let delivered = false
    try {
      delivered = await this.ops.deliver(sessionId, message)
    } finally {
      if (!delivered) for (const wake of current) this.store.restore(wake)
      this.ops.changed(sessionId)
    }
    if (!delivered) {
      this.hold(sessionId, 'the paste did not go through')
      return
    }
    const held = this.held.get(sessionId)
    this.held.delete(sessionId)
    const late = Math.floor((this.ops.now() - (current[0]?.dueAt ?? 0)) / 60_000)
    this.ops.log(
      `delivered ${current.length} check-in(s) to session=${sessionId}` +
        (held ? `, ${late} min after due (held: ${held})` : ''),
    )
  }

  /** The first gate a due wake fails, or null when it may go out now. */
  private async gate(sessionId: string): Promise<string | null> {
    const busy = await this.ops.busy(sessionId)
    if (busy) return busy
    const quietSeconds = this.ops.policy().quietSeconds
    const lastKey = await this.ops.lastKeyAt(sessionId)
    if (lastKey !== null && this.ops.now() - lastKey < quietSeconds * 1000)
      return `someone typed in the last ${quietSeconds}s`
    if (!(await this.ops.inputEmpty(sessionId))) return 'the input line holds a draft'
    return null
  }

  /** Log each new reason a session's due wakes wait, once. */
  private hold(sessionId: string, reason: string): void {
    if (this.held.get(sessionId) === reason) return
    this.held.set(sessionId, reason)
    this.ops.log(`check-in for session=${sessionId} waits: ${reason}`)
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
