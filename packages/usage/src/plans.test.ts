// The plan and credit math: which lot a draw uses up first, the balance left, the
// last-7-day pace, and which plan is in force.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  creditFacts,
  currentPlan,
  drawDown,
  type Lot,
  loadPlans,
  type Plan,
  pacePerDay,
  plansText,
} from './plans'

const lot = (credits: number, granted_at: string, expires_at: string | null): Lot => ({
  provider: 'codex',
  source: 'grant',
  credits,
  granted_at,
  expires_at,
  value_usd_per_credit: null,
  paid_usd: null,
  evidence: null,
})

const grant = lot(1000, '2026-09-30T00:00:00Z', '2026-12-31T23:59:59Z')
const open = lot(500, '2026-10-20T00:00:00Z', null)

describe('drawDown', () => {
  it('uses the lot that expires first, a lot with no expiry last', () => {
    const states = drawDown([open, grant], 1200)
    expect(states.map((s) => [s.lot.credits, s.remaining])).toEqual([
      [1000, 0],
      [500, 300],
    ])
  })

  it('never goes negative and ignores a negative draw', () => {
    expect(drawDown([grant], 5000)[0]?.remaining).toBe(0)
    expect(drawDown([grant], -5)[0]?.remaining).toBe(1000)
  })
})

describe('creditFacts', () => {
  const drawn = new Map([
    ['2026-11-01', 100],
    ['2026-11-03', 200],
    ['2026-10-20', 700],
  ])

  it('gives the balance, the 7-day pace and the earliest expiry among lots with credits', () => {
    const facts = creditFacts([grant, open], drawn, '2026-11-04')
    expect(facts.balance).toBe(500)
    // The 7 days are Oct 29 to Nov 4: the Nov 1 and Nov 3 draws count, Oct 20 does not.
    expect(facts.pace_per_day_7d).toBe(42.9)
    expect(facts.earliest_expiry).toBeNull()
  })

  it('names the expiry of a lot that still has credits', () => {
    const facts = creditFacts([grant, open], new Map([['2026-11-01', 100]]), '2026-11-04')
    expect(facts.balance).toBe(1400)
    expect(facts.earliest_expiry).toBe('2026-12-31T23:59:59Z')
  })
})

describe('pacePerDay', () => {
  it('counts the last 7 days including today, across a month end', () => {
    const drawn = new Map([
      ['2026-10-30', 70],
      ['2026-11-04', 70],
      ['2026-10-28', 1000],
    ])
    expect(pacePerDay(drawn, '2026-11-04')).toBe(20)
  })
})

describe('currentPlan', () => {
  const plan = (name: string, from: string, to: string | null): Plan => ({
    provider: 'codex',
    plan: name,
    monthly_usd: null,
    price_verified: false,
    effective_from: from,
    effective_to: to,
    evidence: null,
  })
  const plans = [
    plan('pro', '2026-05-05T00:00:00Z', '2026-05-07T00:00:00Z'),
    plan('plus', '2026-05-07T00:00:00Z', null),
  ]

  it('finds the plan in force at a time', () => {
    expect(currentPlan(plans, 'codex', '2026-05-06T00:00:00Z')?.plan).toBe('pro')
    expect(currentPlan(plans, 'codex', '2026-11-04T00:00:00Z')?.plan).toBe('plus')
    expect(currentPlan(plans, 'codex', '2026-05-01T00:00:00Z')).toBeUndefined()
    expect(currentPlan(plans, 'claude', '2026-11-04T00:00:00Z')).toBeUndefined()
  })
})

describe('the plans file', () => {
  it('round-trips, is empty when absent and refuses a broken file by name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aico-usage-'))
    try {
      expect(loadPlans(join(dir, 'none.json'))).toEqual({ plans: [], lots: [] })
      const path = join(dir, 'plans.json')
      writeFileSync(path, plansText({ plans: [], lots: [open, grant] }))
      expect(loadPlans(path).lots.map((l) => l.credits)).toEqual([1000, 500])
      writeFileSync(path, '{"plans": []}')
      expect(() => loadPlans(path)).toThrow(/plans\.json needs "plans" and "lots"/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
