import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '@aico/store'
import { afterEach, describe, expect, it } from 'vitest'
import { type AlertBatch, alertText } from './alerts'
import { parseRow, type StatusRow } from './row'
import { StatusStore } from './store'

const T0 = Date.parse('2026-11-03T12:00:00Z')
const HOUR = 3_600_000
const DAY = 24 * HOUR
const iso = (ms: number) => new Date(ms).toISOString()

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

  it('does not alert again for a failed row whose machine went late and came back', () => {
    const { store, batches, clock } = watched()
    store.upsert([machine('a'), row({ id: 'a/one', what: 'One', state: 'failed', meaning: 'x' })])
    expect(batches).toHaveLength(1)
    // The machine stops reporting: its row shows unknown (and the machine row alerts as late).
    clock.now = T0 + 2 * HOUR
    store.checkAlerts()
    expect(batches.at(-1)?.changes.map((change) => change.row.id)).toEqual(['a/machine'])
    const before = batches.length
    // It comes back and the row is still failed: nothing new.
    store.upsert([machine('a', 'ok', clock.now + HOUR)])
    store.upsert([row({ id: 'a/one', what: 'One', state: 'failed', meaning: 'x' })])
    expect(store.checkAlerts()).toBeNull()
    expect(batches).toHaveLength(before)
    store.close()
  })

  it('counts a machine back only once it was later than the grace Status shows late after', () => {
    const { store, clock } = watched()
    const backAt = () =>
      (
        (store as unknown as { db: { prepare(sql: string): { get(id: string): unknown } } }).db
          .prepare('SELECT back_at FROM status_rows WHERE id = ?')
          .get('a/machine') as { back_at: number | null }
      ).back_at
    store.upsert([machine('a', 'ok', T0 + HOUR)])
    expect(backAt()).toBe(T0)
    // Thirty seconds past its next report is within the grace: not away, so not back either.
    clock.now = T0 + HOUR + 30_000
    store.upsert([machine('a', 'ok', clock.now + HOUR)])
    expect(backAt()).toBe(T0)
    // Past the grace it was away, and is back now.
    clock.now += HOUR + 3 * 60_000
    store.upsert([machine('a', 'ok', clock.now + HOUR)])
    expect(backAt()).toBe(clock.now)
    store.close()
  })

  it('gives a backup due while its machine was off one interval to run before it is late', () => {
    const { store, batches, clock } = watched()
    const backup = (at: number, state = 'ok') =>
      row({
        id: 'a/backup',
        what: 'Backup',
        kind: 'backup',
        state,
        last_run: iso(at),
        next_run: iso(at + DAY),
      })
    store.upsert([machine('a', 'ok', T0 + HOUR), backup(T0)])
    // Off for the weekend, on purpose.
    store.upsert([machine('a', 'off')])
    clock.now = T0 + 3 * DAY
    expect(store.checkAlerts()).toBeNull()
    // Back on Monday: the backup fell due on Saturday but hasn't had a chance to run.
    store.upsert([machine('a', 'ok', clock.now + HOUR)])
    const waiting = store.read().rows.find((item) => item.id === 'a/backup')
    expect([waiting?.shown, waiting?.unknown_why]).toEqual(['unknown', 'back'])
    expect(store.read().summary.problems).toBe(0)
    // The rollup and the summary give one count, in the API and in aico status --json.
    expect(store.read().rollup.problems).toBe(0)
    expect(store.read().rollup.healthy).toBe(store.read().summary.healthy)
    expect(batches).toEqual([])
    // It runs within its interval: never late.
    clock.now += 2 * HOUR
    store.upsert([machine('a', 'ok', clock.now + HOUR), backup(clock.now)])
    expect(store.read().rows.find((item) => item.id === 'a/backup')?.shown).toBe('ok')
    expect(batches).toEqual([])
    store.close()
  })

  it('alerts once when a backup still hasn’t run a full interval after its machine came back', () => {
    const { store, batches, clock } = watched()
    store.upsert([
      machine('a', 'ok', T0 + HOUR),
      row({
        id: 'a/backup',
        what: 'Backup',
        kind: 'backup',
        last_run: iso(T0),
        next_run: iso(T0 + DAY),
      }),
    ])
    store.upsert([machine('a', 'off')])
    clock.now = T0 + 3 * DAY
    store.upsert([machine('a', 'ok', clock.now + DAY + HOUR)])
    const back = clock.now
    clock.now = back + DAY - 60_000
    expect(store.checkAlerts()).toBeNull()
    clock.now = back + DAY + 60_000
    const batch = store.checkAlerts()
    expect(batch?.changes.map((change) => [change.row.id, change.from, change.to])).toEqual([
      ['a/backup', 'ok', 'late'],
    ])
    expect(batch?.changes[0]?.row.shown_since).toBe(iso(back + DAY))
    expect(store.checkAlerts()).toBeNull()
    expect(batches).toHaveLength(1)
    store.close()
  })

  it('records a change only once the hook took it, so a throwing hook hears it again', () => {
    const store = new StatusStore(':memory:', () => T0)
    let fail = true
    const told: AlertBatch[] = []
    store.onAlert((batch) => {
      told.push(batch)
      if (fail) throw new Error('notify is down')
    })
    store.upsert([machine('a'), row({ id: 'a/one', what: 'One' })])
    store.upsert([row({ id: 'a/one', what: 'One', state: 'failed', meaning: 'x' })])
    expect(told).toHaveLength(1)
    fail = false
    store.checkAlerts()
    expect(told).toHaveLength(2)
    expect(told[1]?.changes.map((change) => [change.row.id, change.from])).toEqual([
      ['a/one', 'ok'],
    ])
    expect(store.checkAlerts()).toBeNull()
    store.close()
  })

  it('starts from the rows already there: an upgrade alerts on nothing already showing', () => {
    dir = mkdtempSync(join(tmpdir(), 'status-alerts-'))
    const path = join(dir, 'status.db')
    // status.db as the first M2 build left it: rows, and seen states that kept unknown.
    const old = openDatabase(path, [
      'CREATE TABLE status_rows (id TEXT PRIMARY KEY, doc TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT',
      'CREATE TABLE status_seen (id TEXT PRIMARY KEY, shown TEXT NOT NULL) STRICT',
    ])
    const put = old.prepare('INSERT INTO status_rows (id, doc, updated_at) VALUES (?, ?, ?)')
    for (const item of [
      machine('a', 'ok', T0 + HOUR),
      row({ id: 'a/one', what: 'One', state: 'failed', meaning: 'x' }),
      row({ id: 'a/backup', what: 'Backup', kind: 'backup', next_run: iso(T0 - HOUR) }),
      row({ id: 'b/two', what: 'Two', machine: 'b', state: 'failed', meaning: 'y' }),
    ])
      put.run(item.id, JSON.stringify(item), T0 - 2 * HOUR)
    old.prepare("INSERT INTO status_seen (id, shown) VALUES ('a/one', 'unknown')").run()
    old.close()
    const upgraded = watched(path)
    expect(upgraded.store.checkAlerts()).toBeNull()
    // b has no machine row, so b/two shows unknown; once b reports, its old failure is no news.
    upgraded.store.upsert([machine('b', 'ok', T0 + HOUR)])
    expect(upgraded.batches).toEqual([])
    upgraded.store.close()
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
