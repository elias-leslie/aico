// The quota glance (top bar, Rail and Panel): what each subscription has left
// in its tightest window, from the same usage report the Quota page reads
// (GET /api/usage). One meaning everywhere: a bar is the share LEFT, and the
// tick on it is how much of the window's time is gone.

import type { UsageProvider, UsageReport, UsageWindow } from '../quota-usage'
import { compact, sentence, windowGone } from '../quota-usage'

export type QuotaState = 'left' | 'credits' | 'used_up' | 'unknown'

export interface QuotaGlance {
  id: string
  /** The subscription's name: "Claude", "OpenCode Go". */
  name: string
  state: QuotaState
  /** Percent left in its tightest window; 0 when used up, null when not known. */
  left: number | null
  /** How much of that window's time is gone (0..100), or null. */
  gone: number | null
  /** The window in words: "Weekly 79% left, resets Nov 13, 5:00 AM". */
  line: string
  /** Everything about it, for a tooltip. */
  meaning: string
  /** Used up or not known. */
  warn: boolean
}

/** What a window has left: 0 when used up, null when not known. */
function leftOf(window: UsageWindow): number | null {
  if (window.state === 'used_up') return 0
  if (window.state === 'ok') return window.left_percent
  return null
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

function glanceOf(provider: UsageProvider): QuotaGlance {
  const window = tightest(provider.windows)
  const left = window ? leftOf(window) : null
  const gone = window ? windowGone(window) : null
  let state: QuotaState
  if (provider.status === 'on_credits') state = 'credits'
  else if (provider.status === 'used_up' || left === 0) state = 'used_up'
  else if (left === null) state = 'unknown'
  else state = 'left'
  const credits = provider.credits
    ? `${compact(provider.credits.balance)} credits left`
    : null
  const line =
    state === 'credits'
      ? `On credits${credits ? `, ${credits}` : ''}`
      : window
        ? sentence(window.text)
        : (provider.summary ?? 'Not read yet')
  const meaning = [
    ...provider.windows.map((item) => sentence(item.text)),
    provider.credits ? sentence(provider.credits.text) : null,
  ]
    .filter(Boolean)
    .join('. ')
  return {
    id: provider.id,
    name: provider.name,
    state,
    left,
    gone: gone === null ? null : Math.round(gone * 100),
    line,
    meaning: meaning || line,
    warn: state === 'used_up' || state === 'unknown',
  }
}

/** Every subscription's glance, in the order the report lists them. */
export function quotaGlances(report: UsageReport | null): QuotaGlance[] {
  return (report?.providers ?? [])
    .filter((provider) => provider.status !== 'untracked')
    .map(glanceOf)
}

const WORD: Record<Exclude<QuotaState, 'left'>, string> = {
  credits: 'on credits',
  used_up: 'used up',
  unknown: 'unknown',
}

/** "Claude 82% · Codex on credits · OpenCode Go used up". Same states share one word. */
export function quotaLine(glances: readonly QuotaGlance[]): string {
  const parts: string[] = []
  for (const glance of glances.filter((item) => item.state === 'left'))
    parts.push(`${glance.name} ${glance.left}%`)
  for (const state of ['credits', 'used_up', 'unknown'] as const) {
    const names = glances
      .filter((item) => item.state === state)
      .map((item) => item.name)
    if (names.length) parts.push(`${names.join(', ')} ${WORD[state]}`)
  }
  return parts.join(' · ')
}

/** The tooltip: each subscription's own sentence, and what the bars mean. */
export function quotaTitle(glances: readonly QuotaGlance[]): string {
  return [
    ...glances.map((glance) => `${glance.name}: ${glance.meaning}`),
    'Bar: share left. Tick: how much of the window’s time is gone.',
  ].join('\n')
}
