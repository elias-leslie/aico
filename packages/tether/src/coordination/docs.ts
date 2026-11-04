// Coordination documents (docs/api-v1.md "Coordination"): the one store for file
// leases, the agent identity registry and the handshake ledger (`st sessions
// send|ack|confirm`). A document is a JSON object under a name: a project id
// holds that project's leases and writer sets, `_coord` holds the identity
// registry, the handshake messages and the peer notes. Readers are aico-hook
// (Go), `aico lease|sessions` (the same binary), SummitFlow's `st` while it
// still has callers, and this daemon's reply waits.
//
// Writers take the document's lock first (POST .../lock), read, write with the
// token, then release: the exclusive flock the files used to have. A lock a
// crashed holder left goes after its ttl. This table is created here, not in a
// schema version: it is one self-contained table with no migration history.

import { randomBytes } from 'node:crypto'
import { HttpError, type Router, readJsonObject, sendJson } from '../http'
import type { Store } from '../store'

export const DOC_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/
/** A document may be larger than other API bodies: a busy project's writer sets. */
export const MAX_DOC_BYTES = 2 * 1024 * 1024
export const MAX_LOCK_WAIT_MS = 10_000
export const MAX_LOCK_TTL_MS = 10_000
const DEFAULT_LOCK_TTL_MS = 5_000

export interface CoordDoc {
  name: string
  /** 0 for a document nobody has written. */
  version: number
  doc: Record<string, unknown>
  updatedAt: number | null
}

interface Held {
  token: string
  expires: number
}

export class CoordinationDocs {
  private readonly held = new Map<string, Held>()
  private readonly waiting = new Map<string, Array<() => void>>()
  private readonly listeners: Array<(name: string) => void> = []

  /** Called after a document is written (the reply waits re-read the ledger). */
  onWrite(listener: (name: string) => void): void {
    this.listeners.push(listener)
  }

  constructor(
    private readonly db: Store['db'],
    private readonly now: () => number = Date.now,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS coord_docs (
        name       TEXT PRIMARY KEY CHECK(length(name) BETWEEN 1 AND 128),
        version    INTEGER NOT NULL,
        body       TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`)
  }

  names(): Array<{ name: string; version: number; updatedAt: number }> {
    return (
      this.db
        .prepare('SELECT name, version, updated_at FROM coord_docs ORDER BY name')
        .all() as Array<{ name: string; version: number; updated_at: number }>
    ).map((row) => ({ name: row.name, version: row.version, updatedAt: row.updated_at }))
  }

  get(name: string): CoordDoc {
    const row = this.db
      .prepare('SELECT version, body, updated_at FROM coord_docs WHERE name = ?')
      .get(name) as { version: number; body: string; updated_at: number } | undefined
    if (!row) return { name, version: 0, doc: {}, updatedAt: null }
    return { name, version: row.version, doc: JSON.parse(row.body), updatedAt: row.updated_at }
  }

  /** Replaces the document; `token` must be the lock's holder when the document is locked. */
  put(name: string, doc: Record<string, unknown>, token: string | null): number {
    const held = this.holder(name)
    if (held && held.token !== token) throw new HttpError(409, 'locked')
    const version = this.get(name).version + 1
    this.db
      .prepare(
        `INSERT INTO coord_docs (name, version, body, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET
           version = excluded.version, body = excluded.body, updated_at = excluded.updated_at`,
      )
      .run(name, version, JSON.stringify(doc), this.now())
    for (const listener of this.listeners) listener(name)
    return version
  }

  private holder(name: string): Held | undefined {
    const held = this.held.get(name)
    if (held && held.expires <= this.now()) {
      this.held.delete(name)
      return undefined
    }
    return held
  }

  /** Waits up to `waitMs` for the lock; null when it never came free. */
  async lock(name: string, waitMs: number, ttlMs: number): Promise<string | null> {
    const deadline = this.now() + waitMs
    for (;;) {
      if (!this.holder(name)) {
        const token = randomBytes(8).toString('hex')
        this.held.set(name, { token, expires: this.now() + ttlMs })
        return token
      }
      const left = deadline - this.now()
      if (left <= 0) return null
      await new Promise<void>((resolve) => {
        const queue = this.waiting.get(name) ?? []
        queue.push(resolve)
        this.waiting.set(name, queue)
        // The holder's ttl may run out with nobody to release it: look again by then.
        setTimeout(
          resolve,
          Math.min(left, (this.holder(name)?.expires ?? deadline) - this.now() + 1),
        ).unref()
      })
    }
  }

  unlock(name: string, token: string): boolean {
    const held = this.held.get(name)
    if (!held || held.token !== token) return false
    this.held.delete(name)
    for (const wake of this.waiting.get(name)?.splice(0) ?? []) wake()
    return true
  }
}

function boundedMs(value: unknown, fallback: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.min(Math.max(n, 0), max)
}

export function registerCoordinationRoutes(router: Router, docs: CoordinationDocs): void {
  const named = (name: string | undefined): string => {
    if (!name || !DOC_NAME.test(name)) throw new HttpError(400, 'invalid_name')
    return name
  }
  router
    .add('GET', '/v1/coordination/docs', (_req, res) => {
      sendJson(res, 200, { items: docs.names() })
    })
    .add('GET', '/v1/coordination/docs/:name', (_req, res, params) => {
      sendJson(res, 200, docs.get(named(params.name)))
    })
    .add('PUT', '/v1/coordination/docs/:name', async (req, res, params) => {
      const name = named(params.name)
      const body = await readJsonObject(req, MAX_DOC_BYTES)
      const doc = body.doc
      if (!doc || typeof doc !== 'object' || Array.isArray(doc))
        throw new HttpError(400, 'invalid_body', { field: 'doc' })
      const token = typeof body.lock === 'string' ? body.lock : null
      sendJson(res, 200, { name, version: docs.put(name, doc as Record<string, unknown>, token) })
    })
    .add('POST', '/v1/coordination/docs/:name/lock', async (req, res, params) => {
      const name = named(params.name)
      const body = await readJsonObject(req)
      const token = await docs.lock(
        name,
        boundedMs(body.waitMs, 0, MAX_LOCK_WAIT_MS),
        boundedMs(body.ttlMs, DEFAULT_LOCK_TTL_MS, MAX_LOCK_TTL_MS) || DEFAULT_LOCK_TTL_MS,
      )
      if (!token) throw new HttpError(423, 'lock_busy')
      sendJson(res, 200, { lock: token })
    })
    .add('DELETE', '/v1/coordination/docs/:name/lock', (_req, res, params, query) => {
      const released = docs.unlock(named(params.name), query.get('lock') ?? '')
      sendJson(res, 200, { released })
    })
}
