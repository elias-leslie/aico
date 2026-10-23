// The web app's own state (node:sqlite): which project each session it
// started belongs to, grouped as a project tab (a shell and an agent session
// toggled by `active_mode`), and each project's tab settings. Tether owns the
// sessions; losing this file loses only that grouping, never a session.
//
// The first open imports the Python backend's a-term.db once (read-only).

import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const SCHEMA_VERSION = 1

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

export interface ImportResult {
  source: string
  projects: number
  panes: number
  links: number
}

type Row = Record<string, unknown>

const now = () => new Date().toISOString()

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

export class WebStore {
  private readonly db: DatabaseSync

  /** Opens (creating 0600 in a 0700 directory) and migrates; `':memory:'` for tests. */
  constructor(path: string) {
    const fresh = path !== ':memory:' && !existsSync(path)
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path, { enableForeignKeyConstraints: true })
    if (fresh) chmodSync(path, 0o600)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 10000;')
    this.db.exec(SCHEMA)
    const version = this.meta('schema_version')
    if (version === null) this.setMeta('schema_version', String(SCHEMA_VERSION))
    else if (Number(version) > SCHEMA_VERSION)
      throw new Error(`${path} has schema ${version}, newer than this Aico (${SCHEMA_VERSION})`)
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

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  // -- One-time import ------------------------------------------------------

  /**
   * Copy the Python backend's project settings and the tabs that still show a
   * session, once. The old file is opened read-only and never changed; a
   * missing one counts as imported (nothing to bring over).
   */
  importOnce(source: string): ImportResult | null {
    if (this.meta('imported_from') !== null) return null
    const result: ImportResult = { source, projects: 0, panes: 0, links: 0 }
    if (existsSync(source)) {
      const old = new DatabaseSync(source, { readOnly: true })
      try {
        this.transaction(() => {
          const projects = old
            .prepare(
              'SELECT project_id, enabled, display_order, active_mode, created_at, updated_at FROM project_settings',
            )
            .all() as Row[]
          const insertProject = this.db.prepare(
            `INSERT OR IGNORE INTO project_settings
               (project_id, enabled, display_order, active_mode, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          for (const row of projects)
            result.projects += Number(
              insertProject.run(
                String(row.project_id),
                Number(row.enabled) === 1 ? 1 : 0,
                Number(row.display_order) || 0,
                String(row.active_mode || 'shell'),
                String(row.created_at),
                String(row.updated_at),
              ).changes,
            )
          const panes = old
            .prepare(
              `SELECT id, project_id, pane_name, active_mode, created_at FROM panes p
               WHERE EXISTS (SELECT 1 FROM pane_sessions s WHERE s.pane_id = p.id AND s.kind = 'tether')`,
            )
            .all() as Row[]
          const insertPane = this.db.prepare(
            'INSERT OR IGNORE INTO panes (id, project_id, name, active_mode, created_at) VALUES (?, ?, ?, ?, ?)',
          )
          for (const row of panes)
            result.panes += Number(
              insertPane.run(
                String(row.id),
                row.project_id === null ? null : String(row.project_id),
                String(row.pane_name),
                String(row.active_mode || 'shell'),
                String(row.created_at),
              ).changes,
            )
          const links = old
            .prepare(
              `SELECT session_id, pane_id, mode, display_order, created_at, last_accessed_at
               FROM pane_sessions WHERE kind = 'tether'`,
            )
            .all() as Row[]
          const insertLink = this.db.prepare(
            `INSERT OR IGNORE INTO session_links
               (session_id, pane_id, mode, display_order, created_at, last_accessed_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          for (const row of links)
            result.links += Number(
              insertLink.run(
                String(row.session_id),
                String(row.pane_id),
                String(row.mode),
                Number(row.display_order) || 0,
                String(row.created_at),
                row.last_accessed_at === null ? null : String(row.last_accessed_at),
              ).changes,
            )
          this.setMeta('imported_from', source)
          this.setMeta('imported_at', now())
        })
      } finally {
        old.close()
      }
    } else {
      this.setMeta('imported_from', source)
      this.setMeta('imported_at', now())
    }
    return result
  }

  // -- Tabs and links --------------------------------------------------------

  listPanes(): Pane[] {
    return this.db.prepare('SELECT * FROM panes ORDER BY created_at, id').all() as unknown as Pane[]
  }

  getPane(id: string): Pane | null {
    return pane(this.db.prepare('SELECT * FROM panes WHERE id = ?').get(id) as Row | undefined)
  }

  createPane(input: { projectId: string | null; name: string; activeMode: string }): Pane {
    const id = randomUUID()
    this.db
      .prepare(
        'INSERT INTO panes (id, project_id, name, active_mode, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, input.projectId, input.name, input.activeMode, now())
    return this.getPane(id) as Pane
  }

  updatePane(id: string, fields: { name?: string; activeMode?: string }): Pane | null {
    if (fields.name !== undefined)
      this.db.prepare('UPDATE panes SET name = ? WHERE id = ?').run(fields.name, id)
    if (fields.activeMode !== undefined)
      this.db.prepare('UPDATE panes SET active_mode = ? WHERE id = ?').run(fields.activeMode, id)
    return this.getPane(id)
  }

  /** Deletes the tab and its links (never the sessions). */
  deletePane(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM panes WHERE id = ?').run(id).changes) > 0
  }

  /** Deletes tabs created before `cutoff` that show no session; returns how many. */
  deleteEmptyPanes(cutoff: Date): number {
    const empty = this.db
      .prepare(
        `SELECT id, created_at FROM panes p
         WHERE NOT EXISTS (SELECT 1 FROM session_links s WHERE s.pane_id = p.id)`,
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
    const at = now()
    this.db
      .prepare(
        `INSERT INTO session_links (session_id, pane_id, mode, display_order, created_at, last_accessed_at)
         VALUES (?, ?, ?, 0, ?, ?)
         ON CONFLICT (session_id) DO UPDATE SET pane_id = excluded.pane_id, mode = excluded.mode`,
      )
      .run(sessionId, paneId, mode, at, at)
    return this.getLink(sessionId) as Link
  }

  unlink(sessionId: string): boolean {
    return (
      Number(
        this.db.prepare('DELETE FROM session_links WHERE session_id = ?').run(sessionId).changes,
      ) > 0
    )
  }

  getLink(sessionId: string): Link | null {
    const row = this.db.prepare('SELECT * FROM session_links WHERE session_id = ?').get(sessionId)
    return (row as unknown as Link | undefined) ?? null
  }

  listLinks(): Link[] {
    return this.db
      .prepare('SELECT * FROM session_links ORDER BY pane_id, mode')
      .all() as unknown as Link[]
  }

  linksForPane(paneId: string): Link[] {
    return this.db
      .prepare('SELECT * FROM session_links WHERE pane_id = ? ORDER BY mode')
      .all(paneId) as unknown as Link[]
  }

  updateLink(sessionId: string, fields: { mode?: string; displayOrder?: number }): void {
    if (fields.mode !== undefined)
      this.db
        .prepare('UPDATE session_links SET mode = ? WHERE session_id = ?')
        .run(fields.mode, sessionId)
    if (fields.displayOrder !== undefined)
      this.db
        .prepare('UPDATE session_links SET display_order = ? WHERE session_id = ?')
        .run(fields.displayOrder, sessionId)
  }

  touchLink(sessionId: string): void {
    this.db
      .prepare('UPDATE session_links SET last_accessed_at = ? WHERE session_id = ?')
      .run(now(), sessionId)
  }

  // -- Project settings --------------------------------------------------------

  allProjectSettings(): Map<string, ProjectSettings> {
    const rows = this.db.prepare('SELECT * FROM project_settings').all() as Row[]
    return new Map(rows.map((row) => [String(row.project_id), settings(row)]))
  }

  /** Deletes the settings of projects not in `projectIds` (never all of them: an empty list prunes nothing). */
  pruneProjectSettings(projectIds: ReadonlySet<string>): number {
    if (projectIds.size === 0) return 0
    let deleted = 0
    const remove = this.db.prepare('DELETE FROM project_settings WHERE project_id = ?')
    for (const id of this.allProjectSettings().keys())
      if (!projectIds.has(id)) deleted += Number(remove.run(id).changes)
    return deleted
  }

  /** Create or update; only the given fields change on an existing row. */
  upsertProjectSettings(
    projectId: string,
    fields: { enabled?: boolean; activeMode?: string; displayOrder?: number },
  ): ProjectSettings {
    const at = now()
    this.db
      .prepare(
        `INSERT INTO project_settings (project_id, enabled, display_order, active_mode, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id) DO UPDATE SET
           enabled = COALESCE(?, enabled),
           display_order = COALESCE(?, display_order),
           active_mode = COALESCE(?, active_mode),
           updated_at = excluded.updated_at`,
      )
      .run(
        projectId,
        fields.enabled ? 1 : 0,
        fields.displayOrder ?? 0,
        fields.activeMode ?? 'shell',
        at,
        at,
        fields.enabled === undefined ? null : fields.enabled ? 1 : 0,
        fields.displayOrder ?? null,
        fields.activeMode ?? null,
      )
    return settings(
      this.db.prepare('SELECT * FROM project_settings WHERE project_id = ?').get(projectId) as Row,
    )
  }
}
