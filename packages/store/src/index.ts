// The only code that touches node:sqlite (cutlist 1.1, layer 1). A package that
// owns a DB file opens it here: created 0600 in a 0700 directory, WAL, a busy
// timeout, and its migrations applied in order. A migration is one SQL script;
// the file's PRAGMA user_version counts how many have run.

import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type Database = DatabaseSync

function userVersion(db: Database): number {
  return Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
}

/** Wait this long for another writer's lock before failing. */
const BUSY_TIMEOUT_MS = 10_000

const SQLITE_BUSY = 5

/**
 * Switches to WAL. Another process opening the same fresh file can hold the lock this needs, and
 * SQLite then answers busy at once rather than through the busy timeout, so retry until it passes.
 */
function useWal(db: Database): void {
  const deadline = Date.now() + BUSY_TIMEOUT_MS
  const pause = new Int32Array(new SharedArrayBuffer(4))
  for (;;) {
    try {
      db.exec('PRAGMA journal_mode = WAL')
      return
    } catch (error) {
      if ((error as { errcode?: number }).errcode !== SQLITE_BUSY || Date.now() > deadline)
        throw error
      Atomics.wait(pause, 0, 0, 10)
    }
  }
}

/**
 * Opens (creating when missing) and migrates `path`; `':memory:'` for tests.
 * `migrations[i]` takes the file from version i to i + 1; the pending ones run in one transaction.
 * A file newer than the code (more versions than `migrations`) is refused.
 */
export function openDatabase(path: string, migrations: readonly string[]): Database {
  const memory = path === ':memory:'
  const fresh = !memory && !existsSync(path)
  if (!memory) mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(path)
  try {
    if (fresh) chmodSync(path, 0o600)
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
    useWal(db)
    const check = () => {
      const version = userVersion(db)
      if (version > migrations.length)
        throw new Error(
          `${path} is at schema version ${version}, newer than this Aico (${migrations.length})`,
        )
      return version
    }
    if (check() < migrations.length)
      // Read the version again under the write lock: another process opening the same file may
      // have migrated it since. All pending migrations land together, or none.
      transaction(db, () => {
        for (let from = check(); from < migrations.length; from += 1) {
          db.exec(migrations[from] as string)
          db.exec(`PRAGMA user_version = ${from + 1}`)
        }
      })
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

/** Runs `work` in one write transaction (BEGIN IMMEDIATE): all of it lands, or none. */
export function transaction<T>(db: Database, work: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = work()
    db.exec('COMMIT')
    return result
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw error
  }
}
