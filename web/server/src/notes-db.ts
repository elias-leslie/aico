// The durable notes and captures store (node:sqlite), beside web.db. Rows are
// sync-shaped from the start: every write stamps `updated_at` (a hybrid
// logical clock), `origin` (this host), `prev` and `prev_origin` (the newest
// version by another host the edit is built on, see `baseOf`), `seq` (a
// per-database change counter), and a delete is a tombstone.

import { randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CaptureKind } from './capture-files'
import { HybridClock } from './hlc'
import { NoteStore } from './notes-data'
import { baseOf, type SyncHandle } from './sync/engine'
import { NOTES_SYNC_TABLES } from './sync/registry'

export const SCHEMA_VERSION = 5

/** Which column names the note a synced row belongs to (to refresh its search entry). */
const NOTE_ID_COLUMN: Record<string, string> = {
  notes: 'id',
  note_items: 'note_id',
  note_labels: 'note_id',
  attachments: 'note_id',
}

/** Changes after version 1, in order; `MIGRATIONS[n]` takes the file to version n + 1. */
const MIGRATIONS: Record<number, string> = {
  1: `ALTER TABLE captures ADD COLUMN extract_json  TEXT;
      ALTER TABLE captures ADD COLUMN extract_route TEXT;
      ALTER TABLE captures ADD COLUMN extract_error TEXT;`,
  2: `ALTER TABLE captures ADD COLUMN owner       TEXT;
      ALTER TABLE captures ADD COLUMN owner_ref   TEXT;
      ALTER TABLE captures ADD COLUMN route_state TEXT
        CHECK (route_state IS NULL OR route_state IN
          ('suggested','confirmed','filed','waiting','failed','kept'));
      ALTER TABLE captures ADD COLUMN route_note  TEXT;
      CREATE INDEX IF NOT EXISTS captures_route ON captures (route_state);`,
  3: `CREATE TABLE IF NOT EXISTS notes (
        id          TEXT PRIMARY KEY,
        kind        TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note','list','prompt')),
        title       TEXT NOT NULL DEFAULT '',
        body        TEXT NOT NULL DEFAULT '',
        pinned      INTEGER NOT NULL DEFAULT 0,
        archived    INTEGER NOT NULL DEFAULT 0,
        scope       TEXT,
        source      TEXT,
        created_at  INTEGER NOT NULL,
        edited_at   INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        origin      TEXT NOT NULL,
        prev        INTEGER,
        deleted     INTEGER NOT NULL DEFAULT 0,
        seq         INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS notes_source ON notes (source) WHERE source IS NOT NULL;
      CREATE INDEX IF NOT EXISTS notes_list ON notes (deleted, archived, pinned, edited_at DESC);
      CREATE INDEX IF NOT EXISTS notes_seq ON notes (seq);
      CREATE TABLE IF NOT EXISTS note_items (
        id          TEXT PRIMARY KEY,
        note_id     TEXT NOT NULL,
        text        TEXT NOT NULL,
        checked     INTEGER NOT NULL DEFAULT 0,
        position    REAL NOT NULL,
        hint        TEXT,
        updated_at  INTEGER NOT NULL,
        origin      TEXT NOT NULL,
        prev        INTEGER,
        deleted     INTEGER NOT NULL DEFAULT 0,
        seq         INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS note_items_note ON note_items (note_id, deleted, position);
      CREATE INDEX IF NOT EXISTS note_items_seq ON note_items (seq);
      CREATE TABLE IF NOT EXISTS note_labels (
        id          TEXT PRIMARY KEY,
        note_id     TEXT NOT NULL,
        label       TEXT NOT NULL,
        updated_at  INTEGER NOT NULL,
        origin      TEXT NOT NULL,
        prev        INTEGER,
        deleted     INTEGER NOT NULL DEFAULT 0,
        seq         INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS note_labels_note ON note_labels (note_id, deleted);
      CREATE INDEX IF NOT EXISTS note_labels_label ON note_labels (label COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS note_labels_seq ON note_labels (seq);
      CREATE TABLE IF NOT EXISTS attachments (
        id          TEXT PRIMARY KEY,
        note_id     TEXT NOT NULL,
        capture_id  TEXT,
        hash        TEXT NOT NULL,
        name        TEXT NOT NULL,
        mime        TEXT NOT NULL,
        size        INTEGER NOT NULL,
        position    REAL NOT NULL,
        updated_at  INTEGER NOT NULL,
        origin      TEXT NOT NULL,
        prev        INTEGER,
        deleted     INTEGER NOT NULL DEFAULT 0,
        seq         INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS attachments_note ON attachments (note_id, deleted, position);
      CREATE INDEX IF NOT EXISTS attachments_hash ON attachments (hash);
      CREATE INDEX IF NOT EXISTS attachments_seq ON attachments (seq);
      CREATE TABLE IF NOT EXISTS note_revisions (
        id          TEXT PRIMARY KEY,
        table_name  TEXT NOT NULL,
        row_id      TEXT NOT NULL,
        field       TEXT NOT NULL,
        text        TEXT NOT NULL,
        saved_at    INTEGER NOT NULL,
        reason      TEXT NOT NULL CHECK (reason IN ('conflict','edit')),
        updated_at  INTEGER NOT NULL,
        origin      TEXT NOT NULL,
        prev        INTEGER,
        deleted     INTEGER NOT NULL DEFAULT 0,
        seq         INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS note_revisions_row ON note_revisions (table_name, row_id, field, saved_at);
      CREATE INDEX IF NOT EXISTS note_revisions_seq ON note_revisions (seq);`,
  // `prev` now means the newest version by another host an edit is built on,
  // so it needs that host's name. Rows made before it have none and read as
  // "no known base" (nothing synced before this).
  4: `ALTER TABLE captures ADD COLUMN prev_origin TEXT;
      ALTER TABLE notes ADD COLUMN prev_origin TEXT;
      ALTER TABLE note_items ADD COLUMN prev_origin TEXT;
      ALTER TABLE note_labels ADD COLUMN prev_origin TEXT;
      ALTER TABLE attachments ADD COLUMN prev_origin TEXT;
      ALTER TABLE note_revisions ADD COLUMN prev_origin TEXT;`,
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS captures (
  id          TEXT PRIMARY KEY,
  client_id   TEXT NOT NULL UNIQUE,
  group_id    TEXT,
  ask_id      TEXT,
  kind        TEXT NOT NULL CHECK (kind IN ('image','pdf','doc','text','audio')),
  name        TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  hash        TEXT,
  caption     TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'new'
                CHECK (status IN ('new','extracting','ready','failed','filed')),
  type        TEXT,
  text        TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  origin      TEXT NOT NULL,
  prev        INTEGER,
  deleted     INTEGER NOT NULL DEFAULT 0,
  seq         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS captures_created ON captures (deleted, created_at DESC);
CREATE INDEX IF NOT EXISTS captures_ask ON captures (ask_id);
CREATE INDEX IF NOT EXISTS captures_seq ON captures (seq);
`

export const CAPTURE_STATUSES = ['new', 'extracting', 'ready', 'failed', 'filed'] as const
export type CaptureStatus = (typeof CAPTURE_STATUSES)[number]

/**
 * Where a capture is on its way to an owner: `suggested` (waiting for a tap, or
 * for the owner to exist), `confirmed` (being sent), `waiting` (the owner is
 * unreachable), `failed` (the owner refused it), `filed` (handed off) or `kept`
 * (the owner chose to keep it here). Null: nothing was suggested.
 */
export const ROUTE_STATES = [
  'suggested',
  'confirmed',
  'filed',
  'waiting',
  'failed',
  'kept',
] as const
export type RouteState = (typeof ROUTE_STATES)[number]

/** What the router decided for a capture that was just read. */
export interface RoutePlan {
  owner: string
  state: RouteState
  note: string | null
}

export interface CaptureRow {
  id: string
  client_id: string
  group_id: string | null
  ask_id: string | null
  kind: CaptureKind
  name: string
  mime: string
  size: number
  hash: string | null
  caption: string
  status: CaptureStatus
  type: string | null
  text: string | null
  created_at: number
  updated_at: number
  origin: string
  prev: number | null
  prev_origin: string | null
  deleted: number
  seq: number
  /** The validated JSON the reader returned (a string), or null. */
  extract_json: string | null
  /** Which route read it (`agy`, `ollama`), or null. */
  extract_route: string | null
  /** Why the last read failed, in plain words; null once it works. */
  extract_error: string | null
  /** Who takes this kind of capture (`portfolio-ai`, `notes`), or null. */
  owner: string | null
  /** The owner's id for it once handed off (portfolio-ai's capture id). */
  owner_ref: string | null
  route_state: RouteState | null
  /** A plain sentence about the route: why it waits or failed, or what is not built yet. */
  route_note: string | null
}

export interface NewCapture {
  clientId: string
  groupId?: string | null
  askId?: string | null
  kind: CaptureKind
  name: string
  mime: string
  size: number
  hash: string
  caption?: string
}

export interface CaptureQuery {
  status?: CaptureStatus
  ask?: string
  limit?: number
  /** Older than this: a capture id, or a created-at in ms. */
  before?: string
}

interface Stamp {
  updated_at: number
  origin: string
  seq: number
}

type Row = Record<string, unknown>

export interface NotesStoreOptions {
  /** The host that writes these rows (`origin`). */
  hostName: string
  /** The wall clock in ms; tests pass a fake. */
  now?: () => number
  /** Least time between two kept revisions of one note field (default: config). */
  revisionWindowMs?: number
  /** false: search notes with LIKE even where SQLite has FTS5 (tests). */
  fts?: boolean
}

export class NotesStore {
  private readonly db: DatabaseSync
  private readonly clock: HybridClock
  private readonly now: () => number
  private depth = 0
  readonly hostName: string
  /** Notes, items, labels, attachments and revisions. */
  readonly notes: NoteStore

  /** Opens (creating 0600 in a 0700 directory) and migrates; `':memory:'` for tests. */
  constructor(path: string, options: NotesStoreOptions) {
    this.hostName = options.hostName
    this.now = options.now ?? Date.now
    const fresh = path !== ':memory:' && !existsSync(path)
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    try {
      if (fresh) chmodSync(path, 0o600)
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 10000;')
      this.db.exec(SCHEMA)
      const version = this.meta('schema_version')
      if (version !== null && Number(version) > SCHEMA_VERSION)
        throw new Error(`${path} has schema ${version}, newer than this Aico (${SCHEMA_VERSION})`)
      this.transaction(() => {
        // A new file starts at version 1 (SCHEMA above) and climbs like an old one.
        for (let from = Number(version ?? 1); from < SCHEMA_VERSION; from += 1)
          this.db.exec(MIGRATIONS[from] as string)
        this.setMeta('schema_version', String(SCHEMA_VERSION))
        if (this.meta('db_id') === null) this.setMeta('db_id', randomUUID())
        if (this.meta('seq') === null) this.setMeta('seq', '0')
        this.setMeta('host_name', this.hostName)
      })
    } catch (error) {
      this.db.close()
      throw error
    }
    this.clock = new HybridClock(Number(this.meta('hlc_last') ?? 0), this.now)
    try {
      this.notes = new NoteStore({
        db: this.db,
        transaction: (work) => this.transaction(work),
        stamp: () => this.stamp(),
        now: () => this.now(),
        revisionWindowMs: options.revisionWindowMs,
        fts: options.fts,
      })
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  close(): void {
    this.db.close()
  }

  meta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as Row | undefined
    return row ? String(row.value) : null
  }

  private setMeta(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value)
  }

  /** One transaction; a call made inside another joins it (and rolls back with it). */
  private transaction<T>(work: () => T): T {
    if (this.depth > 0) return work()
    this.depth += 1
    this.db.exec('BEGIN IMMEDIATE')
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

  /**
   * The sync columns for one write: the next change number and clock value,
   * saved in `meta` in the same transaction as the row. Call inside `transaction`.
   */
  private stamp(): Stamp {
    const seq = Number(this.meta('seq') ?? 0) + 1
    const updatedAt = this.clock.next()
    this.setMeta('seq', String(seq))
    this.setMeta('hlc_last', String(updatedAt))
    return { updated_at: updatedAt, origin: this.hostName, seq }
  }

  /** Moves the clock past a stamp seen from a peer (sync), and remembers it. */
  observe(remote: number): void {
    this.clock.observe(remote)
    this.setMeta('hlc_last', String(this.clock.last))
  }

  /** What the sync engine needs to read and write this file. */
  syncHandle(): SyncHandle {
    return {
      set: 'notes',
      tables: NOTES_SYNC_TABLES,
      hostName: this.hostName,
      db: this.db,
      now: () => this.now(),
      schemaVersion: () => SCHEMA_VERSION,
      meta: (key) => this.meta(key),
      setMeta: (key, value) => this.setMeta(key, value),
      transaction: (work) => this.transaction(work),
      stamp: () => {
        const stamp = this.stamp()
        return { at: stamp.updated_at, origin: stamp.origin, seq: stamp.seq }
      },
      observe: (at) => this.observe(at),
      saveRevision: (revision) => this.notes.addConflictRevision(revision),
      afterApply: (touched) =>
        this.notes.reindexNotes(
          touched.flatMap(({ table, row }) => {
            const id = row[NOTE_ID_COLUMN[table] ?? '']
            return typeof id === 'string' ? [id] : []
          }),
        ),
    }
  }

  // -- Captures -----------------------------------------------------------------

  /**
   * Adds a capture. The same `clientId` again returns the row already stored
   * (`created: false`), so a retried upload never duplicates.
   */
  insertCapture(input: NewCapture): { capture: CaptureRow; created: boolean } {
    return this.transaction(() => {
      const existing = this.db
        .prepare('SELECT * FROM captures WHERE client_id = ?')
        .get(input.clientId) as Row | undefined
      if (existing) return { capture: existing as unknown as CaptureRow, created: false }
      const stamp = this.stamp()
      const id = randomBytes(6).toString('hex')
      this.db
        .prepare(
          `INSERT INTO captures
             (id, client_id, group_id, ask_id, kind, name, mime, size, hash, caption,
              created_at, updated_at, origin, prev, deleted, seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?)`,
        )
        .run(
          id,
          input.clientId,
          input.groupId ?? null,
          input.askId ?? null,
          input.kind,
          input.name,
          input.mime,
          input.size,
          input.hash,
          input.caption ?? '',
          this.now(),
          stamp.updated_at,
          stamp.origin,
          stamp.seq,
        )
      return { capture: this.requireCapture(id), created: true }
    })
  }

  private requireCapture(id: string): CaptureRow {
    return this.db.prepare('SELECT * FROM captures WHERE id = ?').get(id) as unknown as CaptureRow
  }

  /** The capture a browser's `client_id` already made, tombstone or not. */
  findByClientId(clientId: string): CaptureRow | null {
    const row = this.db.prepare('SELECT * FROM captures WHERE client_id = ?').get(clientId)
    return (row as unknown as CaptureRow | undefined) ?? null
  }

  /** One capture; a tombstone reads as missing unless `includeDeleted`. */
  getCapture(id: string, includeDeleted = false): CaptureRow | null {
    const row = this.db.prepare('SELECT * FROM captures WHERE id = ?').get(id) as unknown as
      | CaptureRow
      | undefined
    return row && (includeDeleted || !row.deleted) ? row : null
  }

  /** Newest first, tombstones hidden. `total` counts every match, not just this page. */
  listCaptures(query: CaptureQuery = {}): { captures: CaptureRow[]; total: number } {
    const where = ['deleted = 0']
    const args: (string | number)[] = []
    if (query.status) {
      where.push('status = ?')
      args.push(query.status)
    }
    if (query.ask) {
      where.push('ask_id = ?')
      args.push(query.ask)
    }
    const total = Number(
      (
        this.db
          .prepare(`SELECT count(*) AS n FROM captures WHERE ${where.join(' AND ')}`)
          .get(...args) as Row
      ).n,
    )
    if (query.before !== undefined) {
      // A created-at in ms has 13 digits; a capture id is 12 hex, and one made only of digits is still an id.
      if (/^[0-9]{13,}$/.test(query.before)) {
        where.push('created_at < ?')
        args.push(Number(query.before))
      } else {
        const anchor = this.getCapture(query.before, true)
        if (anchor) {
          where.push('(created_at, id) < (?, ?)')
          args.push(anchor.created_at, anchor.id)
        } else where.push('0') // an unknown anchor ends the paging
      }
    }
    const limit = Math.min(Math.max(Math.trunc(query.limit ?? 50), 1), 200)
    const captures = this.db
      .prepare(
        `SELECT * FROM captures WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...args, limit) as unknown as CaptureRow[]
    return { captures, total }
  }

  /** Live captures that share a `group_id`. */
  countInGroup(groupId: string): number {
    return Number(
      (
        this.db
          .prepare('SELECT count(*) AS n FROM captures WHERE group_id = ? AND deleted = 0')
          .get(groupId) as Row
      ).n,
    )
  }

  /** Live captures of one upload batch, oldest first. */
  capturesInGroup(groupId: string): CaptureRow[] {
    return this.db
      .prepare('SELECT * FROM captures WHERE group_id = ? AND deleted = 0 ORDER BY created_at, id')
      .all(groupId) as unknown as CaptureRow[]
  }

  /** The captures that answer an ask, oldest first (tombstones left out). */
  capturesForAsk(askId: string): CaptureRow[] {
    return this.db
      .prepare('SELECT * FROM captures WHERE ask_id = ? AND deleted = 0 ORDER BY created_at, id')
      .all(askId) as unknown as CaptureRow[]
  }

  /** Re-stamps a live capture with new field values; `prev` is the version it was based on. */
  private edit(id: string, fields: Record<string, string | number | null>): CaptureRow | null {
    return this.transaction(() => this.editNow(id, fields))
  }

  /** `edit` without its own transaction, for callers that hold one. */
  private editNow(id: string, fields: Record<string, string | number | null>): CaptureRow | null {
    const current = this.getCapture(id)
    if (!current) return null
    const stamp = this.stamp()
    const base = baseOf(stamp.origin, current, current.updated_at)
    const names = Object.keys(fields)
    this.db
      .prepare(
        `UPDATE captures SET ${names.map((name) => `${name} = ?`).join(', ')},
           updated_at = ?, origin = ?, prev = ?, prev_origin = ?, seq = ? WHERE id = ?`,
      )
      .run(
        ...names.map((name) => fields[name] as string | number | null),
        stamp.updated_at,
        stamp.origin,
        base.prev,
        base.prev_origin,
        stamp.seq,
        id,
      )
    return this.requireCapture(id)
  }

  updateCaption(id: string, caption: string): CaptureRow | null {
    return this.edit(id, { caption })
  }

  /** Marks the capture deleted. The blob stays until the sync-aware cleanup. */
  tombstoneCapture(id: string): boolean {
    return this.edit(id, { deleted: 1 }) !== null
  }

  // -- Reading text out of captures (vision-extract) ------------------------------

  /**
   * Takes the oldest `new` capture made on this host and marks it `extracting`
   * (its `updated_at` is then when reading started). Null when there is none.
   */
  claimForExtraction(): CaptureRow | null {
    return this.transaction(() => {
      const next = this.db
        .prepare(
          `SELECT id FROM captures WHERE status = 'new' AND deleted = 0 AND origin = ?
           ORDER BY created_at, id LIMIT 1`,
        )
        .get(this.hostName) as Row | undefined
      if (!next) return null
      return this.editNow(String(next.id), { status: 'extracting', extract_error: null })
    })
  }

  /** Puts `extracting` captures of this host back to `new` (a restart cut them short). */
  requeueExtracting(): number {
    return this.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT id FROM captures WHERE status = 'extracting' AND deleted = 0 AND origin = ?`,
        )
        .all(this.hostName) as Row[]
      for (const row of rows) this.editNow(String(row.id), { status: 'new' })
      return rows.length
    })
  }

  /** Saves what was read and marks the capture `ready`. Only an `extracting` capture takes it. */
  finishExtraction(
    id: string,
    result: { type: string | null; text: string | null; json: string | null; route: string | null },
    plan: RoutePlan | null = null,
  ): CaptureRow | null {
    return this.transaction(() =>
      this.getCapture(id)?.status === 'extracting'
        ? this.editNow(id, {
            status: 'ready',
            type: result.type,
            text: result.text,
            extract_json: result.json,
            extract_route: result.route,
            extract_error: null,
            owner: plan?.owner ?? null,
            route_state: plan?.state ?? null,
            route_note: plan?.note ?? null,
          })
        : null,
    )
  }

  /** Marks an `extracting` capture `failed` with a short plain reason. */
  failExtraction(id: string, reason: string): CaptureRow | null {
    return this.transaction(() =>
      this.getCapture(id)?.status === 'extracting'
        ? this.editNow(id, { status: 'failed', extract_error: reason })
        : null,
    )
  }

  /** Puts a `failed` capture back to `new` so it is read again. Null for any other status. */
  retryExtraction(id: string): CaptureRow | null {
    return this.transaction(() =>
      this.getCapture(id)?.status === 'failed'
        ? this.editNow(id, { status: 'new', extract_error: null })
        : null,
    )
  }

  // -- Routing to owners (the capture router) -------------------------------------

  /**
   * Moves a live capture's route from one of the `from` states to `fields`
   * (`route_state` is required). Null when it is gone or in another state, so a
   * double tap or a late retry changes nothing.
   */
  transitionRoute(
    id: string,
    from: readonly (RouteState | null)[],
    fields: { route_state: RouteState } & Record<string, string | number | null>,
  ): CaptureRow | null {
    return this.transaction(() => {
      const current = this.getCapture(id)
      return current && from.includes(current.route_state) ? this.editNow(id, fields) : null
    })
  }

  /**
   * Records the hand-off: `filed`, the owner's id for it, and, unless the type
   * keeps a copy, the file, text and reading are dropped (`hash` becomes NULL;
   * the caller removes the blob files).
   */
  fileCapture(id: string, ownerRef: string, purge: boolean): CaptureRow | null {
    return this.transitionRoute(id, ['confirmed', 'waiting', 'failed'], {
      status: 'filed',
      route_state: 'filed',
      owner_ref: ownerRef,
      route_note: null,
      ...(purge ? { hash: null, text: null, extract_json: null } : {}),
    })
  }

  /** Captures of this host in the middle of a hand-off (`waiting`, or `confirmed` and cut short), oldest first. */
  pendingRoutes(): CaptureRow[] {
    return this.db
      .prepare(
        `SELECT * FROM captures WHERE route_state IN ('waiting','confirmed') AND deleted = 0
           AND origin = ? ORDER BY created_at, id`,
      )
      .all(this.hostName) as unknown as CaptureRow[]
  }

  /** How many captures and note attachments (tombstones too) still point at this blob. */
  countHashRefs(hash: string): number {
    return (
      Number(
        (this.db.prepare('SELECT count(*) AS n FROM captures WHERE hash = ?').get(hash) as Row).n,
      ) + this.notes.countHashRefs(hash)
    )
  }
}
