// The Quota page's data (GET /api/usage, packages/usage report.ts) and what it is shown with.

export interface UsageWindow {
  label: string
  state: 'ok' | 'used_up' | 'unknown' | 'not_reported'
  left_percent: number | null
  resets_at: string | null
  length_seconds: number
  resets_in_seconds: number | null
  /** The window in the spend row's words: "weekly used up until Nov 11, 5:35 AM". */
  text: string
}

export interface SpendDay {
  day: string
  recorded: boolean
  credits: number | null
  tokens: number
  requests: number
}

export interface ProjectShare {
  id: string | null
  name: string
  kind: 'project' | 'folder' | 'private' | 'unknown' | 'rest'
  amount: number
  /** 0..1 of the total. */
  share: number
}

/** Where the last days' use came from. `tracked: false`: this provider cannot say. */
export interface ProjectSplit {
  tracked: boolean
  unit: 'credits' | 'tokens' | null
  from: string
  to: string
  total: number
  items: ProjectShare[]
}

export interface UsageProvider {
  id: string
  name: string
  status:
    | 'ok'
    | 'partly_unknown'
    | 'used_up'
    | 'on_credits'
    | 'unknown'
    | 'untracked'
  /** The plain answer to "can I use it now?", ahead of the windows: "Used up until Nov 8, 7:00 PM EST (weekly)". */
  answer: string
  plan: string | null
  windows: UsageWindow[]
  credits: { balance: number; lasts_days: number | null; text: string } | null
  problem: string | null
  spend: {
    unit: 'credits' | 'tokens' | null
    recorded_since: string | null
    days: SpendDay[]
  }
  by_project: ProjectSplit
}

export interface UsageReport {
  as_of: string
  collected_at: string
  providers: UsageProvider[]
}

/** Usage is collected every few minutes; a collection older than this is called old. */
export const COLLECTION_OLD_MS = 30 * 60_000

/** 1,234 -> "1.2K", 39,200,000 -> "39M": counts in a few characters. */
export function compact(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1e9) return `${(value / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`
  if (abs >= 1e6) return `${(value / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`
  if (abs >= 1e4) return `${(value / 1e3).toFixed(0)}K`
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}K`
  return String(Math.round(value))
}

/** "Nov 5" for a local day "2026-11-05"; "Today" for the one matching `today`. */
export function dayLabel(day: string, today?: string): string {
  if (day === today) return 'Today'
  const [year, month, date] = day.split('-').map(Number) as [
    number,
    number,
    number,
  ]
  return new Date(year, month - 1, date).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })
}

/** The local day of a time, as the server writes days. */
export function localDay(ms: number): string {
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** What a day counts in the provider's unit; null when the day was not recorded. */
export function dayValue(
  day: SpendDay,
  unit: 'credits' | 'tokens',
): number | null {
  if (!day.recorded) return null
  return unit === 'credits' ? (day.credits ?? 0) : day.tokens
}

const UNIT_NAME = { credits: 'credits', tokens: 'tokens' } as const

/** A caption for the unit: what the bars count. */
export function unitCaption(unit: 'credits' | 'tokens'): string {
  return unit === 'credits'
    ? 'Credits used per day'
    : 'Tokens per day (cached reads not counted)'
}

/** One bar's sentence, for its tooltip and the chart's text: "Nov 5: 3.8K credits, 5,624 requests". */
export function dayText(
  day: SpendDay,
  unit: 'credits' | 'tokens',
  today?: string,
): string {
  const value = dayValue(day, unit)
  const name = dayLabel(day.day, today)
  if (value === null) return `${name}: not recorded`
  const requests = `${day.requests.toLocaleString('en-US')} request${day.requests === 1 ? '' : 's'}`
  return `${name}: ${compact(value)} ${UNIT_NAME[unit]}, ${requests}`
}

export interface Summary {
  total: number
  peak: number
  recordedDays: number
}

/** Total and biggest day over the recorded days. */
export function summarize(
  days: readonly SpendDay[],
  unit: 'credits' | 'tokens',
): Summary {
  let total = 0
  let peak = 0
  let recordedDays = 0
  for (const day of days) {
    const value = dayValue(day, unit)
    if (value === null) continue
    recordedDays += 1
    total += value
    peak = Math.max(peak, value)
  }
  return { total, peak, recordedDays }
}

/** Bar heights as 0..1 of the provider's biggest day; null for a day that was not recorded. */
export function barHeights(
  days: readonly SpendDay[],
  unit: 'credits' | 'tokens',
): (number | null)[] {
  const { peak } = summarize(days, unit)
  return days.map((day) => {
    const value = dayValue(day, unit)
    return value === null ? null : peak > 0 ? value / peak : 0
  })
}

/** How much of a window is gone (0..1), from its length and what is left to its reset. */
export function windowGone(window: UsageWindow): number | null {
  if (window.resets_in_seconds === null || !window.length_seconds) return null
  return Math.min(
    1,
    Math.max(0, 1 - window.resets_in_seconds / window.length_seconds),
  )
}

/** "Weekly used up until Nov 8" -> the window text starts lowercase ("5h 100% left"); lead with a capital. */
export function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** The days a split counts, from its first and last local day: 7. */
export function splitDays(split: Pick<ProjectSplit, 'from' | 'to'>): number {
  const at = (day: string) => {
    const [y, m, d] = day.split('-').map(Number) as [number, number, number]
    return Date.UTC(y, m - 1, d)
  }
  return Math.round((at(split.to) - at(split.from)) / 86_400_000) + 1
}

/** The heading over a split: "Spent by project, last 7 days" (credits) or "Tokens by project, last 7 days". */
export function splitTitle(split: ProjectSplit): string {
  return `${split.unit === 'credits' ? 'Spent' : 'Tokens'} by project, last ${splitDays(split)} days`
}

/** "62%", or "<1%" for a share that rounds to nothing. */
export function percent(share: number): string {
  const value = Math.round(share * 100)
  return value === 0 && share > 0 ? '<1%' : `${value}%`
}
