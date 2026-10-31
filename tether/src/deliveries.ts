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
// `DELETE /v1/sessions/:id/deliveries?source=` takes back a producer's line
// that has not gone out (it went stale: the inbox has nothing waiting any
// more); a paste already going out cannot be stopped and says so.

import type { DatabaseSync } from 'node:sqlite'
import { HttpError, type Router, readJsonObject, sendJson } from './http'
import type { Wake } from './wakes'

const SESSION_ID = /^[0-9a-f]{8}$/
const DELIVERY_ID = /^[0-9a-f]{12}$/
/** `<owner>:<what>`, e.g. `coord:cc:1c7a9f`. */
const SOURCE = /^[a-z][a-z0-9-]{0,18}:[A-Za-z0-9._:@-]{1,100}$/
/** Sources Tether writes itself: a producer may not replace those lines. */
const RESERVED_SOURCES = ['lane:', 'wait:', 'run:', 'ask:', 'kind:', 'time:']
const ONE_LINE_BAD = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u
/** The longest a native puller's `GET …/due?wait=` holds. */
export const DUE_POLL_MAX_SECONDS = 55
/** Delivery records older than this go. */
const KEEP_MS = 7 * 24 * 3600_000

export type DeliveryVia = 'paste' | 'turn' | 'native'
export type DeliveryState = 'queued' | 'delivered' | 'dropped'

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
  /** Queue the line due now (coalesced by source while undelivered). */
  queue(sessionId: string, source: string, line: string): Wake
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
      const unknown = Object.keys(body).filter((key) => key !== 'source' && key !== 'line')
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
      const log = current()
      if (!deps.receiver(id)) throw new HttpError(409, 'delivery_unsupported')
      const wake = deps.queue(id, source, line)
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
    .add('GET', '/v1/deliveries/:deliveryId', (_req, res, params) => {
      const id = params.deliveryId
      const delivery = id && DELIVERY_ID.test(id) ? current().get(id) : undefined
      if (!delivery) throw new HttpError(404, 'not_found')
      sendJson(res, 200, deliveryJson(delivery, deps.pending(delivery.id)))
    })
    .add('GET', '/v1/sessions/:id/due', async (_req, res, params, query) => {
      const id = session(params.id)
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
