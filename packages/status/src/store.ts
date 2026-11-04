// status.db: one row per id, the posted row as JSON plus when the server took
// it. This package owns the file (package.json aico.db); others ask aico-web.

import { hostname } from 'node:os'
import { join } from 'node:path'
import { type Database, openDatabase, transaction } from '@aico/store'
import { type AlertBatch, type AlertHook, transitions } from './alerts'
import { parseRow, type StatusRow } from './row'
import {
  type Filter,
  type Shown,
  type StatusView,
  type StoredRow,
  show,
  summary,
  view,
} from './show'

const MIGRATIONS = [
  `CREATE TABLE status_rows (
     id TEXT PRIMARY KEY,
     doc TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   ) STRICT`,
  // Each row's shown state at the last alert pass (alerts.ts).
  `CREATE TABLE status_seen (
     id TEXT PRIMARY KEY,
     shown TEXT NOT NULL
   ) STRICT`,
]

/** This host's id on its rows: the short host name in lower case ('davion-sidarli'). */
export function machineId(name: string = hostname()): string {
  return (name.split('.')[0] as string).toLowerCase()
}

/** The status DB file in a data directory. */
export function statusDbPath(dataDir: string): string {
  return join(dataDir, 'status.db')
}

export class StatusStore {
  private readonly db: Database
  private alertHook: AlertHook | null = null

  /** Opens `path` (`':memory:'` for tests); `now` stamps updated_at. */
  constructor(
    path: string,
    private readonly now: () => number = Date.now,
  ) {
    this.db = openDatabase(path, MIGRATIONS)
  }

  /** Writes rows, all or none (each checked by `parseRow` first); the same id replaces its row. */
  upsert(rows: readonly StatusRow[]): void {
    const checked = rows.map(parseRow)
    const at = this.now()
    const put = this.db.prepare(
      `INSERT INTO status_rows (id, doc, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at`,
    )
    transaction(this.db, () => {
      for (const row of checked) put.run(row.id, JSON.stringify(row), at)
    })
    if (this.alertHook) this.checkAlerts()
  }

  /** Drops a row (a thing that no longer exists); false when there was none. */
  remove(id: string): boolean {
    this.db.prepare('DELETE FROM status_seen WHERE id = ?').run(id)
    return this.db.prepare('DELETE FROM status_rows WHERE id = ?').run(id).changes > 0
  }

  /**
   * Hands each alerting batch to `hook`: on every upsert, and whenever the caller runs
   * checkAlerts() (on a timer, since rows go late without a write).
   */
  onAlert(hook: AlertHook): void {
    this.alertHook = hook
  }

  /** Compares the rows with the last pass and records them; the batch that alerts, or null. */
  checkAlerts(): AlertBatch | null {
    const now = this.now()
    const rows = show(this.rows(), now)
    const seen = new Map(
      (
        this.db.prepare('SELECT id, shown FROM status_seen').all() as {
          id: string
          shown: Shown
        }[]
      ).map(({ id, shown }) => [id, shown]),
    )
    const changes = transitions(seen, rows)
    const put = this.db.prepare(
      `INSERT INTO status_seen (id, shown) VALUES (?, ?)
       ON CONFLICT (id) DO UPDATE SET shown = excluded.shown`,
    )
    transaction(this.db, () => {
      for (const row of rows) if (seen.get(row.id) !== row.shown) put.run(row.id, row.shown)
    })
    if (!changes.length) return null
    const batch = { generated_at: new Date(now).toISOString(), changes, summary: summary(rows) }
    try {
      this.alertHook?.(batch)
    } catch (error) {
      console.error('[status] alert hook failed:', error)
    }
    return batch
  }

  rows(): StoredRow[] {
    const all = this.db.prepare('SELECT doc, updated_at FROM status_rows').all() as {
      doc: string
      updated_at: number
    }[]
    return all.map(({ doc, updated_at }) => ({
      row: JSON.parse(doc) as StatusRow,
      updatedAt: updated_at,
    }))
  }

  /** The rows as a reader sees them now. */
  read(filter: Filter = {}): StatusView {
    return view(this.rows(), this.now(), filter)
  }

  close(): void {
    this.db.close()
  }
}
