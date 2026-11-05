// Deliveries (docs/api-v1.md "Deliveries"): one line another owner queues on
// a session's delivery queue, the same gated queue Tether's own event lines
// ride (wakes, kind `event`): pasted once the agent is idle, nobody has typed
// for a moment and the input line is empty; an Agent Hub chat takes it as a
// turn; a native puller (Claude's asyncRewake hook, Pi's extension) takes it
// as a notice while attached. SummitFlow's coordination inbox queues its
// `[Message] …` lines here instead of typing into panes itself.
//
// `GET /v1/sessions/:id/due?wait=N` is the native puller's long poll: it
// answers with the session's next delivery as text, at most once.
//
// Two classes (API 24). A wake line pastes or wakes the session when it is due;
// a ride-along line (`ride: true`) never does on its own: it joins the next
// wake paste, or the agent's next natural turn takes it with
// `GET /v1/sessions/:id/due?ride=1` (a prompt hook, a tool result). Since API
// 25 a client peeks instead (`?ride=peek`: the text and a token, nothing
// taken) and confirms once it has shown the text
// (`DELETE /v1/sessions/:id/due?token=`), so a client that dies or times out in
// between loses no line.
//
// `from` names the sessions whose message a line carries: each counts as
// having acted on this session (a lane's repeat went-idle backoff starts over),
// and, for a wake line that is not a `reply` (an ack of this session's
// request), as having told it (a lane that told its launcher during a turn
// sends no went-idle line for it). A `reply` also shows that what it answers
// reached its sender: that lane's next went-idle line is a first line (a wake).
// A wake line whose `from` names another session reaches this one from
// outside: once it goes out, this lane's next went-idle line is a first line
// too. A line with no `from` (the session's own watcher: an eta reminder, a
// memory notice) and a ride-along line do not. A ride-along `reply` is kept
// with its senders: a sender lane that goes idle waiting on something of its
// own (no went-idle line to carry the reply) makes it a wake.
//
// `DELETE /v1/sessions/:id/deliveries?source=` takes back a producer's line
// that has not gone out (it went stale: the inbox has nothing waiting any
// more); a paste already going out cannot be stopped and says so.

import type { DatabaseSync } from 'node:sqlite'
import { HttpError, type Router, readJsonObject, sendJson } from './http'
import { RIDE_TOKEN, type Wake } from './wakes'

const SESSION_ID = /^[0-9a-f]{8}$/
const DELIVERY_ID = /^[0-9a-f]{12}$/
/** `<owner>:<what>`, e.g. `coord:cc:1c7a9f`. */
const SOURCE = /^[a-z][a-z0-9-]{0,18}:[A-Za-z0-9._:@-]{1,100}$/
/** Sources Tether writes itself: a producer may not replace those lines. */
const RESERVED_SOURCES = ['lane:', 'wait:', 'run:', 'ask:', 'kind:', 'time:']
const ONE_LINE_BAD = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u
/** Most sessions one wake line may name as its senders. */
const MAX_FROM = 8
/** The longest a native puller's `GET …/due?wait=` holds. */
const DUE_POLL_MAX_SECONDS = 55
/** Delivery records older than this go. */
const KEEP_MS = 7 * 24 * 3600_000

export type DeliveryVia = 'paste' | 'turn' | 'native'
type DeliveryState = 'queued' | 'delivered' | 'dropped'

export interface Delivery {
  id: string
  sessionId: string
  source: string
  queuedAt: number
  deliveredAt: number | null
  via: DeliveryVia | null
}

interface RawDelivery {
  id: string
  session_id: string
  source: string
  queued_at: number
  delivered_at: number | null
  via: DeliveryVia | null
}

/** The deliveries table (schema v21): what became of each queued line. */
export class DeliveryLog {
  constructor(private readonly db: DatabaseSync) {}

  record(input: { id: string; sessionId: string; source: string; now: number }): void {
    this.db
      .prepare(
        `INSERT INTO deliveries (id, session_id, source, queued_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET queued_at = excluded.queued_at`,
      )
      .run(input.id, input.sessionId, input.source, input.now)
    this.db.prepare('DELETE FROM deliveries WHERE queued_at < ?').run(input.now - KEEP_MS)
  }

  /** Rows that went out: only those queued through this route are recorded. */
  delivered(rows: readonly Pick<Wake, 'id'>[], via: DeliveryVia, now: number): void {
    const update = this.db.prepare(
      'UPDATE deliveries SET delivered_at = ?, via = ? WHERE id = ? AND delivered_at IS NULL',
    )
    for (const row of rows) update.run(now, via, row.id)
  }

  get(id: string): Delivery | undefined {
    const raw = this.db.prepare('SELECT * FROM deliveries WHERE id = ?').get(id) as
      | RawDelivery
      | undefined
    return raw
      ? {
          id: raw.id,
          sessionId: raw.session_id,
          source: raw.source,
          queuedAt: raw.queued_at,
          deliveredAt: raw.delivered_at,
          via: raw.via,
        }
      : undefined
  }
}

/** A producer's line as queued: one line of at most `max` characters that
 * cannot start a slash command or a shell escape; null when it is not one. */
export function deliveryLine(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const line = value.trim()
  if (!line || Array.from(line).length > max || ONE_LINE_BAD.test(line)) return null
  if (/^[/!]/.test(line)) return null
  return line
}

export function deliverySource(value: unknown): string | null {
  if (typeof value !== 'string' || !SOURCE.test(value)) return null
  return RESERVED_SOURCES.some((prefix) => value.startsWith(prefix)) ? null : value
}

export interface DeliveryRouteDeps {
  log: () => DeliveryLog | null
  exists(id: string): boolean
  /** A session that takes delivery lines: an agent Tether delivers to. */
  receiver(id: string): boolean
  /** The longest line, in characters (the wake policy's note limit). */
  maxChars(): number
  /** Queue the line due now (coalesced by source while undelivered).
   * `reached`: it came from another session; `replyFrom`: the sessions whose
   * ride-along reply it carries. */
  queue(
    sessionId: string,
    source: string,
    line: string,
    ride: boolean,
    reach?: { reached: boolean; replyFrom: readonly string[] },
  ): Wake
  /** Sessions whose message this line carries (`from`): each acted on this
   * one, and `told` it something (a wake line that is not a reply). */
  sent(from: readonly string[], to: string, told: boolean): void
  /** A reply (`reply: true`, wake or ride-along) from each of `from`: what it
   * answers reached the replier (a lane's next went-idle line wakes). A
   * ride-along one also takes back the replier's "told" to this session. */
  replied?(from: readonly string[], to: string, ride: boolean): void
  /** Take the session's due ride-along lines now (WakeScheduler.takeRide). */
  takeRide(sessionId: string): string | null
  /** Its due ride-along lines and a token, left queued (WakeScheduler.peekRide). */
  peekRide(sessionId: string): { text: string; token: string } | null
  /** The client showed them: the token's rows go (WakeScheduler.confirmRide). */
  confirmRide(sessionId: string, token: string): number
  /** Take back the source's undelivered line(s) on the session. */
  withdraw(sessionId: string, source: string): { withdrawn: number; sending: boolean }
  /** Whether the queue still holds this row. */
  pending(id: string): boolean
  /** The native puller's long poll (WakeScheduler.pull). */
  pull(
    sessionId: string,
    ms: number,
    aborted: AbortSignal,
    alive: () => boolean,
  ): Promise<string | null>
  now(): number
}

function deliveryJson(delivery: Delivery, pending: boolean): Record<string, unknown> {
  const state: DeliveryState =
    delivery.deliveredAt !== null ? 'delivered' : pending ? 'queued' : 'dropped'
  return {
    id: delivery.id,
    sessionId: delivery.sessionId,
    source: delivery.source,
    state,
    queuedAt: delivery.queuedAt,
    deliveredAt: delivery.deliveredAt,
    via: delivery.via,
  }
}

/**
 * `POST /v1/sessions/:id/deliveries`, `GET /v1/deliveries/:deliveryId` and
 * `GET /v1/sessions/:id/due[?wait=N]` (docs/api-v1.md "Deliveries").
 */
export function registerDeliveryRoutes(router: Router, deps: DeliveryRouteDeps): void {
  const current = (): DeliveryLog => {
    const log = deps.log()
    if (!log) throw new HttpError(409, 'deliveries_unavailable')
    return log
  }
  const session = (id: string | undefined): string => {
    if (!id || !SESSION_ID.test(id) || !deps.exists(id)) throw new HttpError(404, 'not_found')
    return id
  }
  router
    .add('POST', '/v1/sessions/:id/deliveries', async (req, res, params) => {
      const id = session(params.id)
      const body = await readJsonObject(req)
      const unknown = Object.keys(body).filter(
        (key) => !['source', 'line', 'ride', 'from', 'reply'].includes(key),
      )
      if (unknown.length) throw new HttpError(400, 'invalid_body', { fields: unknown })
      const source = deliverySource(body.source)
      if (source === null)
        throw new HttpError(400, 'invalid_body', {
          field: 'source',
          detail: '<owner>:<what>, not one of Tether’s own (lane:, wait:, run:, ask:)',
        })
      const max = deps.maxChars()
      const line = deliveryLine(body.line, max)
      if (line === null)
        throw new HttpError(400, 'invalid_body', {
          field: 'line',
          detail: `one line, 1 to ${max} characters, not starting with / or !`,
        })
      if (body.ride !== undefined && typeof body.ride !== 'boolean')
        throw new HttpError(400, 'invalid_body', { field: 'ride', detail: 'true or false' })
      if (body.reply !== undefined && typeof body.reply !== 'boolean')
        throw new HttpError(400, 'invalid_body', { field: 'reply', detail: 'true or false' })
      const from = body.from
      if (
        from !== undefined &&
        !(
          Array.isArray(from) &&
          from.length <= MAX_FROM &&
          from.every((item) => typeof item === 'string' && SESSION_ID.test(item))
        )
      )
        throw new HttpError(400, 'invalid_body', {
          field: 'from',
          detail: `up to ${MAX_FROM} session ids`,
        })
      const log = current()
      if (!deps.receiver(id)) throw new HttpError(409, 'delivery_unsupported')
      const ride = body.ride === true
      const senders = Array.isArray(from) ? (from as string[]).filter((item) => item !== id) : []
      const wake = deps.queue(id, source, line, ride, {
        reached: senders.length > 0,
        replyFrom: ride && body.reply === true ? senders : [],
      })
      // Each sender of a wake line acted on this session (a session send, as
      // a root send records); one that is not a reply also told it (a lane
      // that messaged its launcher needs no went-idle line for the same
      // turn). An ack never counts as telling: it may come first in a turn of
      // work whose end the receiver still needs to hear. A ride-along line (an
      // FYI, a bare yes) records nothing: it would move a wait's default
      // `since` past a turn that wait still has to see end.
      if (Array.isArray(from) && from.length && !ride)
        deps.sent(from as string[], id, body.reply !== true)
      // A reply, a lane's ride-along yes included, shows that what it answers
      // reached the replier, maybe through an inbox it read itself. A
      // ride-along reply wakes no one, so the replier's went-idle line must
      // still go out (never dropped for a request it sent earlier that turn).
      if (Array.isArray(from) && from.length && body.reply === true)
        deps.replied?.(from as string[], id, ride)
      const fresh = log.get(wake.id) === undefined
      log.record({ id: wake.id, sessionId: id, source, now: deps.now() })
      sendJson(res, fresh ? 201 : 200, {
        ...deliveryJson(log.get(wake.id) as Delivery, true),
        coalesced: !fresh,
      })
    })
    .add('DELETE', '/v1/sessions/:id/deliveries', (_req, res, params, query) => {
      const id = session(params.id)
      const source = deliverySource(query.get('source'))
      if (source === null)
        throw new HttpError(400, 'invalid_query', {
          field: 'source',
          detail: '<owner>:<what>, not one of Tether’s own',
        })
      current()
      const { withdrawn, sending } = deps.withdraw(id, source)
      sendJson(res, 200, { sessionId: id, source, withdrawn, sending })
    })
    .add('DELETE', '/v1/sessions/:id/due', (_req, res, params, query) => {
      const id = session(params.id)
      const token = query.get('token')
      if (token === null || !RIDE_TOKEN.test(token))
        throw new HttpError(400, 'invalid_query', {
          field: 'token',
          detail: 'the token GET …/due?ride=peek answered',
        })
      if (!deps.receiver(id)) throw new HttpError(409, 'delivery_unsupported')
      sendJson(res, 200, { taken: deps.confirmRide(id, token) })
    })
    .add('GET', '/v1/deliveries/:deliveryId', (_req, res, params) => {
      const id = params.deliveryId
      const delivery = id && DELIVERY_ID.test(id) ? current().get(id) : undefined
      if (!delivery) throw new HttpError(404, 'not_found')
      sendJson(res, 200, deliveryJson(delivery, deps.pending(delivery.id)))
    })
    .add('GET', '/v1/sessions/:id/due', async (_req, res, params, query) => {
      const id = session(params.id)
      const ride = query.get('ride')
      if (ride !== null) {
        if ((ride !== '1' && ride !== 'peek') || query.get('wait') !== null)
          throw new HttpError(400, 'invalid_query', {
            field: 'ride',
            detail: '1 or peek, without wait',
          })
        if (!deps.receiver(id)) throw new HttpError(409, 'delivery_unsupported')
        if (ride === 'peek') {
          const peeked = deps.peekRide(id)
          sendJson(res, 200, { text: peeked?.text ?? null, token: peeked?.token ?? null })
        } else sendJson(res, 200, { text: deps.takeRide(id) })
        return
      }
      const raw = query.get('wait')
      let seconds = 0
      if (raw !== null) {
        seconds = Number(raw)
        if (!Number.isInteger(seconds) || seconds < 0 || seconds > DUE_POLL_MAX_SECONDS)
          throw new HttpError(400, 'invalid_query', { field: 'wait', max: DUE_POLL_MAX_SECONDS })
      }
      if (!deps.receiver(id)) throw new HttpError(409, 'delivery_unsupported')
      const abort = new AbortController()
      const onClose = () => abort.abort()
      res.on('close', onClose)
      try {
        const text = await deps.pull(
          id,
          seconds * 1000,
          abort.signal,
          () => !res.destroyed && res.writable,
        )
        if (!res.destroyed) sendJson(res, 200, { text: text || null })
      } finally {
        res.off('close', onClose)
      }
    })
}
