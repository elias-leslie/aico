// The quota glance (Rail and Panel): what each subscription has left
// in its tightest window, from the same usage report the Quota page reads
// (GET /api/usage). One meaning everywhere: a bar is how much is LEFT, and the
// tick on it is how far into the window we are. Each provider leads with the
// report's one plain answer to "can I use it now?".

import type { UsageProvider, UsageReport, UsageWindow } from '../quota-usage'
import { compact, sentence, windowGone } from '../quota-usage'

export type QuotaState = 'left' | 'credits' | 'used_up' | 'unknown'

export interface QuotaGlance {
  id: string
  /** The subscription's name: "Claude", "OpenCode Go". */
  name: string
  /** Agent tools that usually run on it under another name (`pi`); they can run elsewhere too. */
  tools: string[]
  state: QuotaState
  /** Percent left in its tightest window; 0 when used up, null when not known. */
  left: number | null
  /** How much of that window's time is gone (0..100), or null. */
  gone: number | null
  /** The plain answer to "can I use it now?": "Running on credits until the Nov 11 reset; 4.5K credits left, enough at the recent pace". */
  answer: string
  /** The day it is usable again when used up or on credits ("Nov 8"), or null. */
  back: string | null
  /** The glance's one short line: "73% left · resets Fri", "credits · 4.5K left, to Nov 11", "used up · back Nov 8". */
  short: string
  /** What a row shows: the window in words while there is room ("Weekly 79% left, resets Nov 13, 5:00 AM"), else the answer. */
  line: string
  /** Everything about it, for a tooltip. */
  meaning: string
  /** Used up or not known. */
  warn: boolean
  /** Some window isn't reporting, so `left` may not be the tightest. */
  partly: boolean
}

/** What a window has left: 0 when used up, null when not known. */
function leftOf(window: UsageWindow): number | null {
  if (window.state === 'used_up') return 0
  if (window.state === 'ok') return window.left_percent
  return null
}

/** "Nov 8" for a time, in this browser's day. */
function shortDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })
}

/** When the last used-up window resets: the day the provider is usable on its own again. */
function backOn(windows: readonly UsageWindow[]): string | null {
  let latest: UsageWindow | null = null
  for (const window of windows) {
    if (window.state !== 'used_up' || !window.resets_at) continue
    if (!latest || (window.resets_at as string) > (latest.resets_at as string))
      latest = window
  }
  return latest?.resets_at ? shortDay(latest.resets_at) : null
}

/** The window with the least left; a used-up window wins, and the later reset of two. */
function tightest(windows: readonly UsageWindow[]): UsageWindow | null {
  let best: UsageWindow | null = null
  for (const window of windows) {
    const left = leftOf(window)
    if (left === null) continue
    const bestLeft = best ? leftOf(best) : null
    if (
      best === null ||
      bestLeft === null ||
      left < bestLeft ||
      (left === bestLeft &&
        (window.resets_in_seconds ?? 0) > (best.resets_in_seconds ?? 0))
    )
      best = window
  }
  return best
}

/** "Fri" for a reset within the week, else "Nov 13". */
function resetDay(iso: string, now: number): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  return at - now < 6 * 86_400_000 && at > now
    ? new Date(at).toLocaleDateString('en-US', { weekday: 'short' })
    : shortDay(iso)
}

function shortLine(
  state: QuotaState,
  left: number | null,
  window: UsageWindow | null,
  back: string | null,
  credits: UsageProvider['credits'],
  now: number,
  windows: readonly UsageWindow[],
): string {
  if (state === 'left') {
    const reset = window?.resets_at ? resetDay(window.resets_at, now) : ''
    return `${left}% left${reset ? ` · resets ${reset}` : ''}`
  }
  if (state === 'credits') {
    const balance = credits ? `${compact(credits.balance)} left` : ''
    return [
      'credits',
      [balance, back ? `to ${back}` : ''].filter(Boolean).join(', '),
    ]
      .filter(Boolean)
      .join(' · ')
  }
  if (state === 'used_up') {
    if (!back) return 'used up'
    // A longer window running low limits what comes back: "back Nov 8 with 5%".
    const after = tightest(windows.filter((item) => item.state !== 'used_up'))
    const afterLeft = after ? leftOf(after) : null
    return afterLeft !== null && afterLeft < 100
      ? `used up · back ${back} with ${afterLeft}%`
      : `used up · back ${back}`
  }
  return 'not reported'
}

function glanceOf(provider: UsageProvider, now: number): QuotaGlance {
  const window = tightest(provider.windows)
  const left = window ? leftOf(window) : null
  const gone = window ? windowGone(window) : null
  let state: QuotaState
  if (provider.status === 'on_credits') state = 'credits'
  else if (provider.status === 'used_up' || left === 0) state = 'used_up'
  else if (left === null) state = 'unknown'
  else state = 'left'
  const line =
    state === 'left' && window ? sentence(window.text) : provider.answer
  const back =
    state === 'credits' || state === 'used_up' ? backOn(provider.windows) : null
  const meaning = [
    provider.answer,
    provider.windows.length
      ? `Windows: ${provider.windows.map((item) => item.text).join('; ')}`
      : null,
  ]
    .filter(Boolean)
    .join('. ')
  return {
    id: provider.id,
    name: provider.name,
    tools: provider.tools ?? [],
    state,
    left,
    gone: gone === null ? null : Math.round(gone * 100),
    answer: provider.answer,
    back,
    short: shortLine(
      state,
      left,
      window,
      back,
      provider.credits,
      now,
      provider.windows,
    ),
    line,
    meaning: meaning || line,
    warn: state === 'used_up' || state === 'unknown',
    partly: provider.status === 'partly_unknown',
  }
}

/** The subscription a tool runs on: they share a name (`claude`, `codex`) in the tool's slug or aliases. */
export function toolGlance(
  glances: readonly QuotaGlance[],
  names: readonly string[],
): QuotaGlance | undefined {
  return glances.find((glance) => names.includes(glance.id))
}

/** For the agent picker, also the subscription a tool usually runs on under another name. */
export function pickerGlance(
  glances: readonly QuotaGlance[],
  names: readonly string[],
): QuotaGlance | undefined {
  return (
    toolGlance(glances, names) ??
    glances.find((glance) => glance.tools.some((tool) => names.includes(tool)))
  )
}

/** The agent picker's few words: "73% left", "on credits", "used up"; nothing when not known. */
export function pickerSuffix(glance: QuotaGlance): string | null {
  if (glance.state === 'credits') return 'on credits'
  if (glance.state === 'used_up') return 'used up'
  return glance.partly || glance.left === null ? null : `${glance.left}% left`
}

/** Every subscription's glance, in the order the report lists them. */
export function quotaGlances(
  report: UsageReport | null,
  now = Date.now(),
): QuotaGlance[] {
  return (report?.providers ?? [])
    .filter((provider) => provider.status !== 'untracked')
    .map((provider) => glanceOf(provider, now))
}

/** "Claude 76% left · Codex on credits until Nov 11 · OpenCode Go used up until Nov 8": each one's answer, short. */
export function quotaLine(glances: readonly QuotaGlance[]): string {
  return glances
    .map((glance) => {
      const until = glance.back ? ` until ${glance.back}` : ''
      if (glance.state === 'left') return `${glance.name} ${glance.left}% left`
      if (glance.state === 'credits') return `${glance.name} on credits${until}`
      if (glance.state === 'used_up') return `${glance.name} used up${until}`
      return `${glance.name} unknown`
    })
    .join(' · ')
}

/** The tooltip: each subscription's own answer and windows, and what the bars mean. */
export function quotaTitle(glances: readonly QuotaGlance[]): string {
  return [
    ...glances.map((glance) => `${glance.name}: ${glance.meaning}`),
    'Bar: how much is left. Tick: how far into the window we are.',
  ].join('\n')
}
