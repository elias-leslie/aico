// The top bar's quota glance, from the usage rows the collector posts to
// Status (`usage/<provider>`, packages/usage spend.ts): what each subscription
// has left in its tightest window. The row's own words stay the tooltip.

import type { StatusRow } from '../status'

export type QuotaState = 'left' | 'credits' | 'used_up' | 'unknown'

export interface QuotaGlance {
  id: string
  /** The subscription's name: "Claude", "OpenCode Go". */
  name: string
  state: QuotaState
  /** Percent left in its tightest window, when it has room. */
  left: number | null
  /** The row's full sentence. */
  meaning: string
  /** The row's own state: warn when used up, unknown or unread. */
  warn: boolean
}

const USAGE_ROW = /^usage\/[^/]+$/

/** One subscription from its Status row. */
function quotaOf(row: StatusRow): QuotaGlance {
  const meaning = row.meaning
  const name = row.what.replace(/ usage$/i, '')
  const percents = [...meaning.matchAll(/(\d+)% left/g)].map((match) =>
    Number(match[1]),
  )
  let state: QuotaState = 'left'
  if (/^Used up\./.test(meaning)) state = 'used_up'
  else if (/^Running on credits\./.test(meaning)) state = 'credits'
  else if (/^Unknown\./.test(meaning) || row.shown === 'unknown')
    state = 'unknown'
  else if (!percents.length) state = 'unknown'
  return {
    id: row.id,
    name,
    state,
    left: state === 'left' ? Math.min(...percents) : null,
    meaning,
    warn: row.state === 'warn' || row.shown === 'unknown',
  }
}

/** Every subscription's glance, in the order Status lists them. */
export function quotaGlances(rows: readonly StatusRow[]): QuotaGlance[] {
  return rows.filter((row) => USAGE_ROW.test(row.id)).map(quotaOf)
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

/** The tooltip: each subscription's own sentence. */
export function quotaTitle(glances: readonly QuotaGlance[]): string {
  return glances.map((glance) => `${glance.name}: ${glance.meaning}`).join('\n')
}
