import { DatabaseSync } from 'node:sqlite'

// Widget catalog persisted in SQLite (~/.local/state/aico/aico.db). A widget's
// identity is a stable id (not the volatile BrowserWindow id), so its tmux
// session survives close/reopen and app restarts. Bounds restore position/size;
// `open` records which widgets were live at last quit so they can be restored.

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export interface WidgetRow {
  id: string
  seq: number
  bounds: Bounds | null
  displayId: string | null
  open: boolean
  createdAt: number
  /** TUI slug this widget runs (see electron/main/tui). */
  tool: string
  /** User-chosen title-bar name; null falls back to `Widget ${seq}`. */
  name: string | null
  /** Workspace/project slug this widget is bound to; null = the global `st`
   * active project (legacy fallback). Identity for the flyout/marker. */
  projectId: string | null
  /** The bound workspace/project fs root, resolved once at switch time and
   * stored so the per-widget cwd is a cheap column read (no `st` subprocess on session create).
   * Null when unbound or unresolved; a vanished root falls back at use. */
  projectRoot: string | null
  /** Non-null when this widget attaches a session owned by another tmux server. */
  externalTmuxSocket: string | null
  externalTmuxSession: string | null
}

interface Raw {
  id: string
  seq: number
  x: number | null
  y: number | null
  width: number | null
  height: number | null
  display_id: string | null
  open: number
  created_at: number
  tool: string
  name: string | null
  project_id: string | null
  project_root: string | null
  external_tmux_socket: string | null
  external_tmux_session: string | null
}

let db: DatabaseSync

function toRow(r: Raw): WidgetRow {
  const hasBounds = r.x !== null && r.y !== null && r.width !== null && r.height !== null
  return {
    id: r.id,
    seq: r.seq,
    bounds: hasBounds
      ? { x: r.x as number, y: r.y as number, width: r.width as number, height: r.height as number }
      : null,
    displayId: r.display_id,
    open: r.open === 1,
    createdAt: r.created_at,
    tool: r.tool,
    name: r.name ?? null,
    projectId: r.project_id ?? null,
    projectRoot: r.project_root ?? null,
    externalTmuxSocket: r.external_tmux_socket ?? null,
    externalTmuxSession: r.external_tmux_session ?? null,
  }
}

export function initStore(dbPath: string): void {
  db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE IF NOT EXISTS widgets (
      id         TEXT PRIMARY KEY,
      seq        INTEGER NOT NULL,
      x          INTEGER,
      y          INTEGER,
      width      INTEGER,
      height     INTEGER,
      display_id TEXT,
      open       INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      tool         TEXT NOT NULL DEFAULT 'shell',
      name         TEXT,
      project_id   TEXT,
      project_root TEXT,
      external_tmux_socket  TEXT,
      external_tmux_session TEXT
    )
  `)
  // Migrate pre-`tool` databases: existing widgets are bare shells. New widgets
  // pass their TUI slug explicitly (default Claude Code).
  const cols = db.prepare('PRAGMA table_info(widgets)').all() as { name: string }[]
  if (!cols.some((c) => c.name === 'tool')) {
    db.exec("ALTER TABLE widgets ADD COLUMN tool TEXT NOT NULL DEFAULT 'shell'")
  }
  // Migrate pre-`name` databases: no custom name (falls back to `Widget ${seq}`).
  if (!cols.some((c) => c.name === 'name')) {
    db.exec('ALTER TABLE widgets ADD COLUMN name TEXT')
  }
  // Migrate pre-`project_id` databases: no per-widget binding (widgets fall back
  // to the global `st` active project for their cwd). `project_root` caches the
  // bound project's resolved fs root so session create needs no `st` subprocess.
  if (!cols.some((c) => c.name === 'project_id')) {
    db.exec('ALTER TABLE widgets ADD COLUMN project_id TEXT')
  }
  if (!cols.some((c) => c.name === 'project_root')) {
    db.exec('ALTER TABLE widgets ADD COLUMN project_root TEXT')
  }
  if (!cols.some((c) => c.name === 'external_tmux_socket')) {
    db.exec('ALTER TABLE widgets ADD COLUMN external_tmux_socket TEXT')
  }
  if (!cols.some((c) => c.name === 'external_tmux_session')) {
    db.exec('ALTER TABLE widgets ADD COLUMN external_tmux_session TEXT')
  }
  // Global app settings as a small key/value table. Used for the control
  // surface's pinned-action list (one row, shared across all widgets).
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `)
}

export function getSetting(key: string): string | undefined {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return r?.value
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value)
}

/** All widgets, oldest first. */
export function listWidgets(): WidgetRow[] {
  return (db.prepare('SELECT * FROM widgets ORDER BY created_at ASC').all() as unknown[]).map((r) =>
    toRow(r as Raw),
  )
}

export function getWidget(id: string): WidgetRow | undefined {
  const r = db.prepare('SELECT * FROM widgets WHERE id = ?').get(id) as Raw | undefined
  return r ? toRow(r) : undefined
}

export function hasWidget(id: string): boolean {
  return db.prepare('SELECT 1 FROM widgets WHERE id = ?').get(id) !== undefined
}

function nextSeq(): number {
  const r = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM widgets').get() as { n: number }
  return r.n
}

/** Insert a new (or adopted) widget. `createdAt` lets adoption preserve order;
 * `tool` is the TUI slug (adopted orphans are bare shells). */
export function insertWidget(
  id: string,
  open: boolean,
  tool: string,
  createdAt = Date.now(),
): WidgetRow {
  db.prepare('INSERT INTO widgets (id, seq, open, created_at, tool) VALUES (?, ?, ?, ?, ?)').run(
    id,
    nextSeq(),
    open ? 1 : 0,
    createdAt,
    tool,
  )
  return getWidget(id) as WidgetRow
}

/** Insert a widget that attaches an externally-owned tmux session. */
export function insertExternalWidget(
  id: string,
  open: boolean,
  externalTmuxSocket: string | null,
  externalTmuxSession: string,
  name: string | null,
  tool = 'shell',
  createdAt = Date.now(),
): WidgetRow {
  db.prepare(
    `INSERT INTO widgets (
      id, seq, open, created_at, tool, name, external_tmux_socket, external_tmux_session
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, nextSeq(), open ? 1 : 0, createdAt, tool, name, externalTmuxSocket, externalTmuxSession)
  return getWidget(id) as WidgetRow
}

export function saveBounds(id: string, bounds: Bounds, displayId: string): void {
  db.prepare(
    'UPDATE widgets SET x = ?, y = ?, width = ?, height = ?, display_id = ? WHERE id = ?',
  ).run(bounds.x, bounds.y, bounds.width, bounds.height, displayId, id)
}

export function setOpen(id: string, open: boolean): void {
  db.prepare('UPDATE widgets SET open = ? WHERE id = ?').run(open ? 1 : 0, id)
}

/** Update a widget's TUI slug (e.g. after "Replace with <TUI>" in the widget),
 * so a later kill+recreate launches the TUI that's actually running there now. */
export function setWidgetTool(id: string, tool: string): void {
  db.prepare('UPDATE widgets SET tool = ? WHERE id = ?').run(tool, id)
}

/** Set (or clear, with null/empty) a widget's user-chosen title-bar name. */
export function setWidgetName(id: string, name: string | null): void {
  const trimmed = name?.trim()
  db.prepare('UPDATE widgets SET name = ? WHERE id = ?').run(trimmed || null, id)
}

/** Bind a widget to a workspace/project (slug + its resolved fs root), or clear
 * both with null to fall back to the global `st` active project. The root is
 * resolved once here (at switch time) so the per-widget cwd is later cheap. */
export function setWidgetProject(
  id: string,
  projectId: string | null,
  projectRoot: string | null,
): void {
  db.prepare('UPDATE widgets SET project_id = ?, project_root = ? WHERE id = ?').run(
    projectId || null,
    projectRoot || null,
    id,
  )
}

export function removeWidget(id: string): void {
  db.prepare('DELETE FROM widgets WHERE id = ?').run(id)
}
