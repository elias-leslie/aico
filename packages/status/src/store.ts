// status.db: one row per id, the posted row as JSON plus when the server took
// it. This package owns the file (package.json aico.db); others ask aico-web.

import { join } from 'node:path'
import { type Database, openDatabase, transaction } from '@aico/store'
import { parseRow, type StatusRow } from './row'
import { type Filter, type StatusView, type StoredRow, view } from './show'

const MIGRATIONS = [
  `CREATE TABLE status_rows (
     id TEXT PRIMARY KEY,
     doc TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   ) STRICT`,
]

/** The status DB file in a data directory. */
export function statusDbPath(dataDir: string): string {
  return join(dataDir, 'status.db')
}

export class StatusStore {
  private readonly db: Database

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
  }

  /** Drops a row (a thing that no longer exists); false when there was none. */
  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM status_rows WHERE id = ?').run(id).changes > 0
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
