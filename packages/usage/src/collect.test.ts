// The collectors against stand-in sources: Claude's snapshot file, Codex session logs and
// OpenCode's usage answer. Facts keep their as-of time; what cannot be read says why.

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { collect } from './collect'
import { openUsage } from './db'
import { latestReadings, loadFacts } from './facts'
import { localDay } from './plans'
import { storeReading } from './readings'
import { brief, spendRows } from './spend'

const NOW = Date.parse('2026-11-04T12:00:00.000Z')
const HOUR = 3600_000
let dir: string
let home: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aico-usage-'))
  home = join(dir, 'home')
  mkdirSync(home)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const io = (over: Partial<Parameters<typeof collect>[1]> = {}) => ({
  dataDir: dir,
  home,
  env: { XDG_STATE_HOME: join(home, 'state'), AICO_CODEX_SESSIONS: join(home, 'codex') },
  fetch: (async () => new Response('{}', { status: 500 })) as typeof fetch,
  now: NOW,
  plans: { plans: [], lots: [] },
  ...over,
})

function writeStatusline(observed: number, used: number, resets: number) {
  mkdirSync(join(home, 'state', 'claude-usage'), { recursive: true })
  writeFileSync(
    join(home, 'state', 'claude-usage', 'rate-limits.json'),
    JSON.stringify({
      observed_at: observed / 1000,
      rate_limits: { seven_day: { used_percentage: used, resets_at: resets / 1000 } },
    }),
  )
}

function tokenCount(at: number, over: { balance?: number; total: number; weekly?: number }) {
  return JSON.stringify({
    timestamp: new Date(at).toISOString(),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { total_tokens: over.total },
        last_token_usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 100 },
      },
      rate_limits: {
        plan_type: 'plus',
        primary: { window_minutes: 300, used_percent: 10, resets_at: (at + 3 * HOUR) / 1000 },
        secondary: {
          window_minutes: 10080,
          used_percent: over.weekly ?? 100,
          resets_at: (at + 30 * HOUR) / 1000,
        },
        credits: over.balance === undefined ? null : { balance: over.balance, unlimited: false },
      },
    },
  })
}

function writeCodexLog(lines: string[]) {
  const day = new Date(NOW)
  const folder = join(
    home,
    'codex',
    String(day.getFullYear()),
    String(day.getMonth() + 1).padStart(2, '0'),
    String(day.getDate()).padStart(2, '0'),
  )
  mkdirSync(folder, { recursive: true })
  const path = join(folder, 'rollout-1.jsonl')
  writeFileSync(
    path,
    `${[
      JSON.stringify({
        type: 'session_meta',
        payload: { id: 't1', cwd: '/srv/workspaces/projects/aico/x' },
      }),
      JSON.stringify({
        type: 'turn_context',
        payload: { model: 'gpt-6.1-sol', service_tier: 'standard' },
      }),
      ...lines,
    ].join('\n')}\n`,
  )
  utimesSync(path, NOW / 1000, NOW / 1000)
  return path
}

describe('Claude', () => {
  it("stores the snapshot's windows with the time they were observed", async () => {
    writeStatusline(NOW - 60_000, 93, NOW + 40 * HOUR)
    const db = openUsage(':memory:')
    const done = await collect(db, io())
    expect(done.failed).toEqual([])
    expect(latestReadings(db, new Date(NOW).toISOString())).toEqual([
      expect.objectContaining({
        provider: 'claude',
        window_minutes: 10080,
        used_percent: 93,
        observed_at: new Date(NOW - 60_000).toISOString(),
        source: 'claude_statusline',
      }),
    ])
  })

  it('says why when the snapshot is not JSON, and still reads the others', async () => {
    mkdirSync(join(home, 'state', 'claude-usage'), { recursive: true })
    writeFileSync(join(home, 'state', 'claude-usage', 'rate-limits.json'), 'not json')
    const db = openUsage(':memory:')
    const done = await collect(db, io())
    expect(done.failed).toEqual(['claude'])
    expect(done.problems.claude).toMatch(/not readable JSON/)
  })
})

describe('readings', () => {
  const event = (observedAt: number, used: number, resetsAt: number | null) => ({
    provider: 'codex',
    window_minutes: 10080,
    observedAt,
    used_percent: used,
    resetsAt,
    source: 'codex_session_log',
    plan_type: null,
  })

  it("keeps a window's use from going down and drops a stale session's older window", () => {
    const db = openUsage(':memory:')
    const reset = NOW + 30 * HOUR
    expect(storeReading(db, event(NOW, 50, reset), 900)).toBe(true)
    expect(storeReading(db, event(NOW + 2000_000, 40, reset), 900)).toBe(true)
    expect(latestReadings(db, new Date(NOW + 3000_000).toISOString())[0]?.used_percent).toBe(50)
    expect(storeReading(db, event(NOW + 3000_000, 30, reset - 10 * HOUR), 900)).toBe(false)
  })

  it('does not repeat an unchanged reading inside the interval', () => {
    const db = openUsage(':memory:')
    expect(storeReading(db, event(NOW, 50, NOW + HOUR), 900)).toBe(true)
    expect(storeReading(db, event(NOW + 60_000, 50, NOW + HOUR), 900)).toBe(false)
    expect(storeReading(db, event(NOW + 60_000, 51, NOW + HOUR), 900)).toBe(true)
  })
})

describe('Codex', () => {
  const lot = {
    provider: 'codex',
    source: 'grant' as const,
    credits: 5000,
    granted_at: '2026-10-01T00:00:00Z',
    expires_at: null,
    value_usd_per_credit: null,
    paid_usd: null,
    evidence: null,
  }

  it('reads the windows, counts the credits drawn from the first report on, and counts nothing twice', async () => {
    const db = openUsage(':memory:')
    const path = writeCodexLog([
      tokenCount(NOW - 3 * HOUR, { balance: 4000, total: 1100 }),
      tokenCount(NOW - 2 * HOUR, { balance: 3900, total: 2200 }),
      tokenCount(NOW - 1 * HOUR, { balance: 3950, total: 3300 }), // a stale session's higher balance
    ])
    const plans = { plans: [], lots: [lot] }
    const done = await collect(db, io({ plans }))
    expect(done.failed).toEqual([])
    const now = new Date(NOW).toISOString()
    const facts = loadFacts(db, plans, now)
    expect(facts.readings.map((r) => [r.provider, r.window_minutes, r.used_percent])).toEqual([
      ['codex', 300, 10],
      ['codex', 10080, 100],
    ])
    const today = localDay(NOW)
    const row = db.prepare('SELECT * FROM daily WHERE day = ?').get(today) as Record<
      string,
      number | string
    >
    expect(row).toMatchObject({
      model: 'gpt-6.1-sol',
      project: 'aico',
      requests: 3,
      input_tokens: 1800,
      cached_input_tokens: 1200,
      output_tokens: 300,
      credits_drawn: 100,
    })
    expect(row.api_equiv_usd).toBeNull()
    // The balance: 5000 in lots, 100 drawn.
    expect(facts.credits.codex?.balance).toBe(4900)

    // Nothing new in the file: nothing is counted again.
    await collect(db, io({ plans }))
    expect((db.prepare('SELECT SUM(credits_drawn) AS n FROM daily').get() as { n: number }).n).toBe(
      100,
    )

    // More lines are read from where the last pass stopped.
    writeFileSync(path, `${tokenCount(NOW, { balance: 3800, total: 4400 })}\n`, { flag: 'a' })
    utimesSync(path, NOW / 1000, NOW / 1000)
    await collect(db, io({ plans }))
    expect((db.prepare('SELECT SUM(credits_drawn) AS n FROM daily').get() as { n: number }).n).toBe(
      200,
    )
  })

  it('records a jump in the balance no lot explains as a new lot', async () => {
    const db = openUsage(':memory:')
    writeCodexLog([
      tokenCount(NOW - 3 * HOUR, { balance: 1000, total: 1100 }),
      tokenCount(NOW - 2 * HOUR, { balance: 13500, total: 2200 }),
    ])
    await collect(db, io())
    expect(db.prepare('SELECT credits FROM detected_lots').all()).toEqual([{ credits: 12500 }])
  })
})

describe('OpenCode Go', () => {
  const answer = {
    usage: {
      rolling: { percent: 12.4, status: 'ok', resetsAt: '2026-11-04T14:00:00Z' },
      weekly: { percent: 5, status: 'ok', resetsAt: '2026-11-09T00:00:00Z' },
      monthly: { percent: 45, status: 'ok', resetsAt: '2026-11-26T20:32:22Z' },
    },
  }

  it('is reported as not set up, not as a failure, until the key is there', async () => {
    const db = openUsage(':memory:')
    const done = await collect(db, io())
    expect(done.failed).toEqual([])
    expect(done.problems['opencode-go']).toMatch(/No OpenCode Go key yet/)
    const rows = spendRows({
      facts: loadFacts(db, { plans: [], lots: [] }, new Date(NOW).toISOString()),
      plans: { plans: [], lots: [] },
      machine: 'm',
      now: new Date(NOW).toISOString(),
      collectedAt: done.at,
      problems: done.problems,
    })
    const row = rows.find((r) => r.id === 'usage/opencode-go')
    expect(row).toMatchObject({ state: 'warn', kind: 'check' })
    expect(row?.meaning).toMatch(/No usage readings yet\. .*No OpenCode Go key yet/)
  })

  it('stores the three windows and sends the key only to OpenCode', async () => {
    const db = openUsage(':memory:')
    mkdirSync(join(dir, 'secrets'))
    writeFileSync(join(dir, 'secrets', 'opencode-go'), 'sk-test\n', { mode: 0o600 })
    const seen: { url: string; auth: string | null }[] = []
    const fetcher = (async (url: string, init: RequestInit) => {
      seen.push({ url, auth: new Headers(init.headers).get('authorization') })
      return new Response(JSON.stringify(answer), { status: 200 })
    }) as typeof fetch
    const done = await collect(db, io({ fetch: fetcher }))
    expect(done.failed).toEqual([])
    expect(seen).toEqual([{ url: 'https://opencode.ai/zen/go/v1/usage', auth: 'Bearer sk-test' }])
    const facts = latestReadings(db, new Date(NOW).toISOString())
    expect(facts.map((r) => [r.window_minutes, r.used_percent])).toEqual([
      [300, 12],
      [10080, 5],
      [43200, 45],
    ])
    expect(JSON.stringify(done)).not.toContain('sk-test')
  })

  it('names a rejected key and a changed answer without echoing either', async () => {
    mkdirSync(join(dir, 'secrets'))
    writeFileSync(join(dir, 'secrets', 'opencode-go'), 'sk-test\n')
    const db = openUsage(':memory:')
    const rejected = await collect(
      db,
      io({ fetch: (async () => new Response('', { status: 401 })) as typeof fetch }),
    )
    expect(rejected.problems['opencode-go']).toBe('OpenCode rejected the key')
    const odd = await collect(
      db,
      io({ fetch: (async () => new Response('{"usage":{}}', { status: 200 })) as typeof fetch }),
    )
    expect(odd.problems['opencode-go']).toBe("OpenCode's usage answer changed shape")
  })
})

describe('the spend card', () => {
  it('says what is left and when it resets in plain words, one row per subscription', async () => {
    writeStatusline(NOW - 60_000, 93, NOW + 40 * HOUR)
    const db = openUsage(':memory:')
    const done = await collect(db, io())
    const nowIso = new Date(NOW).toISOString()
    const input = {
      facts: loadFacts(db, { plans: [], lots: [] }, nowIso),
      plans: { plans: [], lots: [] },
      machine: 'davion-sidarli',
      now: nowIso,
      collectedAt: done.at,
      problems: done.problems,
    }
    const rows = spendRows(input)
    expect(rows.map((r) => r.id)).toEqual(['usage/claude', 'usage/codex', 'usage/opencode-go'])
    expect(rows[0]).toMatchObject({
      what: 'Claude usage',
      state: 'ok',
      next_run: new Date(NOW + 15 * 60_000).toISOString(),
    })
    expect(rows[0]?.meaning).toMatch(/^weekly 7% left, resets Nov \d/)
    expect(brief({ id: 'claude', name: 'Claude' }, input)).toBe('Claude 7% weekly left')
    expect(rows[1]?.meaning).toBe('Unknown. No usage readings yet.')
  })
})
