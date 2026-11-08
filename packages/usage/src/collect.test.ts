// The collectors against stand-in sources: Claude's snapshot file, Codex session logs and
// OpenCode's usage answer. Facts keep their as-of time; what cannot be read says why.

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { collectCodex } from './codex'
import { collect } from './collect'
import { openUsage } from './db'
import { latestReadings, loadFacts } from './facts'
import { localDay } from './plans'
import { storeReading } from './readings'
import { brief, spendRow, spendRows } from './spend'

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

function writeCodexLog(
  lines: string[],
  where: { root?: string; daysAgo?: number; name?: string; cwd?: string; meta?: object } = {},
) {
  const day = new Date(NOW - (where.daysAgo ?? 0) * 24 * HOUR)
  const folder = join(
    where.root ?? join(home, 'codex'),
    String(day.getFullYear()),
    String(day.getMonth() + 1).padStart(2, '0'),
    String(day.getDate()).padStart(2, '0'),
  )
  mkdirSync(folder, { recursive: true })
  const path = join(folder, where.name ?? 'rollout-1.jsonl')
  writeFileSync(
    path,
    `${[
      JSON.stringify({
        type: 'session_meta',
        payload: {
          id: 't1',
          cwd: where.cwd ?? '/srv/workspaces/projects/aico/x',
          ...where.meta,
        },
      }),
      JSON.stringify({
        type: 'turn_context',
        payload: { model: 'gpt-6.1-sol', service_tier: 'standard' },
      }),
      ...lines,
    ].join('\n')}\n`,
  )
  const stamp = (NOW - (where.daysAgo ?? 0) * 24 * HOUR) / 1000
  utimesSync(path, stamp, stamp)
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
    expect(row?.meaning).toMatch(
      /^Can’t tell yet: no current usage reading\. .*No OpenCode Go key yet/,
    )
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
    expect(rows[0]?.meaning).toMatch(/^Available now\. Windows: weekly 7% left, resets Nov \d/)
    expect(brief({ id: 'claude', name: 'Claude' }, input)).toBe('Claude 7% weekly left')
    expect(rows[1]?.meaning).toBe('Can’t tell yet: no current usage reading.')
  })
})

describe('facts that cannot be trusted', () => {
  it('takes the real collection time and marks old or failed providers unreadable', async () => {
    writeStatusline(NOW - 60_000, 40, NOW + 40 * HOUR)
    const db = openUsage(':memory:')
    const done = await collect(db, io())
    const at = new Date(NOW).toISOString()
    const fresh = loadFacts(db, { plans: [], lots: [] }, at)
    expect(fresh.collected_at).toBe(done.at)
    // The Codex and OpenCode readings failed or were never set up; Claude read fine.
    expect(fresh.unreadable?.claude).toBeUndefined()
    expect(fresh.unreadable?.['opencode-go']).toBeUndefined()
    // Five days on with no new collection: every provider reads unknown.
    const later = new Date(NOW + 5 * 24 * HOUR).toISOString()
    const stale = loadFacts(db, { plans: [], lots: [] }, later)
    expect(Object.keys(stale.unreadable ?? {}).sort()).toEqual(['claude', 'codex', 'opencode-go'])
    expect(stale.collected_at).toBe(done.at)
  })

  it('marks a provider whose last collection failed', async () => {
    mkdirSync(join(home, 'state', 'claude-usage'), { recursive: true })
    writeFileSync(join(home, 'state', 'claude-usage', 'rate-limits.json'), '{not json')
    const db = openUsage(':memory:')
    const done = await collect(db, io())
    expect(done.failed).toEqual(['claude'])
    const facts = loadFacts(db, { plans: [], lots: [] }, done.at)
    expect(facts.unreadable?.claude).toMatch(/^its last collection failed/)
    expect(facts.unreadable?.codex).toBeUndefined()
  })
})

describe('Codex across runs and homes', () => {
  const requests = (db: ReturnType<typeof openUsage>) =>
    (db.prepare('SELECT SUM(requests) AS n FROM daily').get() as { n: number | null }).n ?? 0
  const lines = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) =>
      tokenCount(NOW - (n - i) * 60_000, { total: 1100 * (from + i + 1) }),
    )

  it('counts the same lines once when two collects run over them', async () => {
    const file = join(dir, 'shared.db')
    const first = openUsage(file)
    const second = openUsage(file)
    writeCodexLog(lines(3))
    await collect(first, io())
    await collect(second, io())
    expect(requests(first)).toBe(3)
    first.close()
    second.close()
  })

  it('replaces what a shrunk or rewritten file added instead of adding to it', async () => {
    const db = openUsage(':memory:')
    const path = writeCodexLog(lines(4))
    await collect(db, io())
    expect(requests(db)).toBe(4)
    // Shorter file.
    writeCodexLog(lines(2))
    await collect(db, io())
    expect(requests(db)).toBe(2)
    // Longer again, different first line (another session wrote it).
    writeCodexLog(lines(3), { meta: { id: 't2' } })
    await collect(db, io())
    expect(requests(db)).toBe(3)
    // Nothing changed: nothing moves.
    await collect(db, io())
    expect(requests(db)).toBe(3)
    expect(path).toBeTruthy()
  })

  it('reads the tail only of a file nobody wrote to since the cutover', () => {
    const db = openUsage(':memory:')
    const pad = JSON.stringify({
      type: 'event_msg',
      payload: { type: 'other', text: 'x'.repeat(900) },
    })
    const path = writeCodexLog(
      [
        tokenCount(NOW - 50 * HOUR, { total: 1100, balance: 4000 }),
        ...Array.from({ length: 400 }, () => pad),
        tokenCount(NOW - 49 * HOUR, { total: 2200, balance: 3000 }),
      ],
      { daysAgo: 2 },
    )
    const result = collectCodex(db, {
      roots: [join(home, 'codex')],
      homes: [`${home}/`],
      isPrivate: () => false,
      now: NOW,
      cutoverDay: localDay(NOW),
      lotTimes: [],
    })
    expect(result.readings).toBeGreaterThan(0)
    expect(result.bytes).toBeLessThan(300_000)
    expect(requests(db)).toBe(0)
    expect(db.prepare('SELECT credits_drawn FROM daily').all()).toEqual([])
    expect(path).toBeTruthy()
  })

  it('skips the lines a subagent inherited from its parent', async () => {
    const db = openUsage(':memory:')
    const numbered = (ordinal: number, total: number) =>
      JSON.stringify({
        ordinal,
        ...JSON.parse(tokenCount(NOW - 60_000 * (5 - ordinal), { total })),
      })
    writeCodexLog([numbered(0, 1100), numbered(1, 2200), numbered(2, 3300), numbered(3, 4400)], {
      meta: { subagent_history_start_ordinal: 2 },
    })
    await collect(db, io())
    expect(requests(db)).toBe(2)
  })

  it('reads a long-running session in an old day folder, and not a folder older than the lookback', async () => {
    const db = openUsage(':memory:')
    const path = writeCodexLog(lines(1), { daysAgo: 7 })
    utimesSync(path, NOW / 1000, NOW / 1000)
    await collect(db, io())
    expect(requests(db)).toBe(1)
    // Three days on, the session appends to the folder it began in, now outside the lookback.
    const later = NOW + 72 * HOUR
    writeFileSync(path, `${tokenCount(later, { total: 9900 })}\n`, { flag: 'a' })
    utimesSync(path, later / 1000, later / 1000)
    await collect(db, io({ now: later }))
    expect(requests(db)).toBe(2)
    // A file nobody has read, in a folder older than the lookback, is not walked.
    writeCodexLog(lines(2), { daysAgo: 12, name: 'rollout-2.jsonl' })
    await collect(db, io({ now: later }))
    expect(requests(db)).toBe(2)
  })

  it('reads every native home, keeps only numbers from a private one, and says nothing of it', async () => {
    const db = openUsage(':memory:')
    const hostHomes = join(home, 'host-homes')
    const open = join(hostHomes, 'agent-work')
    const hidden = join(hostHomes, 'neri-test')
    const env = {
      XDG_STATE_HOME: join(home, 'state'),
      AICO_NATIVE_HOMES: ['~', `${hostHomes}/*`].join(delimiter),
    }
    // This home, an ordinary host copy, and a copy whose name marks it private.
    writeCodexLog(lines(1), { root: join(home, '.codex', 'sessions') })
    writeCodexLog(lines(2, 1), { root: join(open, '.codex', 'sessions') })
    writeCodexLog(lines(3, 3), {
      root: join(hidden, '.codex', 'sessions'),
      cwd: '/srv/workspaces/projects/neri-secret',
    })
    for (const [folder, used] of [
      [open, 30],
      [hidden, 60],
    ] as const) {
      mkdirSync(join(folder, '.local', 'state', 'claude-usage'), { recursive: true })
      writeFileSync(
        join(folder, '.local', 'state', 'claude-usage', 'rate-limits.json'),
        JSON.stringify({
          observed_at: (NOW - 5000 + used * 10) / 1000,
          rate_limits: {
            seven_day: { used_percentage: used, resets_at: (NOW + 40 * HOUR) / 1000 },
          },
        }),
      )
    }
    const done = await collect(db, io({ env }))
    expect(done.failed).toEqual([])
    expect(requests(db)).toBe(6)
    // Claude's newest-wins merge saw both host snapshots (the higher use stands).
    expect(
      latestReadings(db, new Date(NOW).toISOString()).find((r) => r.provider === 'claude')
        ?.used_percent,
    ).toBe(60)
    // Nothing of the private home is stored or reported: not its name, a path, a working directory or an id.
    const stored = JSON.stringify([
      db.prepare('SELECT * FROM daily').all(),
      db.prepare('SELECT * FROM cursors').all(),
      db.prepare('SELECT * FROM state').all(),
      db.prepare('SELECT * FROM readings').all(),
      done,
    ])
    expect(stored).not.toMatch(/neri/i)
    expect(stored).not.toContain('hidden')
    expect(
      db.prepare("SELECT SUM(requests) AS n FROM daily WHERE project = 'private'").get(),
    ).toEqual({ n: 3 })
  })

  it('hides a cursor saved earlier for a file that is now private, and keeps counting it', async () => {
    const db = openUsage(':memory:')
    const path = writeCodexLog(lines(2), { cwd: '/srv/workspaces/projects/neri-old' })
    // As an older collector saved it: path, working directory and id in the clear.
    db.prepare('INSERT INTO cursors (path, offset, state) VALUES (?, 0, ?)').run(
      path,
      JSON.stringify({ cwd: '/srv/workspaces/projects/neri-old', id: 't1' }),
    )
    await collect(db, io())
    const dump = JSON.stringify(db.prepare('SELECT * FROM cursors').all())
    expect(dump).not.toMatch(/neri/i)
    expect(dump).not.toContain(path)
    expect(dump).not.toContain('"t1"')
    expect(requests(db)).toBe(2)
    await collect(db, io())
    expect(requests(db)).toBe(2)
    expect(
      db.prepare("SELECT SUM(requests) AS n FROM daily WHERE project = 'private'").get(),
    ).toEqual({ n: 2 })
  })
})

describe('Claude Code transcripts', () => {
  const assistant = (
    id: string,
    model: string,
    usage: { input?: number; read?: number; write?: number; output?: number },
    over: { at?: number; cwd?: string } = {},
  ) =>
    JSON.stringify({
      type: 'assistant',
      isSidechain: false,
      timestamp: new Date(over.at ?? NOW).toISOString(),
      cwd: over.cwd ?? '/srv/workspaces/projects/aico',
      message: {
        id,
        model,
        role: 'assistant',
        content: [{ type: 'text', text: 'never kept' }],
        usage: {
          input_tokens: usage.input ?? 0,
          cache_read_input_tokens: usage.read ?? 0,
          cache_creation_input_tokens: usage.write ?? 0,
          output_tokens: usage.output ?? 0,
          speed: 'standard',
        },
      },
    })
  const folder = () => join(home, '.claude', 'projects', '-srv-workspaces-projects-aico')
  const write = (path: string, lines: string[]) => {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, `${lines.join('\n')}\n`)
    utimesSync(path, NOW / 1000, NOW / 1000)
  }
  const rows = (db: ReturnType<typeof openUsage>) =>
    db
      .prepare(
        `SELECT day, model, project, requests, input_tokens AS input, cached_input_tokens AS cached,
                cache_write_tokens AS written, output_tokens AS output
         FROM daily WHERE provider = 'claude' AND day >= '2026-11-04' ORDER BY model, project`,
      )
      .all()
  const run = (db: ReturnType<typeof openUsage>) => collect(db, io())

  it('records per-model, per-project tokens from sessions and subagent sidechains', async () => {
    const db = openUsage(':memory:')
    write(join(folder(), 's1.jsonl'), [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'never kept' } }),
      assistant('m1', 'claude-opus-5-5', { input: 2, read: 100, write: 10, output: 50 }),
      assistant('m2', 'claude-opus-5-5', { input: 3, read: 200, output: 20 }),
      assistant('x', '<synthetic>', { input: 9, output: 9 }),
      assistant('old', 'claude-opus-5-5', { input: 9, output: 9 }, { at: NOW - 3 * 24 * HOUR }),
    ])
    write(join(folder(), 's1', 'subagents', 'agent-a.jsonl'), [
      assistant(
        's1',
        'claude-haiku-5-5',
        { input: 1, read: 5, output: 7 },
        { cwd: '/srv/workspaces/projects/summitflow/x' },
      ),
    ])
    await run(db)
    expect(rows(db)).toEqual([
      {
        day: '2026-11-04',
        model: 'claude-haiku-5-5',
        project: 'summitflow',
        requests: 1,
        input: 1,
        cached: 5,
        written: 0,
        output: 7,
      },
      {
        day: '2026-11-04',
        model: 'claude-opus-5-5',
        project: 'aico',
        requests: 2,
        input: 5,
        cached: 300,
        written: 10,
        output: 70,
      },
    ])
  })

  it('counts a streamed message once and reads only what was appended', async () => {
    const db = openUsage(':memory:')
    const path = join(folder(), 's2.jsonl')
    write(path, [
      assistant('m1', 'claude-sonnet-5-5', { input: 2, read: 100, output: 1 }),
      assistant('m1', 'claude-sonnet-5-5', { input: 2, read: 100, output: 40 }),
    ])
    await run(db)
    expect(rows(db)).toEqual([
      {
        day: '2026-11-04',
        model: 'claude-sonnet-5-5',
        project: 'aico',
        requests: 1,
        input: 2,
        cached: 100,
        written: 0,
        output: 40,
      },
    ])
    // Nothing new: a second pass changes nothing.
    await run(db)
    expect(rows(db)[0]).toMatchObject({ requests: 1, output: 40 })
    // The same message grows in a later pass, and a new one arrives.
    appendFileSync(
      path,
      `${assistant('m1', 'claude-sonnet-5-5', { input: 2, read: 100, output: 60 })}\n${assistant('m2', 'claude-sonnet-5-5', { input: 1, output: 5 })}\n`,
    )
    await run(db)
    expect(rows(db)).toEqual([
      {
        day: '2026-11-04',
        model: 'claude-sonnet-5-5',
        project: 'aico',
        requests: 2,
        input: 3,
        cached: 100,
        written: 0,
        output: 65,
      },
    ])
    const cursor = db.prepare('SELECT offset FROM cursors WHERE path = ?').get(path) as {
      offset: number
    }
    expect(cursor.offset).toBeGreaterThan(0)
  })

  it('replaces what a shrunk or rewritten transcript added instead of adding to it', async () => {
    const db = openUsage(':memory:')
    const path = join(folder(), 's3.jsonl')
    const message = (id: string) =>
      assistant(id, 'claude-opus-5-5', { input: 1, read: 10, write: 5, output: 2 })
    write(path, [message('m1'), message('m2'), message('m3')])
    await run(db)
    expect(rows(db)[0]).toMatchObject({ requests: 3, input: 3, cached: 30, written: 15, output: 6 })
    // Shorter file.
    write(path, [message('m1')])
    await run(db)
    expect(rows(db)[0]).toMatchObject({ requests: 1, input: 1, cached: 10, written: 5, output: 2 })
    // Longer again, different first line (another session wrote it).
    write(path, [message('n1'), message('n2')])
    await run(db)
    expect(rows(db)[0]).toMatchObject({ requests: 2, input: 2, cached: 20, written: 10, output: 4 })
    // Nothing changed: nothing moves.
    await run(db)
    expect(rows(db)[0]).toMatchObject({ requests: 2, input: 2, cached: 20, written: 10, output: 4 })
  })

  it('keeps only numbers from a private working directory', async () => {
    const db = openUsage(':memory:')
    write(join(folder(), 's3.jsonl'), [
      assistant(
        'm1',
        'claude-opus-5-5',
        { input: 1, output: 2 },
        { cwd: '/srv/workspaces/projects/neri-hunters/case' },
      ),
    ])
    await run(db)
    expect(rows(db)).toEqual([
      {
        day: '2026-11-04',
        model: 'claude-opus-5-5',
        project: 'private',
        requests: 1,
        input: 1,
        cached: 0,
        written: 0,
        output: 2,
      },
    ])
    const stored = JSON.stringify(db.prepare('SELECT path, state FROM cursors').all())
    expect(stored).not.toContain('neri')
    expect(stored).not.toContain('s3')
  })
})

describe('a used-up subscription', () => {
  it('names the window that is used up and when it resets, before the others', () => {
    const iso = (ms: number) => new Date(ms).toISOString()
    const reading = (window_minutes: number, used_percent: number, resets: number) => ({
      provider: 'opencode-go',
      window_minutes,
      observed_at: iso(NOW - 60_000),
      used_percent,
      resets_at: iso(resets),
      source: 'test',
      plan_type: null,
    })
    const input = {
      facts: {
        readings: [
          reading(300, 0, NOW + 3 * HOUR),
          reading(10080, 100, NOW + 30 * HOUR),
          reading(43200, 95, NOW + 300 * HOUR),
        ],
        credits: {},
      },
      plans: { plans: [], lots: [] },
      machine: 'm',
      now: iso(NOW),
      collectedAt: iso(NOW),
      problems: {},
    }
    const [, , row] = spendRows(input)
    expect(row?.meaning).toMatch(
      /^Used up until Nov \d+, [^.]+ E[SD]T \(weekly\)\. Windows: 5h 100% left; weekly used up until Nov \d+, [^.]+ E[SD]T; monthly 5% left, resets Nov \d+, [^.]+ E[SD]T\.$/,
    )
    expect(row?.meaning).not.toContain('Used up.')
    // The fallback subscription's used-up week is information (usage.json says so), not a problem;
    // the same facts on a provider with no such flag are a warning.
    expect(row?.state).toBe('ok')
    expect(spendRow({ id: 'opencode-go', name: 'OpenCode Go' }, input).state).toBe('warn')
    expect(brief({ id: 'opencode-go', name: 'OpenCode Go' }, input)).toMatch(
      /^OpenCode Go weekly used up until Nov \d+/,
    )
  })
})
