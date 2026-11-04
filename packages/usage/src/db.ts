// usage.db: what each subscription has left (this package owns the file, package.json aico.db).
//
// - readings: provider usage windows (5h, weekly, monthly) as read, each with the time it
//   was observed and where it came from; a reading says nothing once its reset passed.
// - daily: per local day, provider, model, project and speed: requests, tokens and the
//   credits drawn (Codex). The rows before the cutover day came from Agent Hub; api_equiv_usd
//   is null on rows Aico collected (it prices nothing).
// - detected_lots: credit balance increases no lot in the plans file explains.
// - refusals: models a provider refused, newest first in facts.
// - cursors: how far each Codex log file was read; state: collector memory (JSON values).

import { join } from 'node:path'
import { type Database, openDatabase } from '@aico/store'

export type { Database }

const MIGRATIONS = [
  `CREATE TABLE readings (
     provider TEXT NOT NULL,
     window_minutes INTEGER NOT NULL,
     observed_at TEXT NOT NULL,
     used_percent REAL NOT NULL,
     resets_at TEXT,
     source TEXT NOT NULL,
     plan_type TEXT,
     PRIMARY KEY (provider, window_minutes, observed_at)
   ) STRICT;
   CREATE TABLE daily (
     day TEXT NOT NULL,
     provider TEXT NOT NULL,
     model TEXT NOT NULL,
     project TEXT NOT NULL,
     speed TEXT NOT NULL DEFAULT 'standard',
     requests INTEGER NOT NULL DEFAULT 0,
     input_tokens INTEGER NOT NULL DEFAULT 0,
     cached_input_tokens INTEGER NOT NULL DEFAULT 0,
     cache_write_tokens INTEGER NOT NULL DEFAULT 0,
     output_tokens INTEGER NOT NULL DEFAULT 0,
     api_equiv_usd REAL,
     unpriced_tokens INTEGER NOT NULL DEFAULT 0,
     credits_drawn REAL NOT NULL DEFAULT 0,
     PRIMARY KEY (day, provider, model, project, speed)
   ) STRICT;
   CREATE TABLE detected_lots (
     provider TEXT NOT NULL,
     at TEXT NOT NULL,
     credits REAL NOT NULL,
     PRIMARY KEY (provider, at)
   ) STRICT;
   CREATE TABLE refusals (
     id INTEGER PRIMARY KEY,
     requested_model TEXT NOT NULL,
     at TEXT NOT NULL,
     role TEXT,
     project TEXT,
     category TEXT,
     imported INTEGER NOT NULL DEFAULT 0
   ) STRICT;
   CREATE TABLE cursors (
     path TEXT PRIMARY KEY,
     offset INTEGER NOT NULL,
     state TEXT NOT NULL DEFAULT '{}'
   ) STRICT;
   CREATE TABLE state (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   ) STRICT;`,
]

/** The usage DB file in a data directory. */
export function usageDbPath(dataDir: string): string {
  return join(dataDir, 'usage.db')
}

/** The plans and credit lots file in a data directory (owner data: never committed). */
export function plansPath(dataDir: string): string {
  return join(dataDir, 'usage-plans.json')
}

/** Opens (creating and migrating) usage.db; `':memory:'` for tests. */
export function openUsage(path: string): Database {
  return openDatabase(path, MIGRATIONS)
}

/** A collector-memory value (JSON), or undefined. */
export function getState<T>(db: Database, key: string): T | undefined {
  const row = db.prepare('SELECT value FROM state WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row ? (JSON.parse(row.value) as T) : undefined
}

export function putState(db: Database, key: string, value: unknown): void {
  db.prepare(
    'INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  ).run(key, JSON.stringify(value))
}
