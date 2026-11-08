// The plan and credit math: which lot a draw uses up first, the balance left, the
// last-7-day pace, and which plan is in force.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openUsage, putState } from './db'
import { loadFacts, notePlanUse } from './facts'
import {
  creditFacts,
  currentPlan,
  drawDown,
  type Lot,
  loadPlans,
  type Plan,
  pacePerDay,
  planEndedAt,
  plansText,
} from './plans'
import { storeReading } from './readings'
import { brief, spendRow } from './spend'
import { optionUsage } from './windows'

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
    const facts = creditFacts([grant, open], drawn, '2026-11-04T12:00:00Z')
    expect(facts.balance).toBe(500)
    // The 7 days are Oct 29 to Nov 4: the Nov 1 and Nov 3 draws count, Oct 20 does not.
    expect(facts.pace_per_day_7d).toBe(42.9)
    expect(facts.earliest_expiry).toBeNull()
  })

  it('names the expiry of a lot that still has credits', () => {
    const facts = creditFacts([grant, open], new Map([['2026-11-01', 100]]), '2026-11-04T12:00:00Z')
    expect(facts.balance).toBe(1400)
    expect(facts.earliest_expiry).toBe('2026-12-31T23:59:59Z')
  })
})

describe('an expired lot', () => {
  it('leaves its unused credits out of the balance and the expiry list', () => {
    const old = lot(300, '2026-09-01T00:00:00Z', '2026-10-31T23:59:59Z')
    const now = '2026-11-04T12:00:00Z'
    // 100 drawn came out of the lot that expires first; the other 200 expired unused.
    const facts = creditFacts([old, open], new Map([['2026-10-20', 100]]), now)
    expect(facts.balance).toBe(500)
    expect(facts.earliest_expiry).toBeNull()
    // Only expired credits are left: nothing to run on.
    expect(creditFacts([old], new Map(), now).balance).toBe(0)
    // Expiring exactly now counts as expired.
    expect(creditFacts([lot(50, '2026-09-01T00:00:00Z', now)], new Map(), now).balance).toBe(0)
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

describe('a plan that ended', () => {
  const plan = (over: Partial<Plan>): Plan => ({
    provider: 'claude',
    plan: 'max_20x',
    monthly_usd: 200,
    price_verified: true,
    effective_from: '2026-02-03T00:00:00+00:00',
    effective_to: null,
    evidence: null,
    ...over,
  })
  const END = '2026-11-08T19:20:00+00:00'

  it('is the last end date once no plan is in force; never before it; unknown is not ended', () => {
    const ended = [plan({ effective_to: END })]
    expect(planEndedAt(ended, 'claude', '2026-11-08T19:19:59+00:00')).toBeNull()
    expect(planEndedAt(ended, 'claude', '2026-11-08T19:20:00+00:00')).toBe(END)
    expect(planEndedAt([plan({})], 'claude', '2026-11-09T00:00:00+00:00')).toBeNull()
    expect(planEndedAt(ended, 'codex', '2026-11-09T00:00:00+00:00')).toBeNull()
    const again = [...ended, plan({ effective_from: '2026-11-20T00:00:00+00:00' })]
    expect(planEndedAt(again, 'claude', '2026-11-21T00:00:00+00:00')).toBeNull()
  })

  describe('in the facts, the route and the spend row', () => {
    const NOW = '2026-11-08T20:00:00.000Z'
    const plans = { plans: [plan({ effective_to: END })], lots: [] }
    const read = (
      db: ReturnType<typeof openUsage>,
      at: string,
      used: number,
      resets = '2026-11-13T10:00:00Z',
    ) => {
      storeReading(
        db,
        {
          provider: 'claude',
          window_minutes: 10080,
          observedAt: Date.parse(at),
          used_percent: used,
          resetsAt: Date.parse(resets),
          source: 'claude_statusline',
          plan_type: null,
        },
        0,
      )
      notePlanUse(db, plans, NOW)
    }
    const row = (db: ReturnType<typeof openUsage>) =>
      spendRow(
        { id: 'claude', name: 'Claude' },
        {
          facts: loadFacts(db, plans, NOW),
          plans,
          machine: 'm',
          now: NOW,
          collectedAt: NOW,
          problems: { claude: 'a snapshot is not readable' },
        },
      )

    it('reads no plan, without the old windows and without a warning', () => {
      const db = openUsage(':memory:')
      read(db, '2026-11-08T19:00:00Z', 70)
      const facts = loadFacts(db, plans, NOW)
      expect(facts.plan_ended).toEqual({ claude: END })
      expect(row(db).state).toBe('ok')
      expect(row(db).meaning).toMatch(/^No plan since Nov 8, 2:20 PM EST\.$/)
      expect(
        brief(
          { id: 'claude', name: 'Claude' },
          { facts, plans, machine: 'm', now: NOW, collectedAt: NOW, problems: {} },
        ),
      ).toBe('Claude no plan since Nov 8, 2:20 PM EST')
    })

    it('stays no plan while an open session rewrites the same numbers with a new time', () => {
      const db = openUsage(':memory:')
      read(db, '2026-11-08T19:00:00Z', 70)
      read(db, '2026-11-08T19:40:00Z', 70)
      expect(loadFacts(db, plans, NOW).plan_ended).toEqual({ claude: END })
    })

    it('stays no plan when a rise from before the end is first read after it', () => {
      const db = openUsage(':memory:')
      read(db, '2026-11-08T19:17:00Z', 69)
      read(db, '2026-11-08T19:21:00Z', 70)
      read(db, '2026-11-08T19:35:00Z', 70)
      expect(loadFacts(db, plans, NOW).plan_ended).toEqual({ claude: END })
    })

    it('lifts when the number rises once the end has settled, so a route comes back by itself', () => {
      const db = openUsage(':memory:')
      read(db, '2026-11-08T19:00:00Z', 70)
      read(db, '2026-11-08T19:40:00Z', 70)
      read(db, '2026-11-08T19:55:00Z', 71)
      expect(loadFacts(db, plans, NOW).plan_ended).toBeUndefined()
      expect(row(db).meaning).toContain('Available now')
    })

    it('lifts on use in a new window, but not on its first reading or on a window rolling by itself', () => {
      const db = openUsage(':memory:')
      read(db, '2026-11-08T19:00:00Z', 70)
      read(db, '2026-11-08T23:00:00Z', 5, '2026-11-14T10:00:00Z')
      read(db, '2026-11-08T23:05:00Z', 3, '2026-11-14T10:05:00Z')
      expect(loadFacts(db, plans, NOW).plan_ended).toEqual({ claude: END })
      read(db, '2026-11-08T23:10:00Z', 4, '2026-11-14T10:05:00Z')
      expect(loadFacts(db, plans, NOW).plan_ended).toBeUndefined()
    })

    it('stays lifted once the readings that showed the use are gone; a new end date starts over', () => {
      const db = openUsage(':memory:')
      read(db, '2026-11-08T19:00:00Z', 70)
      read(db, '2026-11-08T19:55:00Z', 71)
      db.prepare('DELETE FROM readings').run()
      notePlanUse(db, plans, NOW)
      expect(loadFacts(db, plans, NOW).plan_ended).toBeUndefined()
      const later = { plans: [plan({ effective_to: '2026-11-08T19:50:00+00:00' })], lots: [] }
      expect(loadFacts(db, later, NOW).plan_ended).toEqual({ claude: '2026-11-08T19:50:00+00:00' })
    })

    it('stays unknown to routing when facts are stale only for providers that still have a plan', () => {
      const db = openUsage(':memory:')
      read(db, '2026-11-08T19:00:00Z', 70)
      putState(db, 'collected', { at: '2026-11-01T00:00:00.000Z' })
      const facts = loadFacts(db, plans, NOW)
      expect(facts.unreadable?.claude).toBeUndefined()
      expect(facts.unreadable?.codex).toContain('too old to trust')
    })

    it('credits still carry a provider without a plan', () => {
      const usage = optionUsage(
        'codex',
        {},
        { codex: { balance: 10, pace_per_day_7d: 1, earliest_expiry: null } },
        { codex: END },
      )
      expect(usage.status).toBe('on_credits')
      expect(usage.windows).toEqual([])
      expect(usage.credits?.balance).toBe(10)
    })
  })
})
