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
  /** How the answer travels: `wake` (a check-in to the session) or `pull`. */
  delivery: 'wake' | 'pull' | null
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

/** The check-in note that carries an answer: the question and the answer in
 * one line, at most `max` characters, always ending with how to read it whole
 * and close it. */
export function answerNote(ask: Ask, max: number): string {
  const tail = ` (full: tether ask get ${ask.id}; when handled: tether ask done ${ask.id})`
  const reply = [
    ask.answer ? `"${ask.answer}"` : null,
    ask.note ? `note: "${ask.note.replace(/\s+/g, ' ')}"` : null,
  ]
    .filter(Boolean)
    .join(', ')
  const head = `Owner answered ask ${ask.id} "${ask.question}": ${reply}`
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

  delivered(id: string, wakeId: string | null): void {
    this.db
      .prepare('UPDATE asks SET wake_id = ?, delivery = ? WHERE id = ?')
      .run(wakeId, wakeId ? 'wake' : 'pull', id)
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
  /** Queue the note as a due-now check-in on the session; the wake id, or
   * null when the session cannot be woken (gone, a shell, no state reader). */
  wake(sessionId: string, note: string): string | null
  /** Cancel a check-in not yet delivered. */
  cancel(wakeId: string): void
  noteMaxChars(): number
  /** The session's descriptor changed (its `asks`). */
  sessionChanged(sessionId: string): void
}

const STATES: readonly AskState[] = ['open', 'answered', 'done', 'withdrawn']

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

  const changed = (ask: Ask, created = false) => {
    events.publish('asks.changed', { ask, created })
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
      const { ask, created } = asks.add(request, at)
      if (created || ask.state === 'open') changed(ask, created)
      sendJson(res, created ? 201 : 200, ask)
    })
    .add('GET', '/v1/asks', (_req, res, _params, query) => {
      const session = query.get('session') ?? undefined
      if (session !== undefined && !SESSION.test(session))
        throw new HttpError(400, 'invalid_query', { field: 'session' })
      const requester = query.get('requester') ?? undefined
      const states = (query.get('state') ?? '').split(',').filter(Boolean) as AskState[]
      if (!states.every((state) => STATES.includes(state)))
        throw new HttpError(400, 'invalid_query', { field: 'state' })
      sendJson(res, 200, { items: asks.list({ session, requester, states }) })
    })
    .add('GET', '/v1/asks/:id', (_req, res, params) => {
      sendJson(res, 200, requireAsk(params.id))
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
      const wakeId =
        answered.session && delivery
          ? delivery.wake(answered.session, answerNote(answered, delivery.noteMaxChars()))
          : null
      asks.delivered(ask.id, wakeId)
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
