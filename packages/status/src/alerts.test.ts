import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type AlertBatch, alertText } from './alerts'
import { parseRow, type StatusRow } from './row'
import { StatusStore } from './store'

const T0 = Date.parse('2026-11-03T12:00:00Z')
const HOUR = 3_600_000

const row = (fields: Record<string, unknown>): StatusRow =>
  parseRow({ kind: 'job', machine: 'a', state: 'ok', meaning: 'Fine.', ...fields })

const machine = (name: string, state = 'ok', due = T0 + HOUR) =>
  row({
    id: `${name}/machine`,
    what: name,
    kind: 'machine',
    machine: name,
    state,
    next_run: new Date(due).toISOString(),
  })

let dir: string | null = null
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = null
})

function watched(path = ':memory:', clock = { now: T0 }) {
  const store = new StatusStore(path, () => clock.now)
  const batches: AlertBatch[] = []
  store.onAlert((batch) => batches.push(batch))
  return { store, batches, clock }
}

describe('alerts', () => {
  it('sends one batch when rows turn failed, and nothing for warnings or repeats', () => {
    const { store, batches } = watched()
    store.upsert([
      machine('a'),
      row({ id: 'a/one', what: 'One' }),
      row({ id: 'a/two', what: 'Two' }),
    ])
    expect(batches).toEqual([])
    store.upsert([
      row({ id: 'a/one', what: 'One', state: 'failed', meaning: 'Disk full.' }),
      row({ id: 'a/two', what: 'Two', state: 'failed', meaning: 'Exited.' }),
      row({ id: 'a/three', what: 'Three', state: 'warn', meaning: 'Slow.' }),
    ])
    expect(batches).toHaveLength(1)
    expect(batches[0]?.changes.map((change) => [change.row.id, change.from, change.to])).toEqual([
      ['a/one', 'ok', 'failed'],
      ['a/two', 'ok', 'failed'],
    ])
    // Still failed: no new alert. Back to ok and failed again: one more.
    store.upsert([row({ id: 'a/one', what: 'One', state: 'failed', meaning: 'Still full.' })])
    store.upsert([row({ id: 'a/one', what: 'One' })])
    store.upsert([row({ id: 'a/one', what: 'One', state: 'failed', meaning: 'Full again.' })])
    expect(batches).toHaveLength(2)
    store.close()
  })

  it('alerts when a backup or machine row goes late, not other kinds', () => {
    const { store, batches, clock } = watched()
    store.upsert([
      machine('a', 'ok', T0 + 2 * HOUR),
      machine('b', 'ok', T0 + HOUR),
      row({ id: 'a/backup', what: 'Backup', kind: 'backup', next_run: '2026-11-03T12:30:00Z' }),
      row({ id: 'a/job', what: 'Job', next_run: '2026-11-03T12:30:00Z' }),
    ])
    clock.now = T0 + 90 * 60_000
    const batch = store.checkAlerts()
    expect(batch?.changes.map((change) => [change.row.id, change.to])).toEqual([
      ['a/backup', 'late'],
      ['b/machine', 'late'],
    ])
    expect(store.checkAlerts()).toBeNull()
    expect(batches).toHaveLength(1)
    store.close()
  })

  it('never alerts for rows on a machine turned off on purpose', () => {
    const { store, batches } = watched()
    store.upsert([machine('c', 'off'), row({ id: 'c/job', what: 'Job', machine: 'c' })])
    store.upsert([row({ id: 'c/job', what: 'Job', machine: 'c', state: 'failed', meaning: 'x' })])
    expect(batches).toEqual([])
    store.close()
  })

  it('remembers what it saw across a restart', () => {
    dir = mkdtempSync(join(tmpdir(), 'status-alerts-'))
    const path = join(dir, 'status.db')
    const first = watched(path)
    first.store.upsert([
      machine('a'),
      row({ id: 'a/one', what: 'One', state: 'failed', meaning: 'x' }),
    ])
    expect(first.batches).toHaveLength(1)
    first.store.close()
    const second = watched(path)
    expect(second.store.checkAlerts()).toBeNull()
    second.store.close()
  })

  it('words the alert: what failed leads, then the rest of the rollup', () => {
    const { store, batches } = watched()
    store.upsert([
      machine('a'),
      row({ id: 'a/w', what: 'Warned', state: 'warn', meaning: 'Slow.' }),
      row({ id: 'a/ok', what: 'Fine' }),
    ])
    store.upsert([
      row({
        id: 'a/db',
        what: 'Database to Drive',
        kind: 'backup',
        state: 'failed',
        meaning: 'Drive login expired.',
      }),
    ])
    expect(alertText(batches[0] as AlertBatch)).toEqual({
      title: '1 failed: Database to Drive',
      body: 'Drive login expired. Also 1 warning. 2 healthy.',
    })
    store.close()
  })
})
