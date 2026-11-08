// The usage facts routing and the spend rows read: the newest reading of every provider
// window seen inside the lookback (whichever source it came from), each provider's credit
// balance from its lots and the credits drawn since, and the newest refusals.

import config from '../data/usage.json' with { type: 'json' }
import { type Database, getState, putState } from './db'
import { creditFacts, type Lot, localDay, type Plans, planEndedAt } from './plans'
import { type Credit, type Facts, micros, type Reading, type Refusal } from './windows'

const REFUSAL_ROWS = 1000

const LOOKBACK_DAYS = config.lookback_days

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
function creditsOf(db: Database, plans: Plans, now: string): Record<string, Credit> {
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
    credits[provider] = creditFacts(lots, drawnByDay, now)
  }
  return credits
}

/** Newest first; one row per refusal (each counts once). */
function recentRefusals(db: Database): Refusal[] {
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

const planUsedKey = (provider: string) => `plan_used:${provider}`

/** The same window: a reset time can move by this much between readings (as storeReading treats it). */
const RESET_JITTER_MICROS = 60e6

/**
 * Whether a tool shows real use after its plan's end: within one window (one reset time) the
 * number rises once the end has settled. Not a new time (an open session rewrites its last numbers
 * on every redraw), not a number that rose before the end but was only read after it, and not a
 * window that rolled by itself.
 */
function usedAfterEnd(rows: ReadingRow[], end: string): boolean {
  const settled = micros(end) + config.plan_end_settle_min * 60e6
  const open = new Map<number, { resets: number | null; high: number }>()
  for (const row of [...rows].sort((a, b) => micros(a.observed_at) - micros(b.observed_at))) {
    const resets = row.resets_at ? micros(row.resets_at) : null
    const seen = open.get(row.window_minutes)
    const same =
      seen !== undefined &&
      (resets === null || seen.resets === null
        ? resets === seen.resets
        : Math.abs(resets - seen.resets) <= RESET_JITTER_MICROS)
    if (!same) {
      open.set(row.window_minutes, { resets, high: row.used_percent })
      continue
    }
    if (row.used_percent <= seen.high) continue
    if (micros(row.observed_at) > settled) return true
    seen.high = row.used_percent
  }
  return false
}

/**
 * Remembers use seen after a plan's end, while the readings that show it still exist: they are
 * dropped after the lookback, and an idle tool must not read as ended again because of that.
 * Collection calls this; a new end date starts over.
 */
export function notePlanUse(db: Database, plans: Plans, now: string): void {
  for (const { id } of config.providers) {
    const end = planEndedAt(plans.plans, id, now)
    if (!end || getState<string>(db, planUsedKey(id)) === end) continue
    const rows = db
      .prepare('SELECT * FROM readings WHERE provider = ?')
      .all(id) as unknown as ReadingRow[]
    if (usedAfterEnd(rows, end)) putState(db, planUsedKey(id), end)
  }
}

/** The providers with no plan now, with when it ended; use noted after the end wins (it was early, or the plan is back). */
function endedPlans(db: Database, plans: Plans, now: string): Record<string, string> {
  const ended: Record<string, string> = {}
  for (const { id } of config.providers) {
    const end = planEndedAt(plans.plans, id, now)
    if (end && getState<string>(db, planUsedKey(id)) !== end) ended[id] = end
  }
  return ended
}

/** Everything routing and the spend rows need, as of `now`. */
export function loadFacts(db: Database, plans: Plans, now: string): Facts {
  const facts: Facts = {
    readings: latestReadings(db, now),
    credits: creditsOf(db, plans, now),
    refusals: recentRefusals(db),
  }
  const planEnded = endedPlans(db, plans, now)
  if (Object.keys(planEnded).length) facts.plan_ended = planEnded
  const saved = getState<{ at: string; problems?: Record<string, string>; failed?: string[] }>(
    db,
    'collected',
  )
  if (!saved) return facts
  facts.collected_at = saved.at
  // Stale facts, or a provider that failed on the last collection, are unknown to routing.
  const staleMin = (micros(now) - micros(saved.at)) / 60e6
  const unreadable: Record<string, string> = {}
  for (const { id } of config.providers) {
    if (planEnded[id]) continue // No collection changes that.
    if (staleMin > config.unknown_after_min)
      unreadable[id] = `last collected ${Math.floor(staleMin)} minutes ago, too old to trust`
    else if (saved.failed?.includes(id))
      unreadable[id] =
        `its last collection failed${saved.problems?.[id] ? `: ${saved.problems[id]}` : ''}`
  }
  if (Object.keys(unreadable).length) facts.unreadable = unreadable
  return facts
}

/** Records a refusal (the agent harness and Tether call this when a provider refuses a model). */
export function recordRefusal(db: Database, refusal: Omit<Refusal, 'count'>): void {
  db.prepare(
    'INSERT INTO refusals (requested_model, at, role, project, category) VALUES (?, ?, ?, ?, ?)',
  ).run(refusal.requested_model, refusal.at, refusal.role, refusal.project, refusal.category)
}
