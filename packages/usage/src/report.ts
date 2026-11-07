// The Quota page's report: per provider, what is left in each window (in the spend row's
// own words), the credits and how long they last, and the spend per day for the last days.
// Spend comes from the daily table; a provider with no daily rows says so instead of zeros.

import { existsSync, statSync } from 'node:fs'
import config from '../data/usage.json' with { type: 'json' }
import { type Database, getState, openUsage, plansPath, usageDbPath } from './db'
import { loadFacts } from './facts'
import { currentPlan, loadPlans, localDay } from './plans'
import { capital, creditText, windowText } from './spend'
import { micros, optionUsage, type Usage, type Window, windowFacts } from './windows'

/** Days of spend the report carries, today included. */
const SPEND_DAYS = 14

export interface ReportWindow {
  label: string
  state: Window['state']
  left_percent: number | null
  resets_at: string | null
  /** Seconds the window lasts, to show how much of it is gone. */
  length_seconds: number
  resets_in_seconds: number | null
  /** The window in the spend row's words: "weekly used up until Nov 11, 5:35 AM". */
  text: string
}

export interface ReportDay {
  day: string
  /** False for a day before the first spend on record: nothing is known, which is not zero. */
  recorded: boolean
  /** Credits drawn that day (null when the provider draws none). */
  credits: number | null
  /** Tokens in, written to cache and out (cached reads are not counted). */
  tokens: number
  requests: number
}

export interface ReportProvider {
  id: string
  name: string
  status: Usage['status']
  /** The state in a sentence that names the window that is out; null while there is room. */
  summary: string | null
  plan: string | null
  windows: ReportWindow[]
  credits: { balance: number; lasts_days: number | null; text: string } | null
  /** Why this provider could not be read on the last collection. */
  problem: string | null
  spend: {
    /** What the bars count: credits when the provider draws them, else tokens, else nothing recorded. */
    unit: 'credits' | 'tokens' | null
    /** First day with spend on record; days before it are not recorded, not zero. */
    recorded_since: string | null
    days: ReportDay[]
  }
}

export interface UsageReport {
  as_of: string
  collected_at: string
  providers: ReportProvider[]
}

/** The last `count` local days ending at today, oldest first. */
function lastDays(now: string, count: number): string[] {
  const today = new Date(micros(now) / 1000)
  return Array.from({ length: count }, (_, i) =>
    localDay(
      new Date(today.getFullYear(), today.getMonth(), today.getDate() - (count - 1 - i)).getTime(),
    ),
  )
}

function spendOf(db: Database, provider: string, days: string[]): ReportProvider['spend'] {
  const first = db
    .prepare('SELECT MIN(day) AS day FROM daily WHERE provider = ?')
    .get(provider) as { day: string | null }
  const rows = db
    .prepare(
      `SELECT day, SUM(credits_drawn) AS credits,
              SUM(input_tokens + cache_write_tokens + output_tokens) AS tokens,
              SUM(requests) AS requests
         FROM daily WHERE provider = ? AND day >= ? AND day <= ? GROUP BY day`,
    )
    .all(provider, days[0] as string, days.at(-1) as string) as unknown as {
    day: string
    credits: number
    tokens: number
    requests: number
  }[]
  const total = db
    .prepare(
      'SELECT SUM(credits_drawn) AS credits, SUM(input_tokens + cache_write_tokens + output_tokens) AS tokens FROM daily WHERE provider = ?',
    )
    .get(provider) as { credits: number | null; tokens: number | null }
  const unit = (total.credits ?? 0) > 0 ? 'credits' : (total.tokens ?? 0) > 0 ? 'tokens' : null
  if (!first.day || !unit) return { unit: null, recorded_since: null, days: [] }
  const byDay = new Map(rows.map((row) => [row.day, row]))
  return {
    unit,
    recorded_since: first.day,
    // A day before the first record is not recorded; from there on a day with no row is a quiet day.
    days: days.map((day) => {
      const row = byDay.get(day)
      return {
        day,
        recorded: day >= (first.day as string),
        credits: unit === 'credits' ? Math.round((row?.credits ?? 0) * 10) / 10 : null,
        tokens: row?.tokens ?? 0,
        requests: row?.requests ?? 0,
      }
    }),
  }
}

/** The report for a data directory, or why there is none (never collected, or unreadable). */
export function usageReport(dataDir: string, now: string): UsageReport | { error: string } {
  const path = usageDbPath(dataDir)
  if (!existsSync(path) || statSync(path).size === 0)
    return { error: 'Aico has not collected usage yet.' }
  let db: Database | null = null
  try {
    db = openUsage(path)
    const saved = getState<{ at: string; problems?: Record<string, string> }>(db, 'collected')
    if (!saved) return { error: 'Aico has not collected usage yet.' }
    const plans = loadPlans(plansPath(dataDir))
    const facts = loadFacts(db, plans, now)
    const windows = windowFacts(facts.readings, now)
    const days = lastDays(now, SPEND_DAYS)
    const providers = config.providers.map((provider): ReportProvider => {
      const usage = optionUsage(provider.id, windows, facts.credits)
      const shown = usage.windows.filter((window) => window.state !== 'not_reported')
      const out = shown.filter((window) => window.state === 'used_up')
      // The state leads, naming the window that is out: a bare "Used up" next to "5h 100% left" contradicts.
      const summary =
        usage.status === 'used_up' && out.length
          ? capital(out.map(windowText).join('; '))
          : usage.status === 'on_credits'
            ? 'Running on credits'
            : usage.status === 'unknown'
              ? 'Unknown'
              : null
      return {
        id: provider.id,
        name: provider.name,
        status: usage.status,
        summary,
        plan: currentPlan(plans.plans, provider.id, now)?.plan ?? null,
        windows: shown.map((window) => ({
          label: window.label,
          state: window.state,
          left_percent: window.left_percent,
          resets_at: window.resets_at,
          length_seconds: window.window_minutes * 60,
          resets_in_seconds: window.resets_in_seconds,
          text: windowText(window),
        })),
        credits: usage.credits
          ? {
              balance: usage.credits.balance,
              lasts_days: usage.credits.lasts_days,
              text: creditText(usage.credits, now),
            }
          : null,
        problem: saved.problems?.[provider.id] ?? facts.unreadable?.[provider.id] ?? null,
        spend: spendOf(db as Database, provider.id, days),
      }
    })
    return { as_of: now, collected_at: saved.at, providers }
  } catch (error) {
    return { error: `Aico's usage could not be read: ${(error as Error).message}` }
  } finally {
    db?.close()
  }
}
