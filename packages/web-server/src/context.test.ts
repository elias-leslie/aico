import {
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
      'test',
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
      status: { upsert: (items: unknown[]) => rows.push(...items) },
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
  try {
    const result = await checkContext(db, d.options)
    expect(result.state).toBe('warn')
    expect(d.rows).toHaveLength(1)
    expect(parseRow(d.rows[0])).toMatchObject({
      id: 'jobs/context-unused',
      kind: 'job',
      state: 'warn',
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
