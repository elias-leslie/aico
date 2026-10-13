import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// Aico's own state (~/.local/state/aico/aico.db): one view row per session
// Aico has shown, plus app settings. Sessions themselves belong to Tether and
// are keyed by the same eight-hex id Aico always used as its widget id, so the
// sidecar's per-widget JSONL logs keep matching.
//
// The pre-Tether tables (`widgets`, `tmux_servers`, `root_requests`) are never
// written or dropped here: they stay as the rollback copy that the old Aico and
// `tether import-aico` read.

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export interface ViewRow {
  /** Tether session id (8 lowercase hex). */
  id: string
  /** Order views were first shown in; oldest first. */
  seq: number
  bounds: Bounds | null
  displayId: string | null
  /** Shown at last quit, so it is restored on the next launch. */
  open: boolean
  /** A local-only label. Null uses Tether's session name. */
  nameOverride: string | null
  /** Marked as a coordinator: labelled in the titlebar and tiled in the centre. */
  coordinator: boolean
}

let db: DatabaseSync

const SESSION_ID = /^[0-9a-f]{8}$/
/** Settings key recording that the widgets table was copied into views. */
export const VIEWS_MIGRATED_SETTING = 'views-migrated-from-widgets'

interface Raw {
  widget_id: string
  seq: number
  x: number | null
  y: number | null
  width: number | null
  height: number | null
  display_id: string | null
  open: number
  name_override: string | null
  coordinator: number
}

function toRow(r: Raw): ViewRow {
  const hasBounds = r.x !== null && r.y !== null && r.width !== null && r.height !== null
  return {
    id: r.widget_id,
    seq: r.seq,
    bounds: hasBounds
      ? { x: r.x as number, y: r.y as number, width: r.width as number, height: r.height as number }
      : null,
    displayId: r.display_id,
    open: r.open === 1,
    nameOverride: r.name_override,
    coordinator: r.coordinator === 1,
  }
}

export function initViews(dbPath: string): { migrated: number } {
  // A fresh profile (or AICO_STATE_DIR) may not exist yet.
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 })
  db = new DatabaseSync(dbPath)
  db.exec('PRAGMA busy_timeout = 2000; PRAGMA journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS views (
      widget_id     TEXT PRIMARY KEY,
      seq           INTEGER NOT NULL,
      x             INTEGER,
      y             INTEGER,
      width         INTEGER,
      height        INTEGER,
      display_id    TEXT,
      open          INTEGER NOT NULL DEFAULT 1,
      name_override TEXT
    );
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)
  const columns = (db.prepare('PRAGMA table_info(views)').all() as { name: string }[]).map(
    (c) => c.name,
  )
  if (!columns.includes('coordinator'))
    db.exec('ALTER TABLE views ADD COLUMN coordinator INTEGER NOT NULL DEFAULT 0')
  return { migrated: migrateWidgetViews() }
}

/**
 * Copy view columns from the pre-Tether `widgets` table once, in one
 * transaction. External (A-Term) rows are skipped: Aico no longer federates
 * them. Pins that named those external sessions (`tmux:*`) are dropped from the
 * pinned-action list; Aico session pins (`session:aico:<id>`) keep their ids.
 */
export function migrateWidgetViews(): number {
  if (getSetting(VIEWS_MIGRATED_SETTING) !== undefined) return 0
  const hasWidgets =
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'widgets'").get() !==
    undefined
  let copied = 0
  db.exec('BEGIN IMMEDIATE')
  try {
    if (hasWidgets) {
      const columns = new Set(
        (db.prepare('PRAGMA table_info(widgets)').all() as { name: string }[]).map((c) => c.name),
      )
      const external = columns.has('external_tmux_session')
        ? 'AND external_tmux_session IS NULL'
        : ''
      const rows = db
        .prepare(
          `SELECT id, seq, x, y, width, height, display_id, open FROM widgets
           WHERE 1 = 1 ${external} ORDER BY seq, id`,
        )
        .all() as unknown as {
        id: string
        seq: number
        x: number | null
        y: number | null
        width: number | null
        height: number | null
        display_id: string | null
        open: number
      }[]
      const insert = db.prepare(
        `INSERT OR IGNORE INTO views (widget_id, seq, x, y, width, height, display_id, open)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const row of rows) {
        if (!SESSION_ID.test(row.id)) continue
        copied += Number(
          insert.run(
            row.id,
            row.seq,
            row.x,
            row.y,
            row.width,
            row.height,
            row.display_id,
            row.open ? 1 : 0,
          ).changes,
        )
      }
    }
    const pins = getSetting('pins')
    if (pins !== undefined) {
      try {
        const parsed: unknown = JSON.parse(pins)
        if (Array.isArray(parsed)) {
          const kept = parsed.filter((id) => !(typeof id === 'string' && id.startsWith('tmux:')))
          if (kept.length !== parsed.length) setSetting('pins', JSON.stringify(kept))
        }
      } catch {
        // An unreadable pin list is left for the renderer's own sanitizer.
      }
    }
    setSetting(VIEWS_MIGRATED_SETTING, String(Date.now()))
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return copied
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

/** All views, oldest first. */
export function listViews(): ViewRow[] {
  return (db.prepare('SELECT * FROM views ORDER BY seq, widget_id').all() as unknown as Raw[]).map(
    toRow,
  )
}

export function getView(id: string): ViewRow | undefined {
  const r = db.prepare('SELECT * FROM views WHERE widget_id = ?').get(id) as Raw | undefined
  return r ? toRow(r) : undefined
}

/** The view for a session, created (closed, unplaced) on first use. */
export function ensureView(id: string, open = false): ViewRow {
  if (!SESSION_ID.test(id)) throw new Error('invalid session id')
  db.prepare(
    `INSERT OR IGNORE INTO views (widget_id, seq, open)
     VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM views), ?)`,
  ).run(id, open ? 1 : 0)
  return getView(id) as ViewRow
}

export function saveBounds(id: string, bounds: Bounds, displayId: string): void {
  ensureView(id)
  db.prepare(
    'UPDATE views SET x = ?, y = ?, width = ?, height = ?, display_id = ? WHERE widget_id = ?',
  ).run(bounds.x, bounds.y, bounds.width, bounds.height, displayId, id)
}

export function setOpen(id: string, open: boolean): void {
  db.prepare('UPDATE views SET open = ? WHERE widget_id = ?').run(open ? 1 : 0, id)
}

export function setCoordinator(id: string, coordinator: boolean): void {
  ensureView(id)
  db.prepare('UPDATE views SET coordinator = ? WHERE widget_id = ?').run(coordinator ? 1 : 0, id)
}

/** Forget a view after its session ended. */
export function removeView(id: string): void {
  db.prepare('DELETE FROM views WHERE widget_id = ?').run(id)
}
