import { describe, expect, it } from 'vitest'
import { projectLines } from './cli'
import { openUsage } from './db'
import { projectSplit } from './split'

const DAYS = ['2026-11-01', '2026-11-02', '2026-11-03']

function seed() {
  const db = openUsage(':memory:')
  const put = db.prepare(
    `INSERT INTO daily (day, provider, model, project, speed, requests, input_tokens, output_tokens, credits_drawn)
     VALUES (?, ?, 'm', ?, 'standard', 1, ?, ?, ?)`,
  )
  put.run('2026-11-01', 'claude', 'aico', 600, 100, 0)
  put.run('2026-11-02', 'claude', 'aico', 100, 100, 0)
  put.run('2026-11-02', 'claude', 'vault', 100, 0, 0)
  put.run('2026-11-02', 'claude', 'scratch-thing', 60, 0, 0)
  put.run('2026-11-03', 'claude', 'private', 50, 0, 0)
  put.run('2026-11-03', 'claude', 'unknown', 0, 0, 0)
  put.run('2026-10-20', 'claude', 'aico', 9999, 0, 0) // outside the days
  put.run('2026-11-03', 'codex', 'aico', 10, 5, 30)
  put.run('2026-11-03', 'codex', 'vault', 1, 1, 10)
  put.run('2026-11-03', 'opencode-go', 'aico', 10, 5, 0)
  return db
}

const registry = [
  { id: 'aico', name: 'Aico' },
  { id: 'vault', name: 'Vault' },
]

describe('usage by project', () => {
  it('names registered projects, groups the rest and keeps shares of the whole', () => {
    const split = projectSplit(seed(), 'claude', 'tokens', DAYS, registry)
    expect(split.tracked).toBe(true)
    expect(split.unit).toBe('tokens')
    expect(split.total).toBe(1110)
    expect(split.items.map((i) => [i.name, i.kind, i.amount])).toEqual([
      ['Aico', 'project', 900],
      ['Vault', 'project', 100],
      ['scratch-thing', 'folder', 60],
      ['Private work', 'private', 50],
    ])
    expect(split.items[0]?.share).toBeCloseTo(900 / 1110)
    expect(split.items.reduce((sum, i) => sum + i.share, 0)).toBeCloseTo(1)
  })

  it('splits Codex by the credits it spent', () => {
    const split = projectSplit(seed(), 'codex', 'credits', DAYS, registry)
    expect(split.unit).toBe('credits')
    expect(split.items.map((i) => [i.name, i.amount])).toEqual([
      ['Aico', 30],
      ['Vault', 10],
    ])
  })

  it('says a provider without working directories is not tracked by project', () => {
    const split = projectSplit(seed(), 'opencode-go', 'tokens', DAYS, registry)
    expect(split).toMatchObject({ tracked: false, items: [], total: 0 })
  })

  it('shows folder names when there is no registry, and nothing when nothing is recorded', () => {
    const db = seed()
    expect(projectSplit(db, 'claude', 'tokens', DAYS).items.map((i) => i.name)).toContain(
      'scratch-thing',
    )
    expect(projectSplit(db, 'claude', null, DAYS, registry)).toMatchObject({
      tracked: true,
      unit: null,
      items: [],
    })
  })

  it('folds projects past the top few into one row', () => {
    const db = openUsage(':memory:')
    for (let i = 0; i < 11; i += 1)
      db.prepare(
        `INSERT INTO daily (day, provider, model, project, speed, input_tokens) VALUES ('2026-11-03', 'claude', 'm', ?, 'standard', ?)`,
      ).run(`p${i}`, 100 - i)
    const refs = Array.from({ length: 11 }, (_, i) => ({ id: `p${i}`, name: `P${i}` }))
    const split = projectSplit(db, 'claude', 'tokens', DAYS, refs)
    expect(split.items).toHaveLength(9)
    expect(split.items.at(-1)).toMatchObject({ kind: 'rest', name: '3 more' })
  })
})

describe('aico usage show by-project lines', () => {
  it('prints a block per provider and says what is not tracked', () => {
    const db = seed()
    const providers = [
      ['claude', 'Claude', 'tokens'],
      ['codex', 'Codex', 'credits'],
      ['opencode-go', 'OpenCode Go', 'tokens'],
    ] as const
    const text = projectLines({
      as_of: '',
      collected_at: '',
      providers: providers.map(([id, name, unit]) => ({
        id,
        name,
        by_project: projectSplit(db, id, unit, DAYS, registry),
      })),
    } as never)
    expect(text).toContain('Claude by project, last 7 days (1.1K tokens):')
    expect(text).toContain('Aico')
    expect(text).toContain('81%')
    expect(text).toContain('Codex by project, last 7 days (40 credits spent):')
    expect(text).toContain('OpenCode Go by project: not tracked by project.')
  })

  it('reports why there is nothing instead of zeros', () => {
    expect(projectLines({ error: 'Aico has not collected usage yet.' })).toContain(
      'not available (Aico has not collected usage yet.)',
    )
  })
})
