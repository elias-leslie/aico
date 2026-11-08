// Coordination documents (docs/api-v1.md "Coordination"): the one store for file
// leases, the agent identity registry and the handshake ledger (`st sessions
// send|ack|confirm`). A document is a JSON object under a name: a project id
// holds that project's leases and writer sets, `_coord` holds the identity
// registry, the handshake messages and the peer notes. Readers are aico-hook
// (Go), `aico lease|sessions` (the same binary), SummitFlow's `st` while it
// still has callers, and this daemon's reply waits.
//
// A writer reads the document with its version, then writes back with that version (compare-and-set): a
// write over a version someone else has saved since is refused with 409 version_conflict and the current
// version, and the writer re-reads and tries again. Nothing is held between the read and the write, so a
// caller that gives up or dies leaves nothing behind, and no update is lost. This table is created here, not
// in a schema version: it is one self-contained table with no migration history.

import type { Store } from '@aico/session-engine/store'
import { HttpError, type Router, readJsonObject, sendJson } from '@aico/shared/http'

const DOC_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/
/** A document may be larger than other API bodies: a busy project's writer sets. */
const MAX_DOC_BYTES = 2 * 1024 * 1024

export interface CoordDoc {
  name: string
  /** 0 for a document nobody has written. */
  version: number
  doc: Record<string, unknown>
  updatedAt: number | null
}

export class CoordinationDocs {
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

  /**
   * Replaces the document when it is still at `expected`, the version the writer read (0 for a document
   * nobody has written); otherwise 409 version_conflict with the current version. The check and the write
   * run in one synchronous step, so two writers that read the same version cannot both win.
   */
  put(name: string, doc: Record<string, unknown>, expected: number): number {
    const current = this.get(name).version
    if (current !== expected) throw new HttpError(409, 'version_conflict', { version: current })
    const version = current + 1
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
      const expected = body.version
      if (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 0)
        throw new HttpError(400, 'invalid_body', { field: 'version' })
      sendJson(res, 200, {
        name,
        version: docs.put(name, doc as Record<string, unknown>, expected),
      })
    })
}
