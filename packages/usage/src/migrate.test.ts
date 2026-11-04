// The Agent Hub import against a stand-in source: it runs again without changing anything,
// copies only the days before the cutover, reports matching hashes, and replaces its refusals.

import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openUsage, putState } from './db'
import { DAILY_COLUMNS, importAgentHub, storedDailyText, type UsageSource } from './migrate'

const NOW = Date.parse('2026-11-04T12:00:00Z')
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aico-migrate-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const daily = (day: string, requests: number) =>
  Object.fromEntries(
    DAILY_COLUMNS.map((column) => [
      column,
      {
        day,
        provider: 'codex',
        model: 'gpt-6.1-sol',
        project: 'aico',
        speed: 'standard',
        requests,
        input_tokens: 10,
        cached_input_tokens: 5,
        cache_write_tokens: 0,
        output_tokens: 2,
        api_equiv_usd: null,
        unpriced_tokens: 0,
        credits_drawn: 1.5,
      }[column],
    ]),
  )

function hub(
  over: { refusals?: object[]; lots?: object[]; days?: ReturnType<typeof daily>[] } = {},
) {
  const days = over.days ?? [
    daily('2026-11-02', 3),
    daily('2026-11-03', 4),
    daily('2026-11-04', 9), // the cutover day: the collector counts it, not the import
  ]
  const source: UsageSource = {
    rows(sql) {
      if (sql.includes('FROM subscription_plans'))
        return [
          JSON.stringify({
            provider: 'codex',
            plan: 'Plus',
            monthly_usd: 20,
            price_verified: true,
            effective_from: '2026-10-01T00:00:00Z',
            effective_to: null,
            evidence: null,
          }),
        ]
      if (sql.includes('FROM credit_lots'))
        return (over.lots ?? []).map((lot) => JSON.stringify(lot))
      if (sql.includes('FROM subscription_usage_daily')) {
        const cutover = /day < '([^']+)'/.exec(sql)?.[1] as string
        const lines = days
          .filter((row) => (row.day as string) < cutover)
          .map((r) => JSON.stringify(r))
        if (sql.includes('string_agg'))
          return [JSON.stringify(createHash('sha256').update(lines.join('\n')).digest('hex'))]
        return lines
      }
      if (sql.includes('FROM subscription_usage_snapshots'))
        return [
          JSON.stringify({
            provider: 'codex',
            window_minutes: 10080,
            observed_at: '2026-11-04T10:00:00+00:00',
            used_percent: 40,
            resets_at: '2026-11-09T00:00:00+00:00',
            source: 'codex_session_log',
            plan_type: 'plus',
          }),
        ]
      if (sql.includes('FROM session_events'))
        return (over.refusals ?? []).map((refusal) => JSON.stringify(refusal))
      throw new Error('unexpected query')
    },
  }
  return source
}

const refusal = (model: string) => ({
  at: '2026-11-03T10:00:00Z',
  requested_model: model,
  category: 'policy',
  role: 'recon',
  project: 'aico',
})

describe('importAgentHub', () => {
  it('copies only the days before the cutover and the hashes match', () => {
    const db = openUsage(':memory:')
    putState(db, 'cutover_day', '2026-11-04')
    const result = importAgentHub(db, hub(), { plansPath: join(dir, 'plans.json'), now: NOW })
    expect(result).toMatchObject({
      cutoverDay: '2026-11-04',
      daily: 2,
      readings: 1,
      plansFile: 'written',
    })
    expect(result.dailyHash.match).toBe(true)
    expect(result.dailyHash.received).toBe(result.dailyHash.stored)
    expect(db.prepare('SELECT day FROM daily ORDER BY day').all()).toEqual([
      { day: '2026-11-02' },
      { day: '2026-11-03' },
    ])
  })

  it('runs again without changing anything, and keeps rows the collector counted', () => {
    const db = openUsage(':memory:')
    putState(db, 'cutover_day', '2026-11-04')
    const options = { plansPath: join(dir, 'plans.json'), now: NOW }
    const first = importAgentHub(db, hub(), options)
    // The collector's own row on the cutover day, and a reading of its own.
    db.prepare(
      "INSERT INTO daily (day, provider, model, project, speed, requests) VALUES ('2026-11-04', 'codex', 'm', 'p', 'standard', 7)",
    ).run()
    const before = storedDailyText(db, '2026-11-05')
    const second = importAgentHub(db, hub(), options)
    expect(second.dailyHash).toEqual(first.dailyHash)
    expect(second.plansFile).toBe('unchanged')
    expect(storedDailyText(db, '2026-11-05')).toBe(before)
    expect(db.prepare('SELECT COUNT(*) AS n FROM readings').get()).toEqual({ n: 1 })
    expect(db.prepare("SELECT requests FROM daily WHERE day = '2026-11-04'").get()).toEqual({
      requests: 7,
    })
  })

  it('takes the cutover day from today on the first run, and keeps it afterwards', () => {
    const db = openUsage(':memory:')
    const options = { plansPath: join(dir, 'plans.json'), now: NOW }
    expect(importAgentHub(db, hub(), options).cutoverDay).toBe('2026-11-04')
    expect(importAgentHub(db, hub(), { ...options, now: NOW + 5 * 86400_000 }).cutoverDay).toBe(
      '2026-11-04',
    )
  })

  it('replaces its refusals each run and leaves the collector alone', () => {
    const db = openUsage(':memory:')
    putState(db, 'cutover_day', '2026-11-04')
    const options = { plansPath: join(dir, 'plans.json'), now: NOW }
    importAgentHub(db, hub({ refusals: [refusal('model-a'), refusal('model-b')] }), options)
    db.prepare(
      "INSERT INTO refusals (requested_model, at, imported) VALUES ('model-own', '2026-11-04T09:00:00Z', 0)",
    ).run()
    const result = importAgentHub(db, hub({ refusals: [refusal('model-c')] }), options)
    expect(result.refusals).toBe(1)
    expect(
      db.prepare('SELECT requested_model FROM refusals ORDER BY requested_model').all(),
    ).toEqual([{ requested_model: 'model-c' }, { requested_model: 'model-own' }])
  })

  it('keeps an existing plans file that differs, unless told to replace it', () => {
    const db = openUsage(':memory:')
    const plansPath = join(dir, 'plans.json')
    importAgentHub(db, hub(), { plansPath, now: NOW })
    expect(existsSync(plansPath)).toBe(true)
    const changed = hub({
      lots: [
        { provider: 'codex', source: 'grant', credits: 100, granted_at: '2026-10-01T00:00:00Z' },
      ],
    })
    expect(importAgentHub(db, changed, { plansPath, now: NOW }).plansFile).toBe('differs')
    expect(importAgentHub(db, changed, { plansPath, now: NOW, replacePlans: true }).plansFile).toBe(
      'written',
    )
    expect(importAgentHub(db, changed, { plansPath, now: NOW }).plansFile).toBe('unchanged')
  })

  it('does not match when the stored rows differ from what the source hashed', () => {
    const db = openUsage(':memory:')
    putState(db, 'cutover_day', '2026-11-04')
    const lying: UsageSource = {
      rows: (sql) =>
        sql.includes('string_agg') ? [JSON.stringify('0'.repeat(64))] : hub().rows(sql),
    }
    const result = importAgentHub(db, lying, { plansPath: join(dir, 'plans.json'), now: NOW })
    expect(result.dailyHash.match).toBe(false)
  })
})
