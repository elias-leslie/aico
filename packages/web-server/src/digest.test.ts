import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openUsage, usageDbPath } from '@aico/usage'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildDigest, type DigestDeps, QUIET_MINUTES, registerDigestRoutes } from './digest'
import { liveSessions, registerHistoryRoutes } from './history'
import { Router } from './http'

const NOW = new Date(2026, 10, 6, 7, 30).getTime()
const MIN = 60_000

const conv = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  tool: 'claude-code',
  parentId: null,
  project: 'aico',
  cwd: '/srv/workspaces/projects/aico',
  startedAt: NOW - 3_600_000,
  endedAt: NOW - 30 * MIN,
  outcome: 'completed',
  ...over,
})

function fakeTether(opts: {
  sessions?: Record<string, unknown>[]
  history?: Record<string, unknown>[]
  bySession?: Record<string, Record<string, unknown>[] | Error>
  failHistory?: boolean
  failSessions?: boolean
}) {
  const calls: unknown[] = []
  return {
    calls,
    listSessions: async () => {
      calls.push('list')
      if (opts.failSessions) throw new Error('down')
      return opts.sessions ?? []
    },
    history: async (o: { session?: string; limit?: number }) => {
      calls.push(o)
      if (o.session) {
        const found = opts.bySession?.[o.session]
        if (found instanceof Error) throw found
        return { items: found ?? [] }
      }
      if (opts.failHistory) throw new Error('down')
      return { items: opts.history ?? [] }
    },
  } as never as DigestDeps['tether'] & { calls: unknown[] }
}

const session = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  tool: 'claude-code',
  status: 'running',
  state: 'working',
  ...over,
})

describe('liveSessions', () => {
  it('reads the newest conversation of each agent session on this computer', async () => {
    const tether = fakeTether({
      sessions: [
        session('a1', { state: 'idle' }),
        session('b2'),
        session('c3', { host: 'gem' }),
        session('d4', { tool: 'aico-agent' }),
        session('e5', { tool: 'shell' }),
        session('f6', { state: 'weird' }),
      ],
      bySession: {
        a1: [conv('conv-a', { endedAt: 5000 })],
        b2: new Error('transcript unreadable'),
        f6: [],
      },
    })
    const live = await liveSessions(tether)
    expect(live.map(({ asking: _a, ...rest }) => rest)).toEqual([
      { session: 'a1', conversation: 'conv-a', activity: 'idle', lastWriteAt: 5000 },
      { session: 'b2', conversation: null, activity: 'working', lastWriteAt: null },
      { session: 'f6', conversation: null, activity: 'unknown', lastWriteAt: null },
    ])
    expect(tether.calls).toContainEqual({ session: 'a1', limit: 1 })
  })
})

describe('history routes', () => {
  let server: Server
  let base: string
  let now = NOW
  let tether: ReturnType<typeof fakeTether>
  beforeEach(async () => {
    tether = fakeTether({
      sessions: [session('a1')],
      history: [conv('x'), conv('y', { project: 'aico-m10d2-live' })],
      bySession: { a1: [conv('conv-a', { endedAt: 1234 })] },
    })
    const router = new Router()
    registerHistoryRoutes(router, tether as never, undefined, () => now)
    server = createServer((req, res) => {
      void router.handle(req, res, new URL(req.url || '/', 'http://localhost'))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })
  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())))

  it('marks test runs on the history list', async () => {
    const body = (await (await fetch(`${base}/api/history`)).json()) as {
      items: { id: string; test: boolean }[]
    }
    expect(body.items.map((i) => [i.id, i.test])).toEqual([
      ['x', false],
      ['y', true],
    ])
  })

  it('answers /api/history/live from the cache for ten seconds', async () => {
    const ask = async () => (await fetch(`${base}/api/history/live`)).json()
    expect(await ask()).toEqual({
      items: [{ session: 'a1', conversation: 'conv-a', activity: 'working', lastWriteAt: 1234 }],
    })
    await ask()
    expect(tether.calls.filter((c) => c === 'list')).toHaveLength(1)
    now += 10_001
    await ask()
    expect(tether.calls.filter((c) => c === 'list')).toHaveLength(2)
  })
})

describe('buildDigest', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aico-digest-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const status = (problems = 2, failed = 1) =>
    ({ read: () => ({ summary: { problems, counts: { failed } } }) }) as never
  const asks = (...createdAt: number[]) => ({
    list: async () => createdAt.map((c) => ({ createdAt: c, state: 'open' as const })),
  })

  function deps(over: Partial<DigestDeps> & { tether?: DigestDeps['tether'] } = {}): DigestDeps {
    return {
      dataDir: dir,
      tether: fakeTether({}),
      asks: asks(),
      status: status(),
      ...over,
    }
  }

  it('counts finished and failed, leaving out test runs, old ones and running conversations', async () => {
    const since = NOW - 8 * 3_600_000
    const tether = fakeTether({
      sessions: [session('a1', { state: 'idle' })],
      history: [
        conv('ok'),
        conv('bad', { outcome: 'error' }),
        conv('stopped', { outcome: 'aborted' }),
        conv('mid', { outcome: null }),
        conv('old', { endedAt: since - 1 }),
        conv('smoke', { project: 'live-smoke-codex-1-2' }),
        conv('current'),
      ],
      bySession: { a1: [conv('current')] },
    })
    const d = await buildDigest(deps({ tether }), since, NOW)
    expect(d).toMatchObject({ finished: 3, failed: 2, unavailable: ['spend'] })
  })

  it('counts waiting and quiet sessions', async () => {
    const tether = fakeTether({
      sessions: [
        session('a1', { state: 'blocked' }),
        session('b2', { asks: [{ blocking: true }], state: 'idle' }),
        session('c3'),
        session('d4'),
        session('e5', { state: 'idle' }),
      ],
      bySession: {
        a1: [conv('1')],
        b2: [conv('2')],
        c3: [conv('3', { endedAt: NOW - (QUIET_MINUTES + 1) * MIN })],
        d4: [conv('4', { endedAt: NOW - 2 * MIN })],
        e5: [conv('5', { endedAt: NOW - 60 * MIN })],
      },
    })
    const d = await buildDigest(deps({ tether }), NOW - 3_600_000, NOW)
    expect(d.stuck).toEqual({ waiting: 2, quiet: 1 })
  })

  it('counts asks since, reads status and spend', async () => {
    const since = NOW - 3_600_000
    const db = openUsage(usageDbPath(dir))
    const ins = db.prepare(
      'INSERT INTO daily (day, provider, model, project, credits_drawn) VALUES (?, ?, ?, ?, ?)',
    )
    ins.run('2026-11-06', 'codex', 'm', 'p', 12.5)
    ins.run('2026-11-06', 'codex', 'm2', 'p', 2.5)
    ins.run('2026-11-05', 'codex', 'm', 'p', 99)
    ins.run('2026-11-06', 'claude', 'm', 'p', 0)
    db.close()
    const d = await buildDigest(deps({ asks: asks(since - 1, since, NOW) }), since, NOW)
    expect(d.asks).toBe(2)
    expect(d.problems).toEqual({ count: 2, failed: 1 })
    expect(d.spend).toEqual({ sinceDay: '2026-11-06', items: [{ provider: 'codex', credits: 15 }] })
    expect(d.unavailable).toEqual([])
  })

  it('counts only questions still waiting, not ones asked and already closed', async () => {
    const since = NOW - 3_600_000
    const ask = (state: 'open' | 'answered' | 'done' | 'withdrawn', createdAt = NOW) => ({
      state,
      createdAt,
    })
    const d = await buildDigest(
      deps({
        asks: {
          list: async () => [
            ask('open'),
            ask('open', since - 1),
            ask('answered'),
            ask('done'),
            ask('withdrawn'),
          ],
        },
      }),
      since,
      NOW,
    )
    expect(d.asks).toBe(1)
  })

  it('names each source it cannot read and keeps the rest', async () => {
    const d = await buildDigest(
      deps({
        tether: fakeTether({ failHistory: true, failSessions: true }),
        asks: { list: async () => Promise.reject(new Error('x')) },
        status: {
          read: () => {
            throw new Error('x')
          },
        } as never,
      }),
      NOW - MIN,
      NOW,
    )
    expect(d.unavailable.sort()).toEqual(['asks', 'history', 'sessions', 'spend', 'status'])
    expect(d.finished).toBe(0)
    expect(d.spend).toBeNull()
  })
})

describe('digest routes', () => {
  let dir: string
  let server: Server
  let base: string
  let now: number
  let notices: Record<string, unknown>[]
  let problems: number
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aico-digest-push-'))
    now = NOW
    problems = 0
    notices = []
    const router = new Router()
    registerDigestRoutes(router, {
      dataDir: dir,
      publicHost: 'aico.example',
      tether: fakeTether({ history: [conv('ok'), conv('bad', { outcome: 'error' })] }),
      asks: { list: async () => [] },
      status: {
        read: () => ({ summary: { problems, counts: { failed: 0 } } }),
      } as never,
      notifier: { receive: (n: unknown) => notices.push(n as Record<string, unknown>) } as never,
      now: () => now,
    })
    server = createServer((req, res) => {
      void router.handle(req, res, new URL(req.url || '/', 'http://localhost'))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  })
  const push = async () => (await fetch(`${base}/api/digest/push`, { method: 'POST' })).json()

  it('answers GET /api/digest and checks since', async () => {
    const get = (q: string) => fetch(`${base}/api/digest${q}`)
    expect((await get('')).status).toBe(400)
    expect((await get('?since=abc')).status).toBe(400)
    expect((await get(`?since=${NOW + 1}`)).status).toBe(400)
    const ok = await get(`?since=${NOW - 3_600_000}`)
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ finished: 2, failed: 1, generatedAt: NOW })
    const old = (await (await get('?since=1000')).json()) as { since: number }
    expect(old.since).toBe(NOW - 14 * 86_400_000)
  })

  it('pushes once a day with the day as its key', async () => {
    expect(await push()).toEqual({ pushed: true })
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({
      v: 1,
      source: 'aico',
      kind: 'info',
      severity: 'info',
      push: 'phone',
      key: 'digest:2026-11-06',
      cooldown: 86400,
      title: 'While you were away: 2 finished, 1 failed',
    })
    expect(String(notices[0]?.body)).toContain('Open Aico to see the day.')
    expect(JSON.parse(readFileSync(join(dir, 'digest-push.json'), 'utf8'))).toEqual({
      at: NOW,
      day: '2026-11-06',
    })
    expect(await push()).toEqual({ pushed: false, reason: 'already sent today' })
    expect(notices).toHaveLength(1)
  })

  it('skips when nothing is new but still records the day, then looks since the last push', async () => {
    now = NOW + 3 * 86_400_000
    problems = 0
    // The two conversations ended before the window that starts 24 h ago.
    expect(await push()).toEqual({ pushed: false, reason: 'nothing new' })
    expect(notices).toHaveLength(0)
    expect(await push()).toEqual({ pushed: false, reason: 'already sent today' })
    now += 86_400_000
    problems = 3
    expect(await push()).toEqual({ pushed: true })
    expect(notices[0]).toMatchObject({ title: 'While you were away: 3 problems' })
  })
})
