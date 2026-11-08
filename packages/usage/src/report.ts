// The Quota page's report: per provider, what is left in each window (in the spend row's
// own words), the credits and how long they last, and the spend per day for the last days.
// Spend comes from the daily table; a provider with no daily rows says so instead of zeros.

import { existsSync, statSync } from 'node:fs'
import config from '../data/usage.json' with { type: 'json' }
import { type Database, getState, openUsage, plansPath, usageDbPath } from './db'
import { loadFacts } from './facts'
import { currentPlan, loadPlans, localDay } from './plans'
import { answerText, creditText, windowText } from './spend'
import { type ProjectRef, type ProjectSplit, projectSplit } from './split'
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
  /** The plain answer to "can I use it now?", ahead of the windows: "Used up until Nov 8, 7:00 PM EST (weekly)". */
  answer: string
  /** The agent tools that usually run on this subscription when their name differs from its id. */
  tools: string[]
  plan: string | null
  windows: ReportWindow[]
  credits: { balance: number; lasts_days: number | null; text: string } | null
  /** Why this provider could not be read on the last collection. */
  problem: string | null
  /** Why routing can't trust this provider's numbers (collection failed or too old), else null. */
  unreadable: string | null
  spend: {
    /** What the bars count: credits when the provider draws them, else tokens, else nothing recorded. */
    unit: 'credits' | 'tokens' | null
    /** First day with spend on record; days before it are not recorded, not zero. */
    recorded_since: string | null
    days: ReportDay[]
  }
  /** Where the last days' use came from, by project; `tracked: false` for a provider that cannot say. */
  by_project: ProjectSplit
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
export function usageReport(
  dataDir: string,
  now: string,
  projects?: readonly ProjectRef[],
): UsageReport | { error: string } {
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
    const splitDays = lastDays(now, config.project_split.days)
    const providers = config.providers.map((provider): ReportProvider => {
      const usage = optionUsage(provider.id, windows, facts.credits)
      const shown = usage.windows.filter((window) => window.state !== 'not_reported')
      const spend = spendOf(db as Database, provider.id, days)
      return {
        id: provider.id,
        name: provider.name,
        status: usage.status,
        answer: answerText(usage, now),
        tools: provider.tools ?? [],
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
        unreadable: facts.unreadable?.[provider.id] ?? null,
        spend,
        by_project: projectSplit(db as Database, provider.id, spend.unit, splitDays, projects),
      }
    })
    return { as_of: now, collected_at: saved.at, providers }
  } catch (error) {
    return { error: `Aico's usage could not be read: ${(error as Error).message}` }
  } finally {
    db?.close()
  }
}
