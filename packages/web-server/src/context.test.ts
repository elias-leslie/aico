import {
  bindContextSession,
  COST,
  type CostDelivery,
  deliver,
  openContext,
  recentDeliveries,
  recordDelivery,
  type UseEvent,
} from '@aico/context'
import { parseRow } from '@aico/status'
import { TetherError } from '@aico/tether-client'
import { expect, it } from 'vitest'
import { type ContextDeps, checkContext, nightlyRow, observeContext } from './context'

const now = new Date('2026-11-04T12:00:00Z')
const at = now.getTime() + 1000
function seed() {
  const db = openContext(':memory:')
  for (let n = 0; n < COST.minObservedSessions; n++)
    recordDelivery(
      db,
      deliver(db, {
        tool: 'codex',
        session: `native-${n}`,
        role: 'builder',
        sources: [
          { id: 'file:/project/guide.md', title: 'Guide', type: 'file', text: 'Read the guide.' },
        ],
      }),
      'hook:codex',
      now,
    )
  return db
}
function deps(
  events: UseEvent[] = [{ role: 'assistant', kind: 'text', text: 'Finished.', at }],
  outcome: string | null = 'completed',
) {
  const rows: unknown[] = []
  const notices: Record<string, unknown>[] = []
  const tether = {
    getSession: async () => {
      throw new TetherError(404, 'unknown', {})
    },
    historySession: async () => ({ project: null, outcome }),
    historyEvents: async () => ({ items: events, newer: null, older: null, size: 100 }),
  } as unknown as ContextDeps['tether']
  return {
    rows,
    notices,
    options: {
      dataDir: '',
      machine: 'test',
      publicHost: 'aico.example',
      tether,
      status: { upsert: (items: unknown[]) => rows.push(...items), read: () => ({ rows: [] }) },
      notifier: {
        receive: (notice: Record<string, unknown>) => {
          notices.push(notice)
        },
      },
      now: () => now,
    } as unknown as ContextDeps,
  }
}
it('writes one nightly row and one tray-only info notice when items qualify', async () => {
  const db = seed()
  const d = deps()
  d.options.status.read = () =>
    ({ rows: [{ id: 'jobs/context-unused', next_run: '2026-11-05T09:10:00Z' }] }) as never
  try {
    const result = await checkContext(db, d.options)
    expect(result.state).toBe('warn')
    expect(d.rows).toHaveLength(1)
    expect(parseRow(d.rows[0])).toMatchObject({
      id: 'jobs/context-unused',
      kind: 'job',
      state: 'warn',
      next_run: '2026-11-05T09:10:00.000Z',
    })
    expect(d.notices).toHaveLength(1)
    expect(d.notices[0]).toMatchObject({ push: 'tray', kind: 'info', key: 'context-unused' })
    expect(d.notices[0]!.body).toContain('Guide')
    expect(d.notices[0]).not.toHaveProperty('if_ignored')
  } finally {
    db.close()
  }
})
it('leaves clipped, missing and unfinished transcripts unknown; no unused notice', async () => {
  for (const options of [
    deps([{ role: 'assistant', kind: 'text', text: 'Clipped…', at }]),
    deps(undefined, null),
  ]) {
    const db = seed()
    try {
      await checkContext(db, options.options)
      expect(options.notices).toEqual([])
      expect(
        recentDeliveries(db, now).every((d) => !d.observed && d.items[0]!.use === 'unknown'),
      ).toBe(true)
    } finally {
      db.close()
    }
  }
})
it('marks actual loads as used and never fetches excluded projects', async () => {
  const db = seed()
  const d = deps([
    { role: 'assistant', kind: 'tool_call', text: '/project/guide.md', at, tool: 'read' },
  ])
  try {
    await observeContext(db, d.options.tether, now)
    expect(recentDeliveries(db, now).every((d) => d.items[0]!.use === 'used')).toBe(true)
    db.prepare('UPDATE deliveries SET project = ?').run(COST.excludedProjects[0]!)
    d.options.tether.historyEvents = async () => {
      throw new Error('must not read excluded sessions')
    }
    expect(await observeContext(db, d.options.tether, now)).toBe(0)
  } finally {
    db.close()
  }
})
it('reports missing coverage and an empty inventory honestly', () => {
  expect(nightlyRow([], 0, 'test', now).meaning).toContain('unknown')
  expect(
    nightlyRow([{ observed: false, items: [] } as unknown as CostDelivery], 1, 'test', now).meaning,
  ).toContain('0/1 deliveries fully observed')
})
it('keeps a new delivery unknown when the conversation only answered before it', async () => {
  const db = seed()
  const d = deps([
    { role: 'assistant', kind: 'text', text: 'Older answer.', at: now.getTime() - 1000 },
  ])
  try {
    await checkContext(db, d.options)
    expect(
      recentDeliveries(db, now).every((d) => !d.observed && d.items[0]!.use === 'unknown'),
    ).toBe(true)
    expect(d.notices).toEqual([])
  } finally {
    db.close()
  }
})
it('resolves Tether internal session ids through their public widget ids', async () => {
  const db = openContext(':memory:')
  const d = deps()
  try {
    recordDelivery(
      db,
      deliver(db, {
        tool: 'codex',
        session: 'aico-widget-1234abcd',
        sources: [{ id: 'file:/project/guide.md', title: 'Guide', type: 'file', text: 'Guide.' }],
      }),
      'launch',
      now,
    )
    let called = ''
    d.options.tether.getSession = async (id) => {
      called = id
      return { projectId: null, resumeId: 'native-proof' } as never
    }
    await observeContext(db, d.options.tether, now)
    expect(called).toBe('1234abcd')
    expect(recentDeliveries(db, now)[0]!.observed).toBe(true)
  } finally {
    db.close()
  }
})
function launched(db: ReturnType<typeof openContext>, session = 'aico-widget-1234abcd') {
  recordDelivery(
    db,
    deliver(db, {
      tool: 'codex',
      session,
      sources: [{ id: 'file:/project/guide.md', title: 'Guide', type: 'file', text: 'Guide.' }],
    }),
    'launch',
    now,
  )
}
const source = (db: ReturnType<typeof openContext>) =>
  (db.prepare('SELECT source FROM context_observations').get() as { source: string } | undefined)
    ?.source
it('never saves a guessed history id when Tether no longer knows the session', async () => {
  const db = openContext(':memory:')
  const d = deps()
  const asked: string[] = []
  d.options.tether.historySession = async (id) => {
    asked.push(id)
    return { project: null, outcome: 'completed' } as never
  }
  try {
    launched(db)
    // A guess an older pass saved, in both shapes it took.
    for (const guess of ['codex:1234abcd', 'codex:aico-widget-1234abcd']) {
      db.prepare(
        'INSERT OR REPLACE INTO context_observations (delivery_id, observed_at, complete, source) SELECT id, at, 0, ? FROM deliveries',
      ).run(guess)
      expect(await observeContext(db, d.options.tether, now)).toBe(1)
      expect(asked).toEqual([])
      expect(source(db)).toBe('')
      expect(recentDeliveries(db, now)[0]!.observed).toBe(false)
    }
  } finally {
    db.close()
  }
})
it('reads a launch delivery through the native id its startup hook bound', async () => {
  const db = openContext(':memory:')
  const d = deps()
  let asked = ''
  d.options.tether.historySession = async (id) => {
    asked = id
    return { project: null, outcome: 'completed' } as never
  }
  try {
    launched(db)
    bindContextSession(db, 'codex', 'aico-widget-1234abcd', 'native-uuid')
    expect(await observeContext(db, d.options.tether, now)).toBe(0)
    expect(asked).toBe('codex:native-uuid')
    expect(source(db)).toBe('codex:native-uuid')
    expect(recentDeliveries(db, now)[0]!.observed).toBe(true)
  } finally {
    db.close()
  }
})
it('counts clipped tool calls and interrupted sessions as complete records', async () => {
  const db = seed()
  const d = deps(
    [
      { role: 'assistant', kind: 'tool_call', text: `bash ${'x'.repeat(600)}…`, at, tool: 'bash' },
      { role: 'assistant', kind: 'text', text: 'Stopped here.', at },
    ],
    'aborted',
  )
  try {
    await checkContext(db, d.options)
    expect(recentDeliveries(db, now).every((r) => r.observed)).toBe(true)
    expect(d.notices).toHaveLength(1)
  } finally {
    db.close()
  }
})
it('judges absence from observed sessions; one unobserved session does not hide it', async () => {
  const db = seed()
  const d = deps()
  try {
    launched(db, 'aico-widget-ended000')
    const result = await checkContext(db, d.options)
    expect(recentDeliveries(db, now).filter((r) => r.observed)).toHaveLength(
      COST.minObservedSessions,
    )
    expect(result.state).toBe('warn')
    expect(d.notices[0]!.body).toContain('Guide')
    expect(result.message).toContain('1 sessions unavailable')
  } finally {
    db.close()
  }
})
it('stays green with partial coverage when nothing qualifies', () => {
  const used = {
    observed: true,
    items: [{ use: 'used' }],
    tool: 'codex',
    role: null,
    project: null,
    at: now.toISOString(),
    id: 1,
  } as unknown as CostDelivery
  const unseen = { ...used, id: 2, observed: false } as CostDelivery
  expect(nightlyRow([used, unseen], 1, 'test', now).state).toBe('ok')
  expect(nightlyRow([unseen], 1, 'test', now).state).toBe('warn')
})
