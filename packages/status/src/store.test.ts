import { describe, expect, it } from 'vitest'
import { parseRow, RowError } from './row'
import { machineId, StatusStore } from './store'

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

  it('shows a machine off since the first report that said so, not its latest', () => {
    let now = Date.parse('2026-11-08T05:00:00Z')
    const store = new StatusStore(':memory:', () => now)
    const link = (state: string) =>
      row({
        id: 'a/link',
        what: 'Link to b',
        kind: 'machine',
        machine: 'b',
        state,
        next_run: new Date(now + 10 * 60_000).toISOString(),
      })
    const job = row({ id: 'b/job', what: 'Job', kind: 'job', machine: 'b' })
    store.upsert([link('ok'), job])
    now += 60_000
    store.upsert([link('off')])
    const offAt = new Date(now).toISOString()
    now += 5 * 60_000
    store.upsert([link('off')])
    const shown = (id: string) => store.read().rows.find((item) => item.id === id)
    expect(shown('a/link')).toMatchObject({ shown: 'off', shown_since: offAt })
    expect(shown('b/job')).toMatchObject({ shown: 'off', machine_off: true, shown_since: offAt })
    now += 60_000
    store.upsert([link('ok')])
    expect(shown('a/link')).toMatchObject({ shown: 'ok', shown_since: null })
    store.close()
  })
})

describe('machineId', () => {
  it('is the short host name in lower case', () => {
    expect(machineId('Davion-Sidarli.lan')).toBe('davion-sidarli')
    expect(machineId('gem')).toBe('gem')
  })
})
