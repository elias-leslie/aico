// The web app's own state (node:sqlite): which project each session it
// started belongs to, grouped as a project tab (a shell and an agent session
// toggled by `active_mode`), and each project's tab settings. Tether owns the
// sessions; losing this file loses only that grouping, never a session.
//
// Schema 2 makes this state syncable between doors: tabs, links and project
// settings carry the sync columns (`sync_at` is the hybrid-clock stamp, with
// `origin`, `prev`, `prev_origin`, `deleted`, `seq`), a delete is a tombstone that reads
// filter out, and `session_seen` carries `seq` (it merges by max). Nothing is
// deleted physically except by tombstone cleanup (sync/engine.ts).

import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { hostNameFrom } from './config'
import { HybridClock } from './hlc'
import { baseOf, type SyncHandle } from './sync/engine'
import { WEB_SYNC_TABLES } from './sync/registry'

export const SCHEMA_VERSION = 3

const SYNC_COLUMNS = (table: string) => `
  ALTER TABLE ${table} ADD COLUMN sync_at INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE ${table} ADD COLUMN origin  TEXT    NOT NULL DEFAULT '';
  ALTER TABLE ${table} ADD COLUMN prev    INTEGER;
  ALTER TABLE ${table} ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE ${table} ADD COLUMN seq     INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX IF NOT EXISTS ${table}_seq ON ${table} (seq);`

/** Changes after version 1, in order; `MIGRATIONS[n]` takes the file to version n + 1. Additive only. */
const MIGRATIONS: Record<number, string> = {
  1: `${SYNC_COLUMNS('panes')}
      ${SYNC_COLUMNS('session_links')}
      ${SYNC_COLUMNS('project_settings')}
      ALTER TABLE session_seen ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS session_seen_seq ON session_seen (seq);`,
  // `prev` now means the newest version by another host an edit is built on
  // (`baseOf`), so it needs that host's name. Older rows have none: no known base.
  2: `ALTER TABLE panes ADD COLUMN prev_origin TEXT;
      ALTER TABLE session_links ADD COLUMN prev_origin TEXT;
      ALTER TABLE project_settings ADD COLUMN prev_origin TEXT;`,
}

/**
 * A link to a tab that is deleted (or never arrived) is no link: another door
 * can link a session to a tab this one just deleted, and the rows meet in sync.
 * Reads skip it; the row stays, and shows again if the tab comes back.
 */
const LIVE_PANE = 'pane_id IN (SELECT id FROM panes WHERE deleted = 0)'

/** The columns the app has always read; the sync columns stay inside. */
const PANE_COLUMNS = 'id, project_id, name, active_mode, created_at'
const LINK_COLUMNS = 'session_id, pane_id, mode, display_order, created_at, last_accessed_at'

// Version 1 as first shipped; MIGRATIONS bring it (and a new file) to SCHEMA_VERSION.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- A project tab: the sessions of one project (or one ad hoc shell) shown together.
CREATE TABLE IF NOT EXISTS panes (
  id          TEXT PRIMARY KEY,
  project_id  TEXT,
  name        TEXT NOT NULL,
  active_mode TEXT NOT NULL DEFAULT 'shell',
  created_at  TEXT NOT NULL
);

-- One row per Tether session a tab shows.
CREATE TABLE IF NOT EXISTS session_links (
  session_id       TEXT PRIMARY KEY,
  pane_id          TEXT NOT NULL REFERENCES panes(id) ON DELETE CASCADE,
  mode             TEXT NOT NULL,
  display_order    INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  last_accessed_at TEXT
);
CREATE INDEX IF NOT EXISTS session_links_pane ON session_links(pane_id);

-- When the owner last had each session open in any browser or the phone app
-- (ms, this server's clock), so a session opened on one device does not read
-- "not opened yet" on another.
CREATE TABLE IF NOT EXISTS session_seen (
  session_id TEXT PRIMARY KEY,
  seen_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS project_settings (
  project_id    TEXT PRIMARY KEY,
  enabled       INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  display_order INTEGER NOT NULL DEFAULT 0,
  active_mode   TEXT NOT NULL DEFAULT 'shell',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
`

export interface Pane {
  id: string
  project_id: string | null
  name: string
  active_mode: string
  created_at: string
}

export interface Link {
  session_id: string
  pane_id: string
  mode: string
  display_order: number
  created_at: string
  last_accessed_at: string | null
}

export interface ProjectSettings {
  project_id: string
  enabled: boolean
  display_order: number
  active_mode: string
}

type Row = Record<string, unknown>

const now = () => new Date().toISOString()

/** Seen records kept, newest first: well past the sessions anyone lists. */
const SEEN_KEEP = 500

function pane(row: Row | undefined): Pane | null {
  return row ? (row as unknown as Pane) : null
}

function settings(row: Row): ProjectSettings {
  return {
    project_id: String(row.project_id),
    enabled: Number(row.enabled) === 1,
    display_order: Number(row.display_order),
    active_mode: String(row.active_mode),
  }
}

export interface WebStoreOptions {
  /** This host's name on rows it writes (`origin`); default AICO_HOST_NAME or the machine's. */
  hostName?: string
  /** The wall clock in ms; tests pass a fake. */
  now?: () => number
}

type Value = string | number | null

export class WebStore {
  private readonly db: DatabaseSync
  private readonly clock: HybridClock
  private readonly wall: () => number
  private depth = 0
  readonly hostName: string

  /** Opens (creating 0600 in a 0700 directory) and migrates; `':memory:'` for tests. */
  constructor(path: string, options: WebStoreOptions = {}) {
    this.hostName = options.hostName ?? hostNameFrom(process.env)
    this.wall = options.now ?? Date.now
    const fresh = path !== ':memory:' && !existsSync(path)
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    // No foreign keys: synced rows can arrive in any order, and the app keeps the links.
    this.db = new DatabaseSync(path, { enableForeignKeyConstraints: false })
    try {
      if (fresh) chmodSync(path, 0o600)
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 10000;')
      this.db.exec(SCHEMA)
      const version = this.meta('schema_version')
      if (version !== null && Number(version) > SCHEMA_VERSION)
        throw new Error(`${path} has schema ${version}, newer than this Aico (${SCHEMA_VERSION})`)
      this.clock = new HybridClock(Number(this.meta('hlc_last') ?? 0), this.wall)
      this.transaction(() => {
        if (this.meta('db_id') === null) this.setMeta('db_id', randomUUID())
        if (this.meta('seq') === null) this.setMeta('seq', '0')
        this.setMeta('host_name', this.hostName)
        // A new file starts at version 1 (SCHEMA above) and climbs like an old one.
        for (let from = Number(version ?? 1); from < SCHEMA_VERSION; from += 1) {
          this.db.exec(MIGRATIONS[from] as string)
          if (from === 1) this.backfillSync()
        }
        this.setMeta('schema_version', String(SCHEMA_VERSION))
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
   * saved in `meta` in the same transaction as the row. The `aico-web` CLI
   * writes this file from its own process, so the clock is re-read first.
   */
  private stamp(): { sync_at: number; origin: string; seq: number } {
    const seq = Number(this.meta('seq') ?? 0) + 1
    this.clock.observe(Number(this.meta('hlc_last') ?? 0))
    const at = this.clock.next()
    this.setMeta('seq', String(seq))
    this.setMeta('hlc_last', String(at))
    return { sync_at: at, origin: this.hostName, seq }
  }

  /** Rows that predate schema 2 get a stamp and a change number, so they sync like new ones. */
  private backfillSync(): void {
    const sources: [string, string, string][] = [
      ['panes', 'id', 'created_at'],
      ['session_links', 'session_id', 'created_at'],
      ['project_settings', 'project_id', 'updated_at'],
    ]
    for (const [table, key, when] of sources) {
      const rows = this.db
        .prepare(`SELECT ${key} AS k, ${when} AS w FROM ${table} ORDER BY ${when}, ${key}`)
        .all() as Row[]
      for (const row of rows) {
        const parsed = Date.parse(String(row.w))
        const stamp = this.stamp()
        this.db
          .prepare(`UPDATE ${table} SET sync_at = ?, origin = ?, seq = ? WHERE ${key} = ?`)
          .run(
            Number.isNaN(parsed) ? stamp.sync_at : parsed,
            stamp.origin,
            stamp.seq,
            row.k as string,
          )
      }
    }
    const seen = this.db
      .prepare('SELECT session_id FROM session_seen ORDER BY session_id')
      .all() as Row[]
    for (const row of seen)
      this.db
        .prepare('UPDATE session_seen SET seq = ? WHERE session_id = ?')
        .run(this.stamp().seq, row.session_id as string)
  }

  /** What the sync engine needs to read and write this file. */
  syncHandle(): SyncHandle {
    return {
      set: 'web',
      tables: WEB_SYNC_TABLES,
      hostName: this.hostName,
      db: this.db,
      now: () => this.wall(),
      schemaVersion: () => SCHEMA_VERSION,
      meta: (key) => this.meta(key),
      setMeta: (key, value) => this.setMeta(key, value),
      transaction: (work) => this.transaction(work),
      stamp: () => {
        const stamp = this.stamp()
        return { at: stamp.sync_at, origin: stamp.origin, seq: stamp.seq }
      },
      observe: (at) => {
        this.clock.observe(at)
        this.setMeta('hlc_last', String(this.clock.last))
      },
    }
  }

  /** Inserts a row with the sync columns of a new write. Call inside `transaction`. */
  private insertRow(table: string, fields: Record<string, Value>): void {
    const stamp = this.stamp()
    const all: Record<string, Value> = { ...fields, ...stamp, prev: null, deleted: 0 }
    const names = Object.keys(all)
    this.db
      .prepare(
        `INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
      )
      .run(...names.map((name) => all[name] as Value))
  }

  /**
   * Re-stamps one row with new values; `prev` is the base it is built on (`baseOf`).
   * Fields equal to what is stored change nothing (no new stamp). True when
   * the row changed. Call inside `transaction`.
   */
  private edit(
    table: string,
    keyColumn: string,
    key: string,
    fields: Record<string, Value>,
  ): boolean {
    const current = this.db.prepare(`SELECT * FROM ${table} WHERE ${keyColumn} = ?`).get(key) as
      | Row
      | undefined
    if (!current) return false
    const names = Object.keys(fields).filter((name) => current[name] !== fields[name])
    if (names.length === 0) return false
    const stamp = this.stamp()
    const base = baseOf(stamp.origin, current, current.sync_at)
    this.db
      .prepare(
        `UPDATE ${table} SET ${names.map((name) => `${name} = ?`).join(', ')},
           sync_at = ?, origin = ?, prev = ?, prev_origin = ?, seq = ? WHERE ${keyColumn} = ?`,
      )
      .run(
        ...names.map((name) => fields[name] as Value),
        stamp.sync_at,
        stamp.origin,
        base.prev,
        base.prev_origin,
        stamp.seq,
        key,
      )
    return true
  }

  // -- Tabs and links --------------------------------------------------------

  listPanes(): Pane[] {
    return this.db
      .prepare(`SELECT ${PANE_COLUMNS} FROM panes WHERE deleted = 0 ORDER BY created_at, id`)
      .all() as unknown as Pane[]
  }

  getPane(id: string): Pane | null {
    return pane(
      this.db.prepare(`SELECT ${PANE_COLUMNS} FROM panes WHERE id = ? AND deleted = 0`).get(id) as
        | Row
        | undefined,
    )
  }

  createPane(input: { projectId: string | null; name: string; activeMode: string }): Pane {
    const id = randomUUID()
    this.transaction(() =>
      this.insertRow('panes', {
        id,
        project_id: input.projectId,
        name: input.name,
        active_mode: input.activeMode,
        created_at: now(),
      }),
    )
    return this.getPane(id) as Pane
  }

  updatePane(id: string, fields: { name?: string; activeMode?: string }): Pane | null {
    this.transaction(() => {
      if (!this.getPane(id)) return
      const changes: Record<string, Value> = {}
      if (fields.name !== undefined) changes.name = fields.name
      if (fields.activeMode !== undefined) changes.active_mode = fields.activeMode
      this.edit('panes', 'id', id, changes)
    })
    return this.getPane(id)
  }

  /** Tombstones the tab and its links (never the sessions). */
  deletePane(id: string): boolean {
    return this.transaction(() => {
      if (!this.getPane(id)) return false
      for (const link of this.linksForPane(id))
        this.edit('session_links', 'session_id', link.session_id, { deleted: 1 })
      return this.edit('panes', 'id', id, { deleted: 1 })
    })
  }

  /** Tombstones tabs created before `cutoff` that show no session; returns how many. */
  deleteEmptyPanes(cutoff: Date): number {
    const empty = this.db
      .prepare(
        `SELECT id, created_at FROM panes p WHERE p.deleted = 0
         AND NOT EXISTS (SELECT 1 FROM session_links s WHERE s.pane_id = p.id AND s.deleted = 0)`,
      )
      .all() as Row[]
    let deleted = 0
    for (const row of empty) {
      const created = Date.parse(String(row.created_at))
      if (Number.isNaN(created) || created >= cutoff.getTime()) continue
      if (this.deletePane(String(row.id))) deleted += 1
    }
    return deleted
  }

  link(sessionId: string, paneId: string, mode: string): Link {
    this.transaction(() => {
      const at = now()
      const existing = this.db
        .prepare('SELECT deleted FROM session_links WHERE session_id = ?')
        .get(sessionId) as Row | undefined
      if (!existing)
        this.insertRow('session_links', {
          session_id: sessionId,
          pane_id: paneId,
          mode,
          display_order: 0,
          created_at: at,
          last_accessed_at: at,
        })
      else if (Number(existing.deleted) === 1)
        this.edit('session_links', 'session_id', sessionId, {
          pane_id: paneId,
          mode,
          deleted: 0,
          display_order: 0,
          created_at: at,
          last_accessed_at: at,
        })
      else this.edit('session_links', 'session_id', sessionId, { pane_id: paneId, mode })
    })
    return this.getLink(sessionId) as Link
  }

  unlink(sessionId: string): boolean {
    return this.transaction(
      () =>
        this.getLink(sessionId) !== null &&
        this.edit('session_links', 'session_id', sessionId, { deleted: 1 }),
    )
  }

  getLink(sessionId: string): Link | null {
    const row = this.db
      .prepare(
        `SELECT ${LINK_COLUMNS} FROM session_links WHERE session_id = ? AND deleted = 0 AND ${LIVE_PANE}`,
      )
      .get(sessionId)
    return (row as unknown as Link | undefined) ?? null
  }

  listLinks(): Link[] {
    return this.db
      .prepare(
        `SELECT ${LINK_COLUMNS} FROM session_links WHERE deleted = 0 AND ${LIVE_PANE} ORDER BY pane_id, mode`,
      )
      .all() as unknown as Link[]
  }

  linksForPane(paneId: string): Link[] {
    return this.db
      .prepare(
        `SELECT ${LINK_COLUMNS} FROM session_links WHERE pane_id = ? AND deleted = 0 AND ${LIVE_PANE} ORDER BY mode`,
      )
      .all(paneId) as unknown as Link[]
  }

  updateLink(sessionId: string, fields: { mode?: string; displayOrder?: number }): void {
    this.transaction(() => {
      if (!this.getLink(sessionId)) return
      const changes: Record<string, Value> = {}
      if (fields.mode !== undefined) changes.mode = fields.mode
      if (fields.displayOrder !== undefined) changes.display_order = fields.displayOrder
      this.edit('session_links', 'session_id', sessionId, changes)
    })
  }

  /** Not a synced change: opening a session must not make every door re-send its tab. */
  touchLink(sessionId: string): void {
    this.db
      .prepare('UPDATE session_links SET last_accessed_at = ? WHERE session_id = ? AND deleted = 0')
      .run(now(), sessionId)
  }

  /** Record that the owner has these sessions open at `at`; keeps the newest `keep`. */
  markSeen(sessionIds: readonly string[], at: number, keep = SEEN_KEEP): void {
    this.transaction(() => {
      const current = this.db.prepare('SELECT seen_at FROM session_seen WHERE session_id = ?')
      const upsert = this.db.prepare(
        `INSERT INTO session_seen (session_id, seen_at, seq) VALUES (?, ?, ?)
         ON CONFLICT (session_id) DO UPDATE SET seen_at = excluded.seen_at, seq = excluded.seq`,
      )
      for (const id of sessionIds) {
        const row = current.get(id) as Row | undefined
        if (!row || at > Number(row.seen_at)) upsert.run(id, at, this.stamp().seq)
      }
      this.db
        .prepare(
          'DELETE FROM session_seen WHERE session_id NOT IN (SELECT session_id FROM session_seen ORDER BY seen_at DESC LIMIT ?)',
        )
        .run(keep)
    })
  }

  /** When each session was last open anywhere (ms). */
  seenAt(): Map<string, number> {
    const rows = this.db.prepare('SELECT session_id, seen_at FROM session_seen').all() as Row[]
    return new Map(rows.map((row) => [String(row.session_id), Number(row.seen_at)]))
  }

  // -- Project settings --------------------------------------------------------

  allProjectSettings(): Map<string, ProjectSettings> {
    const rows = this.db.prepare('SELECT * FROM project_settings WHERE deleted = 0').all() as Row[]
    return new Map(rows.map((row) => [String(row.project_id), settings(row)]))
  }

  /** Tombstones the settings of projects not in `projectIds` (never all of them: an empty list prunes nothing). */
  pruneProjectSettings(projectIds: ReadonlySet<string>): number {
    if (projectIds.size === 0) return 0
    return this.transaction(() => {
      let deleted = 0
      for (const id of this.allProjectSettings().keys())
        if (!projectIds.has(id) && this.edit('project_settings', 'project_id', id, { deleted: 1 }))
          deleted += 1
      return deleted
    })
  }

  /** Create or update; only the given fields change on an existing row. */
  upsertProjectSettings(
    projectId: string,
    fields: { enabled?: boolean; activeMode?: string; displayOrder?: number },
  ): ProjectSettings {
    this.transaction(() => {
      const at = now()
      const existing = this.db
        .prepare('SELECT deleted FROM project_settings WHERE project_id = ?')
        .get(projectId) as Row | undefined
      const fresh = {
        enabled: fields.enabled ? 1 : 0,
        display_order: fields.displayOrder ?? 0,
        active_mode: fields.activeMode ?? 'shell',
      }
      if (!existing)
        this.insertRow('project_settings', {
          project_id: projectId,
          ...fresh,
          created_at: at,
          updated_at: at,
        })
      else if (Number(existing.deleted) === 1)
        this.edit('project_settings', 'project_id', projectId, {
          ...fresh,
          deleted: 0,
          created_at: at,
          updated_at: at,
        })
      else {
        const changes: Record<string, Value> = {}
        if (fields.enabled !== undefined) changes.enabled = fields.enabled ? 1 : 0
        if (fields.displayOrder !== undefined) changes.display_order = fields.displayOrder
        if (fields.activeMode !== undefined) changes.active_mode = fields.activeMode
        if (this.edit('project_settings', 'project_id', projectId, changes))
          this.db
            .prepare('UPDATE project_settings SET updated_at = ? WHERE project_id = ?')
            .run(at, projectId)
      }
    })
    return settings(
      this.db.prepare('SELECT * FROM project_settings WHERE project_id = ?').get(projectId) as Row,
    )
  }
}
