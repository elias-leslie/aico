// What a subscription has left, from its readings (Agent Hub's launch facts, policy v5,
// field for field). Facts only: nothing here ranks or picks.
//
// - A window reading says how much is used only until its window resets; after that it
//   is unknown, never 0% used. A reading that names no reset reads unknown once it is
//   older than its window.
// - A window that reset while its provider has since read another window is "not
//   reported" (Claude reports only the 7-day one now); it does not make the option unknown.
// - A window at 100% is used up until it resets; a provider with a credit balance runs
//   on credits then.
// - A provider whose plan ended has no plan, whatever its last windows said.

/** One usage-window reading of a subscription. */
export interface Reading {
  provider: string
  window_minutes: number
  observed_at: string
  used_percent: number
  resets_at: string | null
  source: string
}

export interface Credit {
  balance: number
  pace_per_day_7d: number
  earliest_expiry: string | null
}

/** Refusals of one requested model: the newest one's details and how many there are. */
export interface Refusal {
  requested_model: string
  at: string
  role: string | null
  project: string | null
  category: string | null
  count: number
}

export interface Facts {
  readings: Reading[]
  credits: Record<string, Credit>
  /** Newest first. */
  refusals: Refusal[]
  /** When the facts were last collected (ISO); routing says "as of" this. */
  collected_at?: string
  /** Providers whose facts cannot be trusted now, by provider id, with the plain reason. */
  unreadable?: Record<string, string>
  /** Providers with no plan now, by provider id, with when it ended (facts.ts decides). */
  plan_ended?: Record<string, string>
}

export const WINDOW_LABELS: Record<number, string> = {
  300: '5h',
  10080: 'weekly',
  43200: 'monthly',
}

/** An ISO time in microseconds since the epoch (Date keeps only milliseconds). */
export function micros(iso: string): number {
  const match = /\.(\d+)/.exec(iso)
  const fraction = match ? Number((match[1] as string).padEnd(6, '0').slice(0, 6)) : 0
  return Date.parse(iso.replace(/\.\d+/, '')) * 1000 + fraction
}

const seconds = (fromMicros: number, toMicros: number) =>
  Math.max(Math.floor((toMicros - fromMicros) / 1e6), 0)
export const round1 = (value: number) => Math.round(value * 10) / 10

export interface Window {
  window_minutes: number
  label: string
  observed_at: string
  age_seconds: number
  source: string
  used_percent: number | null
  left_percent: number | null
  resets_at: string | null
  resets_in_seconds: number | null
  state: 'ok' | 'used_up' | 'unknown' | 'not_reported'
}

export interface Usage {
  provider: string | null
  status: 'ok' | 'partly_unknown' | 'used_up' | 'on_credits' | 'no_plan' | 'unknown' | 'untracked'
  windows: Window[]
  credits:
    | (Credit & {
        lasts_days: number | null
        reset_at: string | null
        lasts_past_reset: boolean | null
      })
    | null
  unknown_windows: string[]
  /** Why nothing is said about this provider: its facts are stale or its last collection failed. */
  unreadable?: string
  /** With status no_plan: when its plan ended. */
  plan_ended_at?: string
}

/** The reading no longer says how much is used: its reset passed, or it names none and its window is over. */
const lapsed = (reading: Reading, now: number) =>
  reading.resets_at !== null
    ? micros(reading.resets_at) <= now
    : now - micros(reading.observed_at) > reading.window_minutes * 60e6

/**
 * Per provider, one entry per window of its latest readings, shortest first. A
 * reading is unknown only once it has lapsed; then "not reported" when the
 * provider has since read another window that is still current.
 */
export function windowFacts(readings: Reading[], now: string): Record<string, Window[]> {
  const at = micros(now)
  const byProvider = new Map<string, Reading[]>()
  for (const reading of readings)
    byProvider.set(reading.provider, [...(byProvider.get(reading.provider) ?? []), reading])
  const out: Record<string, Window[]> = {}
  for (const [provider, rows] of byProvider) {
    const current = rows.filter((reading) => !lapsed(reading, at))
    out[provider] = [...rows]
      .sort((a, b) => a.window_minutes - b.window_minutes)
      .map((reading) => {
        const base = {
          window_minutes: reading.window_minutes,
          label: WINDOW_LABELS[reading.window_minutes] ?? `${reading.window_minutes}m`,
          observed_at: reading.observed_at,
          age_seconds: seconds(micros(reading.observed_at), at),
          source: reading.source,
          used_percent: null,
          left_percent: null,
          resets_at: null,
          resets_in_seconds: null,
        }
        if (lapsed(reading, at)) {
          const superseded = current.some(
            (other) => micros(other.observed_at) > micros(reading.observed_at),
          )
          return { ...base, state: superseded ? 'not_reported' : 'unknown' } as Window
        }
        const used = round1(reading.used_percent)
        return {
          ...base,
          state: used >= 100 ? 'used_up' : 'ok',
          used_percent: used,
          left_percent: round1(Math.max(100 - used, 0)),
          resets_at: reading.resets_at,
          resets_in_seconds: reading.resets_at ? seconds(at, micros(reading.resets_at)) : null,
        } as Window
      })
  }
  return out
}

/** Of the used-up windows, the one that resets last: usable again only once it does. */
export function lastToReset(windows: Window[]): Window | null {
  return windows
    .filter((window) => window.state === 'used_up')
    .reduce<Window | null>(
      (best, window) =>
        !best || (window.resets_in_seconds ?? 0) > (best.resets_in_seconds ?? 0) ? window : best,
      null,
    )
}

export function optionUsage(
  provider: string | null,
  windows: Record<string, Window[]>,
  credits: Record<string, Credit>,
  planEnded: Record<string, string> = {},
): Usage {
  if (provider === null)
    return { provider: null, status: 'untracked', windows: [], credits: null, unknown_windows: [] }
  const credit = credits[provider]
  // Credits still buy use without a plan; either way the last windows say nothing any more.
  const ended = planEnded[provider]
  const own = ended ? [] : (windows[provider] ?? [])
  if (ended && !(credit && credit.balance > 0))
    return {
      provider,
      status: 'no_plan',
      windows: [],
      credits: null,
      unknown_windows: [],
      plan_ended_at: ended,
    }
  const usedUp = own.filter((window) => window.state === 'used_up')
  let status: Usage['status']
  if (ended) status = 'on_credits'
  else if (usedUp.length) status = credit && credit.balance > 0 ? 'on_credits' : 'used_up'
  else if (own.some((window) => window.state === 'ok'))
    status = own.some((window) => window.state === 'unknown') ? 'partly_unknown' : 'ok'
  else status = 'unknown'
  let outCredit: Usage['credits'] = null
  if (credit) {
    // Until the used-up window resets, else the week: do the credits last that long?
    const ref =
      lastToReset(usedUp) ??
      own.find((window) => window.window_minutes === 10080 && window.state === 'ok')
    const resetIn = ref ? ref.resets_in_seconds : null
    const empty = credit.balance <= 0
    const days = empty
      ? 0
      : credit.pace_per_day_7d > 0
        ? credit.balance / credit.pace_per_day_7d
        : null
    outCredit = {
      ...credit,
      lasts_days: days === null ? null : round1(days),
      reset_at: ref ? ref.resets_at : null,
      lasts_past_reset: empty
        ? false
        : resetIn === null
          ? null
          : days === null || days * 86400 > resetIn,
    }
  }
  return {
    provider,
    status,
    windows: own,
    credits: outCredit,
    unknown_windows: own
      .filter((window) => window.state === 'unknown')
      .map((window) => window.label),
  }
}
