// The spend card: one Status row per subscription, in plain words: what is left in each
// window, when it resets, and the credits behind it. State is ok while the subscription
// has room (or credits carry it) and warn when it is used up, unknown, or could not be read.

import { localTime } from '@aico/shared/time'
import type { StatusRow } from '@aico/status'
import config from '../data/usage.json' with { type: 'json' }
import { currentPlan, type Plans } from './plans'
import { type Facts, micros, optionUsage, type Usage, type Window, windowFacts } from './windows'

/** A moment in this machine's local time with its zone: "Nov 6, 5:00 AM EST". */
export const when = (iso: string) => localTime(micros(iso) / 1000)

export function ago(seconds: number): string {
  if (seconds < 90) return 'just now'
  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`
  if (seconds < 172800) return `${Math.round(seconds / 3600)} h ago`
  return `${Math.round(seconds / 86400)} days ago`
}

const count = (value: number) =>
  value >= 10000
    ? `${(value / 1000).toFixed(0)}K`
    : value >= 1000
      ? `${(value / 1000).toFixed(1)}K`
      : String(Math.round(value))

export function windowText(window: Window): string {
  if (window.state === 'used_up')
    return `${window.label} used up${window.resets_at ? ` until ${when(window.resets_at)}` : ''}`
  if (window.state === 'unknown')
    return `${window.label} not reported this time; last known ${ago(window.age_seconds)}`
  // A window nothing has drawn from yet has no reset to speak of (OpenCode names "now + 5h").
  const resets = window.resets_at && window.left_percent !== 100
  return `${window.label} ${window.left_percent}% left${resets ? `, resets ${when(window.resets_at as string)}` : ''}`
}

/** A day in this machine's local time: "Nov 9". */
const day = (at: Date | number | string) =>
  new Date(typeof at === 'string' ? micros(at) / 1000 : at).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })

/** The balance and how long it lasts, as a date against the reset: "runs out about Nov 9, before
 * the Nov 11 reset", "lasts past the Nov 11 reset". `now` is when the facts were read. */
export function creditText(
  credit: NonNullable<Usage['credits']>,
  now: string | number = Date.now(),
): string {
  let text = `${count(credit.balance)} credits left`
  const nowMs = typeof now === 'string' ? micros(now) / 1000 : now
  const reset = credit.reset_at ? ` ${day(credit.reset_at)} reset` : ' reset'
  if (credit.lasts_past_reset === false && credit.lasts_days !== null && credit.balance > 0)
    text += `, runs out about ${day(nowMs + credit.lasts_days * 86_400_000)}, before the${reset}`
  else if (credit.lasts_past_reset === true && credit.reset_at)
    text += `, lasts past the ${day(credit.reset_at)} reset at the recent pace`
  else if (credit.lasts_days !== null && credit.balance > 0)
    text += ` (about ${credit.lasts_days} days at the recent pace)`
  if (credit.earliest_expiry) text += `, the earliest expire ${when(credit.earliest_expiry)}`
  return text
}

export const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

const LEAD: Partial<Record<Usage['status'], string>> = {
  on_credits: 'Running on credits. ',
  used_up: 'Used up. ',
  unknown: 'Unknown. ',
}

export interface SpendInput {
  facts: Pick<Facts, 'readings' | 'credits'>
  plans: Plans
  machine: string
  now: string
  /** When the facts were last collected (ISO). */
  collectedAt: string
  /** Why a provider could not be read on the last collection, by provider id. */
  problems: Record<string, string>
}

/** The one row of a provider. */
export function spendRow(provider: { id: string; name: string }, input: SpendInput): StatusRow {
  const usage = optionUsage(
    provider.id,
    windowFacts(input.facts.readings, input.now),
    input.facts.credits,
  )
  const shown = usage.windows.filter((w) => w.state !== 'not_reported')
  // Used up: lead with the window that is out and when it comes back, then the others; a bare
  // "Used up." next to "5h 100% left" reads as a contradiction.
  const out = usage.status === 'used_up' ? shown.filter((w) => w.state === 'used_up') : []
  const lead = out.length
    ? `${capital(out.map(windowText).join('; '))}. `
    : (LEAD[usage.status] ?? '')
  const parts = shown.filter((w) => !out.includes(w)).map(windowText)
  if (usage.credits) parts.push(creditText(usage.credits, input.now))
  const problem = input.problems[provider.id]
  let meaning =
    `${lead}${parts.length ? `${parts.join('; ')}.` : out.length ? '' : 'No usage readings yet.'}`.trim()
  if (problem) meaning += ` ${problem}.`
  const plan = currentPlan(input.plans.plans, provider.id, input.now)
  if (plan && meaning.length + plan.plan.length < 280) meaning += ` Plan: ${plan.plan}.`
  const fine =
    usage.status === 'ok' || usage.status === 'partly_unknown' || usage.status === 'on_credits'
  return {
    id: `usage/${provider.id}`,
    what: `${provider.name} usage`,
    kind: 'check',
    machine: input.machine,
    project: 'aico',
    state: fine && !problem ? 'ok' : 'warn',
    meaning: meaning.length > 300 ? `${meaning.slice(0, 299)}…` : meaning,
    last_run: new Date(micros(input.collectedAt) / 1000).toISOString(),
    next_run: new Date(
      micros(input.collectedAt) / 1000 + config.late_after_min * 60_000,
    ).toISOString(),
    actions: [{ kind: 'run', ref: 'aico usage collect' }],
  }
}

/** The spend card: a row for every provider in data/usage.json. */
export function spendRows(input: SpendInput): StatusRow[] {
  return config.providers.map((provider) => spendRow(provider, input))
}

/** A provider in a few words, for the line a collection job reports. */
export function brief(provider: { id: string; name: string }, input: SpendInput): string {
  const usage = optionUsage(
    provider.id,
    windowFacts(input.facts.readings, input.now),
    input.facts.credits,
  )
  const problem = input.problems[provider.id]
  if (usage.status === 'on_credits') return `${provider.name} on credits`
  if (usage.status === 'used_up') {
    const out = usage.windows.find((w) => w.state === 'used_up')
    return `${provider.name} ${out ? `${out.label} ` : ''}used up${out?.resets_at ? ` until ${when(out.resets_at)}` : ''}`
  }
  const open = usage.windows.filter((w) => w.state === 'ok')
  const tightest = open.sort((a, b) => (a.left_percent as number) - (b.left_percent as number))[0]
  if (tightest) return `${provider.name} ${tightest.left_percent}% ${tightest.label} left`
  return `${provider.name} ${problem ? 'not readable' : 'unknown'}`
}
