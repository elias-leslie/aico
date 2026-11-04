// Storing a window reading: the newest reading of a window wins, whichever source it
// came from, and a window's use never goes down inside the window (a stale session
// reporting an older, lower number is dropped or lifted to what is on record).

import type { Database } from './db'
import { micros } from './windows'

export interface ReadingEvent {
  provider: string
  window_minutes: number
  /** Epoch ms. */
  observedAt: number
  used_percent: number
  /** Epoch ms, or null when the source names no reset. */
  resetsAt: number | null
  source: string
  plan_type: string | null
}

interface Stored {
  observed_at: string
  used_percent: number
  resets_at: string | null
  plan_type: string | null
}

/**
 * Stores `event` unless it adds nothing: a reading of an older window, or of the same
 * window with no more use inside `minIntervalS` of the last one on record. True when stored.
 */
export function storeReading(db: Database, event: ReadingEvent, minIntervalS: number): boolean {
  const prev = db
    .prepare(
      'SELECT observed_at, used_percent, resets_at, plan_type FROM readings WHERE provider = ? AND window_minutes = ? ORDER BY observed_at DESC LIMIT 1',
    )
    .get(event.provider, event.window_minutes) as Stored | undefined
  let resets = event.resetsAt
  let used = event.used_percent
  if (prev) {
    const prevResets = prev.resets_at ? micros(prev.resets_at) / 1000 : 0
    const prevAt = micros(prev.observed_at) / 1000
    // A reading that names no reset takes the reset of the open window on record.
    if (resets === null && prevResets > event.observedAt) resets = prevResets
    if (resets !== null && resets < prevResets - 60_000) return false
    const same = resets !== null && Math.abs(resets - prevResets) <= 60_000
    if (
      same &&
      used <= prev.used_percent &&
      event.plan_type === prev.plan_type &&
      event.observedAt - prevAt < minIntervalS * 1000
    )
      return false
    if (same && used < prev.used_percent) used = prev.used_percent
  }
  db.prepare(
    'INSERT OR IGNORE INTO readings (provider, window_minutes, observed_at, used_percent, resets_at, source, plan_type) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    event.provider,
    event.window_minutes,
    new Date(event.observedAt).toISOString(),
    used,
    resets === null ? null : new Date(resets).toISOString(),
    event.source,
    event.plan_type,
  )
  return true
}
