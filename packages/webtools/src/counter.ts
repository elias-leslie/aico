// The call counter: one row per local day and verb in webtools.db (this package owns the
// file, package.json aico.db), shown as one Status row: calls today, failures, fallbacks.

import { join } from 'node:path'
import type { StatusRow } from '@aico/status'
import { type Database, openDatabase } from '@aico/store'

const MIGRATIONS = [
  `CREATE TABLE calls (
     day TEXT NOT NULL,
     verb TEXT NOT NULL,
     calls INTEGER NOT NULL DEFAULT 0,
     failures INTEGER NOT NULL DEFAULT 0,
     fallbacks INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (day, verb)
   ) STRICT;`,
]

export const webtoolsDbPath = (dataDir: string) => join(dataDir, 'webtools.db')

export const openCounter = (dataDir: string): Database =>
  openDatabase(webtoolsDbPath(dataDir), MIGRATIONS)

/** The local calendar day, YYYY-MM-DD. */
const localDay = (at: Date) =>
  `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`

export function count(
  db: Database,
  at: Date,
  call: { verb: string; failed: boolean; fallback: boolean },
): void {
  db.prepare(
    `INSERT INTO calls (day, verb, calls, failures, fallbacks) VALUES (?, ?, 1, ?, ?)
     ON CONFLICT (day, verb) DO UPDATE SET calls = calls + 1,
       failures = failures + excluded.failures, fallbacks = fallbacks + excluded.fallbacks`,
  ).run(localDay(at), call.verb, call.failed ? 1 : 0, call.fallback ? 1 : 0)
}

export interface Today {
  calls: number
  failures: number
  fallbacks: number
  byVerb: Record<string, number>
}

export function today(db: Database, at: Date): Today {
  const rows = db
    .prepare('SELECT verb, calls, failures, fallbacks FROM calls WHERE day = ?')
    .all(localDay(at)) as { verb: string; calls: number; failures: number; fallbacks: number }[]
  const out: Today = { calls: 0, failures: 0, fallbacks: 0, byVerb: {} }
  for (const row of rows) {
    out.calls += row.calls
    out.failures += row.failures
    out.fallbacks += row.fallbacks
    out.byVerb[row.verb] = row.calls
  }
  return out
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** The one Status row, in plain words; warn when at least half of today's calls failed. */
export function counterRow(machine: string, totals: Today, at: Date): StatusRow {
  const verbs = Object.entries(totals.byVerb)
    .map(([verb, n]) => `${verb} ${n}`)
    .join(', ')
  const meaning = totals.calls
    ? `${plural(totals.calls, 'call', 'calls')} today (${verbs}); ${totals.failures} failed; ${plural(totals.fallbacks, 'call', 'calls')} used a fallback (another search engine or the Jina reader).`
    : 'No web calls today.'
  return {
    id: `webtools:${machine}`,
    what: 'Web search and fetch',
    kind: 'service',
    machine,
    state: totals.calls >= 4 && totals.failures * 2 >= totals.calls ? 'warn' : 'ok',
    meaning: meaning.slice(0, 300),
    last_run: at.toISOString(),
  }
}
