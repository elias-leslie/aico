// The usage facts routing and the spend rows read: the newest reading of every provider
// window seen inside the lookback (whichever source it came from), each provider's credit
// balance from its lots and the credits drawn since, and the newest refusals.

import config from '../data/usage.json' with { type: 'json' }
import type { Database } from './db'
import { creditFacts, type Lot, localDay, type Plans } from './plans'
import { type Credit, type Facts, micros, type Reading, type Refusal } from './windows'

const REFUSAL_ROWS = 1000

export const LOOKBACK_DAYS = config.lookback_days

interface ReadingRow {
  provider: string
  window_minutes: number
  observed_at: string
  used_percent: number
  resets_at: string | null
  source: string
}

/** The newest reading of each provider window within the lookback; ties go to the higher use. */
export function latestReadings(db: Database, now: string): Reading[] {
  const since = micros(now) - LOOKBACK_DAYS * 86400 * 1e6
  const best = new Map<string, ReadingRow>()
  for (const row of db.prepare('SELECT * FROM readings').all() as unknown as ReadingRow[]) {
    if (micros(row.observed_at) < since) continue
    const key = `${row.provider}\n${row.window_minutes}`
    const current = best.get(key)
    const newer =
      !current ||
      micros(row.observed_at) > micros(current.observed_at) ||
      (micros(row.observed_at) === micros(current.observed_at) &&
        row.used_percent > current.used_percent)
    if (newer) best.set(key, row)
  }
  return [...best.values()]
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.window_minutes - b.window_minutes)
    .map((row) => ({
      provider: row.provider,
      window_minutes: row.window_minutes,
      observed_at: row.observed_at,
      used_percent: row.used_percent,
      resets_at: row.resets_at,
      source: row.source,
    }))
}

/** Per provider with credit lots (the plans file's, plus balance jumps the collector found). */
export function creditsOf(db: Database, plans: Plans, now: string): Record<string, Credit> {
  const detected = (
    db.prepare('SELECT provider, at, credits FROM detected_lots').all() as unknown as {
      provider: string
      at: string
      credits: number
    }[]
  ).map(
    (row): Lot => ({
      provider: row.provider,
      source: 'unclassified',
      credits: row.credits,
      granted_at: row.at,
      expires_at: null,
      value_usd_per_credit: null,
      paid_usd: null,
      evidence: null,
    }),
  )
  const lotsBy = new Map<string, Lot[]>()
  for (const lot of [...plans.lots, ...detected])
    lotsBy.set(lot.provider, [...(lotsBy.get(lot.provider) ?? []), lot])
  const today = localDay(Date.parse(now))
  const credits: Record<string, Credit> = {}
  for (const [provider, lots] of lotsBy) {
    const firstDay = lots.map((lot) => localDay(lot.granted_at)).sort()[0] as string
    const drawnByDay = new Map<string, number>()
    const rows = db
      .prepare(
        'SELECT day, SUM(credits_drawn) AS drawn FROM daily WHERE provider = ? AND day >= ? AND credits_drawn > 0 GROUP BY day',
      )
      .all(provider, firstDay) as unknown as { day: string; drawn: number }[]
    for (const row of rows) drawnByDay.set(row.day, row.drawn)
    credits[provider] = creditFacts(lots, drawnByDay, today)
  }
  return credits
}

/** Newest first; one row per refusal (each counts once). */
export function recentRefusals(db: Database): Refusal[] {
  const rows = db.prepare('SELECT * FROM refusals').all() as unknown as Omit<Refusal, 'count'>[]
  return rows
    .map((row) => ({
      requested_model: row.requested_model,
      at: row.at,
      role: row.role,
      project: row.project,
      category: row.category,
      count: 1,
    }))
    .sort((a, b) => micros(b.at) - micros(a.at))
    .slice(0, REFUSAL_ROWS)
}

/** Everything routing and the spend rows need, as of `now`. */
export function loadFacts(db: Database, plans: Plans, now: string): Facts {
  return {
    readings: latestReadings(db, now),
    credits: creditsOf(db, plans, now),
    refusals: recentRefusals(db),
  }
}

/** Records a refusal (the agent harness and Tether call this when a provider refuses a model). */
export function recordRefusal(db: Database, refusal: Omit<Refusal, 'count'>): void {
  db.prepare(
    'INSERT INTO refusals (requested_model, at, role, project, category) VALUES (?, ?, ?, ?, ?)',
  ).run(refusal.requested_model, refusal.at, refusal.role, refusal.project, refusal.category)
}
