// Owner asks: a question an agent puts to the owner once, with optional
// choices (one recommended), a longer body, a command to copy or a share to
// look at. The owner answers in Aico; the answer reaches a session Tether can
// wake as a check-in that is due now (wakes.ts: delivered when the agent is
// idle, its input line empty and the owner quiet), and any asker reads it with
// `tether ask get`. Re-asking the same open question updates it instead of
// adding another. An open blocking ask marks its session as needing the owner
// (the descriptor's `asks`), whatever state the agent reports.

import { createHash, randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { ShowConfig } from './config'
import type { EventBus } from './events'
import { HttpError, type Router, readJsonObject, sendJson } from './http'

export const MAX_ASK_OPTIONS = 5
/** The most asks listed at once (newest kept). */
export const MAX_LISTED_ASKS = 200

const ID = /^[0-9a-f]{12}$/
const SESSION = /^[0-9a-f]{8}$/
/** Control and format characters; a one-line field also refuses line breaks. */
const ONE_LINE_BAD = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u
/** Text that may span lines: tabs and newlines are fine, other controls are not. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const MULTI_LINE_BAD = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\p{Cf}\p{Cs}\u2028\u2029]/u

export type AskState = 'open' | 'answered' | 'done' | 'withdrawn'

export interface Ask {
  id: string
  session: string | null
  requester: string | null
  question: string
  options: string[]
  /** Index into `options`, or null. */
  recommended: number | null
  body: string | null
  command: string | null
  /** A `tether share` id to look at. */
  share: string | null
  blocking: boolean
  state: AskState
  answer: string | null
  note: string | null
  /** How the answer travels: `wake` (a line queued to a session) or `pull`. */
  delivery: 'wake' | 'pull' | null
  /** The session that launched the asker (asks from ended lanes). */
  launcher: string | null
  /** The asker's coordinator when filed: where the answer goes when the asker
   * and its launcher have both ended. */
  coordinator: string | null
  /** The session the answer goes to: while open, where it would go now (the
   * asker, or its launcher once the asker has ended); once answered, where
   * it went. Null: no session gets it (read with `tether ask get`). */
  answerTo: string | null
  createdAt: number
  updatedAt: number
  answeredAt: number | null
}

export interface AskRequest {
  session: string | null
  requester: string | null
  question: string
  options: string[]
  recommended: number | null
  body: string | null
  command: string | null
  share: string | null
  blocking: boolean
}

interface AskRow {
  id: string
  session_id: string | null
  requester: string | null
  question_hash: string
  question: string
  options: string
  recommended: number | null
  body: string | null
  command: string | null
  share_id: string | null
  blocking: number
  state: AskState
  answer: string | null
  note: string | null
  wake_id: string | null
  delivery: 'wake' | 'pull' | null
  launcher_id: string | null
  answer_to: string | null
  coordinator_id?: string | null
  created_at: number
  updated_at: number
  answered_at: number | null
}

function fromRow(row: AskRow): Ask {
  let options: string[] = []
  try {
    const parsed = JSON.parse(row.options) as unknown
    if (Array.isArray(parsed)) options = parsed.filter((item) => typeof item === 'string')
  } catch {
    options = []
  }
  return {
    id: row.id,
    session: row.session_id,
    requester: row.requester,
    question: row.question,
    options,
    recommended: row.recommended,
    body: row.body,
    command: row.command,
    share: row.share_id,
    blocking: row.blocking === 1,
    state: row.state,
    answer: row.answer,
    note: row.note,
    delivery: row.delivery,
    launcher: row.launcher_id ?? null,
    coordinator: row.coordinator_id ?? null,
    answerTo: row.answer_to ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    answeredAt: row.answered_at,
  }
}

const chars = (text: string) => Array.from(text).length

/** Same question, whatever its spacing or case. */
export function questionHash(question: string): string {
  return createHash('sha256')
    .update(question.trim().replace(/\s+/g, ' ').toLowerCase())
    .digest('hex')
    .slice(0, 32)
}

function oneLine(value: unknown, field: string, max: number, required: boolean): string | null {
  if (value === undefined || value === null) {
    if (required) throw new HttpError(400, 'invalid_body', { field })
    return null
  }
  if (typeof value !== 'string') throw new HttpError(400, 'invalid_body', { field })
  const text = value.trim()
  if (!text || chars(text) > max || ONE_LINE_BAD.test(text))
    throw new HttpError(400, 'invalid_body', { field, detail: `one line, 1 to ${max} characters` })
  return text
}

function multiLine(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new HttpError(400, 'invalid_body', { field })
  const text = value.replace(/\r\n?/g, '\n').trim()
  if (!text) return null
  if (chars(text) > max || MULTI_LINE_BAD.test(text))
    throw new HttpError(400, 'invalid_body', { field, detail: `at most ${max} characters` })
  return text
}

function only(body: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key))
  if (unknown.length) throw new HttpError(400, 'invalid_body', { fields: unknown })
}

export function parseAsk(body: Record<string, unknown>): AskRequest {
  only(body, [
    'session',
    'requester',
    'question',
    'options',
    'recommended',
    'body',
    'command',
    'share',
    'blocking',
  ])
  const session = body.session ?? null
  if (session !== null && (typeof session !== 'string' || !SESSION.test(session)))
    throw new HttpError(400, 'invalid_body', { field: 'session' })
  const requester = oneLine(body.requester, 'requester', 60, false)
  if (session === null && requester === null)
    throw new HttpError(400, 'invalid_body', {
      field: 'requester',
      detail: 'name the asker: a session or a requester',
    })
  const question = oneLine(body.question, 'question', 200, true) as string
  const rawOptions = body.options ?? []
  if (!Array.isArray(rawOptions) || rawOptions.length > MAX_ASK_OPTIONS)
    throw new HttpError(400, 'invalid_body', {
      field: 'options',
      detail: `at most ${MAX_ASK_OPTIONS} choices`,
    })
  const options = rawOptions.map((option) => oneLine(option, 'options', 100, true) as string)
  if (new Set(options).size !== options.length)
    throw new HttpError(400, 'invalid_body', { field: 'options', detail: 'choices repeat' })
  const recommended = body.recommended ?? null
  if (
    recommended !== null &&
    (!Number.isSafeInteger(recommended) ||
      (recommended as number) < 0 ||
      (recommended as number) >= options.length)
  )
    throw new HttpError(400, 'invalid_body', {
      field: 'recommended',
      detail: 'the index of one of the choices',
    })
  const share = body.share ?? null
  if (share !== null && (typeof share !== 'string' || !ID.test(share)))
    throw new HttpError(400, 'invalid_body', { field: 'share' })
  if (body.blocking !== undefined && typeof body.blocking !== 'boolean')
    throw new HttpError(400, 'invalid_body', { field: 'blocking' })
  return {
    session: session as string | null,
    requester,
    question,
    options,
    recommended: recommended as number | null,
    body: multiLine(body.body, 'body', 4000),
    command: multiLine(body.command, 'command', 2000),
    share: share as string | null,
    blocking: body.blocking === true,
  }
}

/** The line that carries an answer: the question and the answer in one
 * line, at most `max` characters, always ending with how to read it whole and
 * close it. `handedFrom` names the ended session that asked when the answer
 * goes to its launcher. */
export function answerNote(ask: Ask, max: number, handedFrom: string | null = null): string {
  const tail = ` (full: tether ask get ${ask.id}; when handled: tether ask done ${ask.id})`
  const reply = [
    ask.answer ? `"${ask.answer}"` : null,
    ask.note ? `note: "${ask.note.replace(/\s+/g, ' ')}"` : null,
  ]
    .filter(Boolean)
    .join(', ')
  const from = handedFrom ? ` (asked by ended session ${handedFrom})` : ''
  const head = `Owner answered ask ${ask.id}${from} "${ask.question}": ${reply}`
  const room = max - chars(tail)
  if (chars(head) <= room) return `${head}${tail}`
  return `${Array.from(head)
    .slice(0, Math.max(0, room - 1))
    .join('')}…${tail}`
}

/** The asks table (schema v17). One daemon writes it. */
export class AskStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly random: () => string = () => randomBytes(6).toString('hex'),
  ) {}

  get(id: string): Ask | undefined {
    const row = this.row(id)
    return row && fromRow(row)
  }

  /** The pending check-in carrying this ask's answer, if any. */
  wakeOf(id: string): string | null {
    return this.row(id)?.wake_id ?? null
  }

  private row(id: string): AskRow | undefined {
    return this.db.prepare('SELECT * FROM asks WHERE id = ?').get(id) as unknown as
      | AskRow
      | undefined
  }

  /** A new ask, or the asker's open (or still unclosed answered) ask with the
   * same question: an open one takes the new details, an answered one comes
   * back as it is so the asker reads the answer. */
  add(request: AskRequest, now: number): { ask: Ask; created: boolean } {
    const hash = questionHash(request.question)
    const existing = this.db
      .prepare(
        `SELECT * FROM asks WHERE question_hash = ? AND state IN ('open', 'answered')
           AND ((? IS NOT NULL AND session_id = ?) OR (? IS NULL AND session_id IS NULL AND requester = ?))
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(hash, request.session, request.session, request.session, request.requester) as unknown as
      | AskRow
      | undefined
    if (existing?.state === 'answered') return { ask: fromRow(existing), created: false }
    const values = [
      request.requester,
      request.question,
      JSON.stringify(request.options),
      request.recommended,
      request.body,
      request.command,
      request.share,
      request.blocking ? 1 : 0,
    ]
    if (existing) {
      this.db
        .prepare(
          `UPDATE asks SET requester = ?, question = ?, options = ?, recommended = ?, body = ?,
             command = ?, share_id = ?, blocking = ?, updated_at = ? WHERE id = ?`,
        )
        .run(...values, now, existing.id)
      return { ask: this.get(existing.id) as Ask, created: false }
    }
    const id = this.random()
    this.db
      .prepare(
        `INSERT INTO asks (id, session_id, requester, question, options, recommended, body,
           command, share_id, blocking, question_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, request.session, ...values, hash, now, now)
    return { ask: this.get(id) as Ask, created: true }
  }

  answer(
    id: string,
    answer: { answer: string | null; note: string | null },
    now: number,
  ): Ask | undefined {
    this.db
      .prepare(
        `UPDATE asks SET state = 'answered', answer = ?, note = ?, answered_at = ?, updated_at = ?,
           wake_id = NULL, delivery = NULL WHERE id = ?`,
      )
      .run(answer.answer, answer.note, now, now, id)
    return this.get(id)
  }

  delivered(id: string, wakeId: string | null, to: string | null = null): void {
    this.db
      .prepare('UPDATE asks SET wake_id = ?, delivery = ?, answer_to = ? WHERE id = ?')
      .run(wakeId, wakeId ? 'wake' : 'pull', wakeId ? to : null, id)
  }

  /** Record the session that launched the asker. */
  setLauncher(id: string, launcher: string | null): void {
    this.db.prepare('UPDATE asks SET launcher_id = ? WHERE id = ?').run(launcher, id)
  }

  /** Record the asker's lineage when filed: its launcher and coordinator. */
  setLineage(id: string, launcher: string | null, coordinator: string | null): void {
    this.db
      .prepare('UPDATE asks SET launcher_id = ?, coordinator_id = ? WHERE id = ?')
      .run(launcher, coordinator, id)
  }

  /** Open asks another session filed that this one holds as launcher. */
  openLaunchedBy(sessionId: string): Ask[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM asks WHERE launcher_id = ? AND state = 'open'
             AND (session_id IS NULL OR session_id != ?) ORDER BY created_at, rowid`,
        )
        .all(sessionId, sessionId) as unknown as AskRow[]
    ).map(fromRow)
  }

  /** Answered asks whose answer line was queued to this session. */
  answeredTo(sessionId: string): Ask[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM asks WHERE answer_to = ? AND state = 'answered' AND delivery = 'wake'
             AND wake_id IS NOT NULL ORDER BY answered_at, rowid`,
        )
        .all(sessionId) as unknown as AskRow[]
    ).map(fromRow)
  }

  close(id: string, state: 'done' | 'withdrawn', now: number): Ask | undefined {
    this.db
      .prepare('UPDATE asks SET state = ?, wake_id = NULL, updated_at = ? WHERE id = ?')
      .run(state, now, id)
    return this.get(id)
  }

  /** Open and answered asks, then recently closed ones; newest first. */
  list(filter: { session?: string; requester?: string; states?: AskState[] } = {}): Ask[] {
    const where: string[] = []
    const args: (string | number)[] = []
    if (filter.session) {
      where.push('session_id = ?')
      args.push(filter.session)
    }
    if (filter.requester) {
      where.push('session_id IS NULL AND requester = ?')
      args.push(filter.requester)
    }
    if (filter.states?.length) {
      where.push(`state IN (${filter.states.map(() => '?').join(', ')})`)
      args.push(...filter.states)
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM asks ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY updated_at DESC, rowid DESC LIMIT ?`,
      )
      .all(...args, MAX_LISTED_ASKS) as unknown as AskRow[]
    return rows.map(fromRow)
  }

  /** A session's open asks, oldest first (the descriptor's `asks`). */
  openFor(sessionId: string): Ask[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM asks WHERE session_id = ? AND state = 'open' ORDER BY created_at, rowid",
        )
        .all(sessionId) as unknown as AskRow[]
    ).map(fromRow)
  }

  /** How many asks are open and how many block, with the newest open one. */
  openSummary(): { open: number; blocking: number; newest: Ask | null } {
    const counts = this.db
      .prepare(
        "SELECT COUNT(*) AS open, COALESCE(SUM(blocking), 0) AS blocking FROM asks WHERE state = 'open'",
      )
      .get() as { open: number; blocking: number }
    const newest = this.db
      .prepare(
        "SELECT * FROM asks WHERE state = 'open' ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get() as unknown as AskRow | undefined
    return {
      open: Number(counts.open),
      blocking: Number(counts.blocking),
      newest: newest ? fromRow(newest) : null,
    }
  }

  /** Drop closed asks past the retention. */
  prune(before: number): void {
    this.db
      .prepare("DELETE FROM asks WHERE state IN ('done', 'withdrawn') AND updated_at < ?")
      .run(before)
  }
}

// --- the descriptor overlay ---------------------------------------------------------

let bound: AskStore | null = null

export function bindAskStore(store: AskStore | null): void {
  bound = store
}

/** The session's open asks for its descriptor (`asks`), oldest first. */
export function sessionAsks(sessionId: string): Record<string, unknown>[] {
  return (bound?.openFor(sessionId) ?? []).map((ask) => ({
    id: ask.id,
    question: ask.question,
    blocking: ask.blocking,
    createdAt: ask.createdAt,
  }))
}

// --- the tray feed --------------------------------------------------------------

/** How often the feed is rewritten unchanged, so a reader can tell Tether is up. */
export const FEED_HEARTBEAT_MS = 60_000

/** The Nightshift tray's view of the asks (handoffs TRAY-FEED-CONTRACT.md):
 * counts and the newest open ask's id and asker, never the question. */
export interface NeedsYouFeed {
  version: 1
  writtenAt: number
  open: number
  blocking: number
  newest: {
    id: string
    name: string
    blocking: boolean
    createdAt: number
    /** Aico's link to the ask, or null when Tether is not told where Aico is. */
    url: string | null
  } | null
}

/** The Aico web origin from TETHER_AICO_URL (https only), else null. */
export function aicoOrigin(raw: string | undefined): string | null {
  if (!raw) return null
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' ? url.origin : null
  } catch {
    return null
  }
}

export function needsYouFeed(
  summary: ReturnType<AskStore['openSummary']>,
  nameOf: (sessionId: string) => string | null,
  now: number,
  origin: string | null = null,
): NeedsYouFeed {
  const { newest } = summary
  return {
    version: 1,
    writtenAt: now,
    open: summary.open,
    blocking: summary.blocking,
    newest: newest
      ? {
          id: newest.id,
          name:
            (newest.session && nameOf(newest.session)) ||
            newest.requester ||
            (newest.session ? `Session ${newest.session}` : 'An agent'),
          blocking: newest.blocking,
          createdAt: newest.createdAt,
          url: origin ? `${origin}/?ask=${newest.id}` : null,
        }
      : null,
  }
}

// --- routes ---------------------------------------------------------------------

/** What the asks need from the running daemon. */
export interface AskDelivery {
  /** Queue the note as a due-now line on the session (`source` coalesces
   * it); the queued row's id, or null when the session cannot take it (gone,
   * a shell, no state reader). */
  wake(sessionId: string, note: string, source?: string): string | null
  /** A session that takes lines now (a live agent session). Without it, the
   * asker is always the one answered. */
  receiver?(sessionId: string): boolean
  /** The session that launched this one (its lineage from a launch), or null. */
  launcherOf?(sessionId: string): string | null
  /** This session's coordinator (lineage from a launch), or null. */
  coordinatorOf?(sessionId: string): string | null
  /** A line queued with `wake` that is gone undelivered (its session ended). */
  lost?(wakeId: string): boolean
  /** A short name for a session in a line. */
  nameOf?(sessionId: string): string | null
  /** Cancel a check-in not yet delivered. */
  cancel(wakeId: string): void
  /** Take back undelivered lines by source on any session (an `[Ask] filed`
   * line once its ask is answered or closed). */
  withdraw?(source: string): void
  noteMaxChars(): number
  /** The session's descriptor changed (its `asks`). */
  sessionChanged(sessionId: string): void
}

const STATES: readonly AskState[] = ['open', 'answered', 'done', 'withdrawn']

/** Where an ask's answer goes now: the asker while it is there, else the
 * session that launched it, else its coordinator, else nobody (read it with
 * `tether ask get`). */
export function answerTarget(ask: Ask, delivery: AskDelivery | undefined): string | null {
  if (!ask.session || !delivery) return null
  if (!delivery.receiver) return ask.session
  for (const id of [ask.session, ask.launcher, ask.coordinator])
    if (id && delivery.receiver(id)) return id
  return null
}

/** The asker's name in a line: its name when known, else its id. */
function askerName(sessionId: string, delivery: AskDelivery | undefined): string {
  const name = delivery?.nameOf?.(sessionId)
  return name ? `"${clipLine(name, 40)}" (${sessionId})` : sessionId
}

function clipLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const all = Array.from(flat)
  return all.length <= max ? flat : `${all.slice(0, max - 1).join('')}…`
}

/** The line a lane's launcher gets when the lane files an ask: relay it or
 * close it, never ask the owner again. */
export function askFiledLine(ask: Ask, name: string, max: number): string {
  const tail = ` · relay or close it, don't ask again: tether ask get ${ask.id}`
  const head = `[Ask] session ${name} asked the owner (${ask.id}): `
  const room = Math.max(10, max - chars(head) - chars(tail) - 2)
  return `${head}"${clipLine(ask.question, Math.min(room, 120))}"${tail}`
}

/** The one line a launcher gets when a session ends with open asks. */
export function askHandOffLine(asks: readonly Ask[], name: string): string {
  const ids = asks.slice(0, 5).map((ask) => ask.id)
  const more = asks.length > ids.length ? ` and ${asks.length - ids.length} more` : ''
  const which = asks.length === 1 ? 'an open ask' : `${asks.length} open asks`
  return `[Asks handed over] session ${name} ended with ${which} to the owner (${ids.join(', ')}${more}); the answers come to you · tether ask get ${ids[0]}`
}

/**
 * A session ended (its row is gone): never leave an answer an orphan.
 * - Its open asks go up the chain (launcher, else coordinator), one line to
 *   each session that takes some.
 * - Open asks it held as launcher move to their coordinator; ones whose asker
 *   has ended too are handed on the same way.
 * - An answer already queued to it but not delivered is queued again to the
 *   next session up the chain.
 * Returns the asks whose `answerTo` changed, as the API shows them.
 */
export function handOffAsks(
  asks: AskStore,
  delivery: AskDelivery,
  sessionId: string,
  name: string | null,
): Ask[] {
  const changed = new Map<string, Ask>()
  const handed: Ask[] = asks.openFor(sessionId)
  for (const held of asks.openLaunchedBy(sessionId)) {
    const next = held.coordinator && held.coordinator !== sessionId ? held.coordinator : null
    asks.setLauncher(held.id, next)
    const ask = asks.get(held.id) as Ask
    if (ask.session && !delivery.receiver?.(ask.session)) handed.push(ask)
  }
  const byTarget = new Map<string, Ask[]>()
  for (const ask of handed) {
    const to = answerTarget(ask, delivery)
    if (!to || to === sessionId) continue
    byTarget.set(to, [...(byTarget.get(to) ?? []), ask])
    changed.set(ask.id, { ...ask, answerTo: to })
  }
  const shown = name ? `"${clipLine(name, 40)}" (${sessionId})` : sessionId
  for (const [to, list] of byTarget)
    delivery.wake(
      to,
      clipLine(askHandOffLine(list, shown), delivery.noteMaxChars()),
      `ask:handoff:${sessionId}`,
    )
  for (const ask of asks.answeredTo(sessionId)) {
    const queued = asks.wakeOf(ask.id)
    if (!ask.session || !queued || !delivery.lost?.(queued)) continue
    const to = answerTarget(ask, delivery)
    if (!to || to === sessionId) continue
    const handedFrom = to !== ask.session ? askerName(ask.session, delivery) : null
    const wakeId = delivery.wake(
      to,
      answerNote(ask, delivery.noteMaxChars(), handedFrom),
      `ask:${ask.id}`,
    )
    asks.delivered(ask.id, wakeId, to)
    changed.set(ask.id, asks.get(ask.id) as Ask)
  }
  return [...changed.values()]
}

export function registerAskRoutes(
  router: Router,
  options: {
    db: DatabaseSync
    events: EventBus
    show: ShowConfig
    delivery?: AskDelivery
    /** Keep the tray feed: write it with this on every change and each heartbeat. */
    feed?: {
      write(feed: NeedsYouFeed): void
      nameOf(sessionId: string): string | null
      origin?: string | null
    }
    now?: () => number
  },
): AskStore {
  const asks = new AskStore(options.db)
  const now = options.now ?? Date.now
  const { events, delivery, feed } = options
  bindAskStore(asks)

  const writeFeed = () => {
    if (!feed) return
    try {
      feed.write(needsYouFeed(asks.openSummary(), feed.nameOf, now(), feed.origin ?? null))
    } catch (error) {
      console.warn(`[tether] needs-you feed not written: ${(error as Error).message}`)
    }
  }
  if (feed) {
    writeFeed()
    setInterval(writeFeed, FEED_HEARTBEAT_MS).unref()
  }

  /** An ask as the API shows it: an open one says where its answer would go now. */
  const present = (ask: Ask): Ask =>
    ask.state === 'open' ? { ...ask, answerTo: answerTarget(ask, delivery) } : ask
  const changed = (ask: Ask, created = false) => {
    events.publish('asks.changed', { ask: present(ask), created })
    if (ask.session) delivery?.sessionChanged(ask.session)
    writeFeed()
  }
  const requireAsk = (id: string | undefined): Ask => {
    const ask = id && ID.test(id) ? asks.get(id) : undefined
    if (!ask) throw new HttpError(404, 'not_found')
    return ask
  }
  const cancelWake = (id: string) => {
    const wakeId = asks.wakeOf(id)
    if (wakeId) delivery?.cancel(wakeId)
    // The launcher's "[Ask] filed" line is stale once the ask is settled.
    delivery?.withdraw?.(`ask:${id}:filed`)
  }
  const shareExists = (id: string) =>
    Boolean(options.db.prepare('SELECT 1 FROM shares WHERE id = ?').get(id))

  router
    .add('POST', '/v1/asks', async (req, res) => {
      const request = parseAsk(await readJsonObject(req))
      if (request.share && !shareExists(request.share))
        throw new HttpError(400, 'invalid_body', { field: 'share', detail: 'no such share' })
      const at = now()
      asks.prune(at - options.show.retentionDays * 24 * 60 * 60 * 1000)
      let { ask, created } = asks.add(request, at)
      if (created && ask.session) {
        // Lineage when filed; the launcher hears of it so it relays or closes
        // the ask instead of asking the owner again.
        const launcher = delivery?.launcherOf?.(ask.session) ?? null
        const coordinator = delivery?.coordinatorOf?.(ask.session) ?? null
        if (launcher || coordinator) {
          asks.setLineage(
            ask.id,
            launcher !== ask.session ? launcher : null,
            coordinator !== ask.session ? coordinator : null,
          )
          ask = asks.get(ask.id) as Ask
        }
        if (launcher && launcher !== ask.session) {
          if (delivery?.receiver?.(launcher))
            delivery.wake(
              launcher,
              askFiledLine(
                ask,
                askerName(ask.session as string, delivery),
                delivery.noteMaxChars(),
              ),
              `ask:${ask.id}:filed`,
            )
        }
      }
      if (created || ask.state === 'open') changed(ask, created)
      sendJson(res, created ? 201 : 200, present(ask))
    })
    .add('GET', '/v1/asks', (_req, res, _params, query) => {
      const session = query.get('session') ?? undefined
      if (session !== undefined && !SESSION.test(session))
        throw new HttpError(400, 'invalid_query', { field: 'session' })
      const requester = query.get('requester') ?? undefined
      const states = (query.get('state') ?? '').split(',').filter(Boolean) as AskState[]
      if (!states.every((state) => STATES.includes(state)))
        throw new HttpError(400, 'invalid_query', { field: 'state' })
      sendJson(res, 200, { items: asks.list({ session, requester, states }).map(present) })
    })
    .add('GET', '/v1/asks/:id', (_req, res, params) => {
      sendJson(res, 200, present(requireAsk(params.id)))
    })
    .add('POST', '/v1/asks/:id/answer', async (req, res, params) => {
      const body = await readJsonObject(req)
      only(body, ['option', 'text', 'note'])
      const ask = requireAsk(params.id)
      if (ask.state !== 'open' && ask.state !== 'answered')
        throw new HttpError(409, 'ask_closed', { state: ask.state })
      let answer: string | null = null
      if (body.option !== undefined) {
        const index = body.option
        if (
          !Number.isSafeInteger(index) ||
          (index as number) < 0 ||
          (index as number) >= ask.options.length
        )
          throw new HttpError(400, 'invalid_body', { field: 'option' })
        answer = ask.options[index as number] as string
      }
      const text = oneLine(body.text, 'text', 100, false)
      if (text !== null) {
        if (answer !== null)
          throw new HttpError(400, 'invalid_body', { detail: 'give an option or a text, not both' })
        answer = text
      }
      const note = multiLine(body.note, 'note', 1000)
      if (answer === null && note === null)
        throw new HttpError(400, 'invalid_body', { detail: 'give an answer or a note' })
      cancelWake(ask.id)
      let answered = asks.answer(ask.id, { answer, note }, now()) as Ask
      // The asker, or its launcher once the asker has ended (worked out now).
      const to = answerTarget(answered, delivery)
      const handedFrom =
        to && answered.session && to !== answered.session
          ? askerName(answered.session, delivery)
          : null
      const wakeId =
        to && delivery
          ? delivery.wake(
              to,
              answerNote(answered, delivery.noteMaxChars(), handedFrom),
              `ask:${ask.id}`,
            )
          : null
      asks.delivered(ask.id, wakeId, to)
      answered = asks.get(ask.id) as Ask
      changed(answered)
      sendJson(res, 200, answered)
    })
    .add('POST', '/v1/asks/:id/done', (_req, res, params) => {
      const ask = requireAsk(params.id)
      if (ask.state === 'done') return sendJson(res, 200, ask)
      if (ask.state === 'withdrawn') throw new HttpError(409, 'ask_closed', { state: ask.state })
      cancelWake(ask.id)
      const closed = asks.close(ask.id, 'done', now()) as Ask
      changed(closed)
      sendJson(res, 200, closed)
    })
    .add('POST', '/v1/asks/:id/withdraw', (_req, res, params) => {
      const ask = requireAsk(params.id)
      if (ask.state === 'withdrawn') return sendJson(res, 200, ask)
      if (ask.state === 'done') throw new HttpError(409, 'ask_closed', { state: ask.state })
      cancelWake(ask.id)
      const closed = asks.close(ask.id, 'withdrawn', now()) as Ask
      changed(closed)
      sendJson(res, 200, closed)
    })
  return asks
}
