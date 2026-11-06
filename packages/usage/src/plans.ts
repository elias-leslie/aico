// Subscription plans and credit lots (owner data: a file in the Aico data directory, not
// the repo), and the
// credit math on them: which lot a draw uses up first, what is left, and the last-7-day pace.

import { existsSync, readFileSync } from 'node:fs'
import { micros, round1 } from './windows'

/** One plan period per provider; a plan change closes the open one (effective_to) and starts the next. */
export interface Plan {
  provider: string
  plan: string
  /** null: the price is not verified. */
  monthly_usd: number | null
  price_verified: boolean
  effective_from: string
  effective_to: string | null
  evidence: string | null
}

/** A block of provider credits: a grant costs nothing, a purchase costs paid_usd. */
export interface Lot {
  provider: string
  source: 'grant' | 'purchase' | 'unclassified'
  credits: number
  granted_at: string
  expires_at: string | null
  value_usd_per_credit: number | null
  paid_usd: number | null
  evidence: string | null
}

export interface Plans {
  plans: Plan[]
  lots: Lot[]
}

/** The file's text for these plans: sorted, so the same data hashes the same. */
export function plansText(plans: Plans): string {
  const sorted: Plans = {
    plans: [...plans.plans].sort(
      (a, b) =>
        a.provider.localeCompare(b.provider) || micros(a.effective_from) - micros(b.effective_from),
    ),
    lots: [...plans.lots].sort(
      (a, b) => a.provider.localeCompare(b.provider) || micros(a.granted_at) - micros(b.granted_at),
    ),
  }
  return `${JSON.stringify(sorted, null, 2)}\n`
}

/** The plans file, or no plans when it is not there yet; a broken file is an error naming it. */
export function loadPlans(path: string): Plans {
  if (!existsSync(path)) return { plans: [], lots: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`${path} is not readable JSON: ${(error as Error).message}`)
  }
  const value = parsed as Partial<Plans> | null
  if (!value || !Array.isArray(value.plans) || !Array.isArray(value.lots))
    throw new Error(`${path} needs "plans" and "lots" lists`)
  for (const lot of value.lots)
    if (typeof lot.provider !== 'string' || typeof lot.credits !== 'number' || !lot.granted_at)
      throw new Error(`${path}: a lot needs provider, credits and granted_at`)
  for (const plan of value.plans)
    if (typeof plan.provider !== 'string' || !plan.plan || !plan.effective_from)
      throw new Error(`${path}: a plan needs provider, plan and effective_from`)
  return { plans: value.plans, lots: value.lots }
}

/** The plan in force for a provider at a time, or undefined. */
export function currentPlan(plans: Plan[], provider: string, at: string): Plan | undefined {
  const now = micros(at)
  return plans.find(
    (plan) =>
      plan.provider === provider &&
      micros(plan.effective_from) <= now &&
      (plan.effective_to === null || micros(plan.effective_to) > now),
  )
}

export interface LotState {
  lot: Lot
  remaining: number
}

/** Allocates credits drawn to lots, earliest expiry first (no expiry last), then oldest. */
export function drawDown(lots: Lot[], drawn: number): LotState[] {
  const ordered = [...lots].sort(
    (a, b) =>
      (a.expires_at ? micros(a.expires_at) : Number.POSITIVE_INFINITY) -
        (b.expires_at ? micros(b.expires_at) : Number.POSITIVE_INFINITY) ||
      micros(a.granted_at) - micros(b.granted_at),
  )
  let left = drawn
  return ordered.map((lot) => {
    const take = Math.min(lot.credits, Math.max(left, 0))
    left -= take
    return { lot, remaining: lot.credits - take }
  })
}

/** The local calendar day (YYYY-MM-DD) of an instant, in this machine's time zone. */
export function localDay(at: number | string): string {
  const date = new Date(typeof at === 'string' ? Date.parse(at) : at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Credits drawn per day over the last 7 days, today included. */
export function pacePerDay(drawnByDay: Map<string, number>, today: string): number {
  const [year, month, day] = today.split('-').map(Number) as [number, number, number]
  let sum = 0
  for (let back = 0; back < 7; back += 1)
    sum += drawnByDay.get(localDay(new Date(year, month - 1, day - back).getTime())) ?? 0
  return sum / 7
}

/**
 * Balance, the last-7-day pace and the earliest expiry among lots that still have credits at
 * `now` (ISO). Draws are assigned to lots as ever (earliest expiry first); a lot that expired
 * by `now` keeps what was left of it out of the balance.
 */
export function creditFacts(
  lots: Lot[],
  drawnByDay: Map<string, number>,
  now: string,
): { balance: number; pace_per_day_7d: number; earliest_expiry: string | null } {
  const today = localDay(now)
  const drawn = [...drawnByDay.values()].reduce((sum, value) => sum + value, 0)
  const states = drawDown(lots, drawn).filter(
    (state) => !state.lot.expires_at || micros(state.lot.expires_at) > micros(now),
  )
  const balance = states.reduce((sum, state) => sum + state.remaining, 0)
  const expiries = states
    .filter((state) => state.remaining > 0 && state.lot.expires_at)
    .map((state) => state.lot.expires_at as string)
    .sort((a, b) => micros(a) - micros(b))
  return {
    balance: round1(balance),
    pace_per_day_7d: round1(pacePerDay(drawnByDay, today)),
    earliest_expiry: expiries[0] ?? null,
  }
}
