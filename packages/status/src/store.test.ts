import { describe, expect, it } from 'vitest'
import { parseRow, RowError } from './row'
import { StatusStore } from './store'

const row = (fields: Record<string, unknown> = {}) =>
  parseRow({
    id: 'a/web',
    what: 'Web',
    kind: 'service',
    machine: 'a',
    state: 'ok',
    meaning: 'Running.',
    ...fields,
  })

describe('StatusStore', () => {
  it('replaces a row by id and stamps when it was written', () => {
    let now = Date.parse('2026-11-03T12:00:00Z')
    const store = new StatusStore(':memory:', () => now)
    store.upsert([row(), row({ id: 'a/job', what: 'Job', kind: 'job' })])
    now += 60_000
    store.upsert([row({ state: 'failed', meaning: 'Exited.' })])
    const result = store.read({ sort: 'what' })
    expect(result.rows.map((item) => [item.id, item.state, item.updated_at])).toEqual([
      ['a/job', 'ok', '2026-11-03T12:00:00.000Z'],
      ['a/web', 'failed', '2026-11-03T12:01:00.000Z'],
    ])
    store.close()
  })

  it('writes a batch all or none, and removes rows', () => {
    const store = new StatusStore(':memory:')
    const bad = { ...row({ id: 'a/two' }), id: undefined as unknown as string }
    expect(() => store.upsert([row({ id: 'a/one' }), bad])).toThrow(RowError)
    expect(store.rows()).toEqual([])
    store.upsert([row()])
    expect(store.remove('a/web')).toBe(true)
    expect(store.remove('a/web')).toBe(false)
    store.close()
  })
})
