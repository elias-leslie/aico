// What reaches the phone from Status (major.ts): only a major row that stayed bad past its
// window, once, and its recovery. A first late or failed run, a guest or a drive catching up, and
// a project's own checks never do.

import { describe, expect, it } from 'vitest'
import { majorOf } from './major'
import { parseRow, type StatusRow } from './row'
import type { Sustained } from './show'
import { StatusStore } from './store'

const T0 = Date.parse('2026-11-07T12:00:00Z')
const MIN = 60_000
const HOUR = 60 * MIN
const WINDOWS = { 'data-risk': 26 * HOUR, outage: 30 * MIN }

const FAR = new Date(T0 + 1000 * HOUR).toISOString()
const host = () => row({ id: 'host/machine', kind: 'machine', next_run: FAR })
const row = (fields: Record<string, unknown>): StatusRow =>
  parseRow({
    kind: 'job',
    machine: 'host',
    state: 'ok',
    meaning: 'Fine.',
    what: 'Thing',
    ...fields,
  })

function world() {
  const clock = { now: T0 }
  const store = new StatusStore(':memory:', () => clock.now)
  const told: { stayed: Sustained[]; recovered: string[]; ended: string[] }[] = []
  store.onSustained(WINDOWS, (item) => told.push(item))
  store.syncIntents([
    { machine: 'host', intent: 'always' },
    { machine: 'guest', intent: 'on-demand' },
  ])
  const step = (ms: number) => {
    clock.now += ms
    store.checkAlerts()
  }
  const stayed = () => told.flatMap((item) => item.stayed.map((s) => s.row.id))
  return { store, clock, told, step, stayed }
}

describe('major rows that stay bad', () => {
  it('a backup failing is told only after its window, once, and again never until it recovered', () => {
    const w = world()
    w.store.upsert([host(), row({ id: 'host/backup/a', kind: 'backup', state: 'ok' })])
    w.store.checkAlerts()
    w.store.upsert([row({ id: 'host/backup/a', kind: 'backup', state: 'failed' })])
    expect(w.stayed()).toEqual([])
    w.step(25 * HOUR)
    expect(w.stayed()).toEqual([])
    w.step(2 * HOUR)
    expect(w.stayed()).toEqual(['host/backup/a'])
    w.step(5 * HOUR)
    expect(w.stayed()).toEqual(['host/backup/a'])
    w.clock.now += MIN
    w.store.upsert([row({ id: 'host/backup/a', kind: 'backup', state: 'ok' })])
    expect(w.told.at(-1)?.recovered).toEqual(['host/backup/a'])
  })

  it('a backup that recovers on its retry never reaches the phone', () => {
    const w = world()
    w.store.upsert([host(), row({ id: 'host/backup/a', kind: 'backup', state: 'failed' })])
    w.step(20 * HOUR)
    w.clock.now += MIN
    w.store.upsert([row({ id: 'host/backup/a', kind: 'backup', state: 'ok' })])
    w.step(30 * HOUR)
    expect(w.told).toEqual([])
  })

  it('a backup row late past its due time counts from when it fell due', () => {
    const w = world()
    const due = new Date(T0 + HOUR).toISOString()
    w.store.upsert([
      host(),
      row({ id: 'host/backup/a', kind: 'backup', state: 'ok', next_run: due }),
    ])
    w.step(2 * HOUR)
    expect(w.stayed()).toEqual([])
    w.step(25 * HOUR)
    expect(w.stayed()).toEqual(['host/backup/a'])
  })

  it('an always-on machine that stays late is an outage after half an hour; an on-demand one is not', () => {
    const w = world()
    const due = new Date(T0 + MIN).toISOString()
    w.store.upsert([
      row({ id: 'host/machine', kind: 'machine', next_run: due }),
      row({ id: 'guest/machine', kind: 'machine', machine: 'guest', next_run: due }),
    ])
    w.step(10 * MIN)
    expect(w.stayed()).toEqual([])
    w.step(30 * MIN)
    expect(w.stayed()).toEqual(['host/machine'])
  })

  it('a link to a guest no project declares is not an always-on machine', () => {
    const row = { kind: 'machine', machine: 'guest', shown: 'late' }
    expect(majorOf({ ...row, id: 'fleet/here/guest' }, new Map())).toBeNull()
    expect(majorOf({ ...row, id: 'fleet/here/guest' }, new Map([['guest', 'always']]))).toBe(
      'outage',
    )
    expect(majorOf({ ...row, id: 'gem/machine' }, new Map())).toBe('outage')
  })

  describe('one notice per row until the row itself is well', () => {
    const guestLink = (state: 'ok' | 'off') =>
      row({
        id: 'guest/link',
        kind: 'machine',
        machine: 'guest',
        state,
        next_run: new Date(T0 + 1000 * HOUR).toISOString(),
      })
    const failedService = row({
      id: 'guest/web',
      kind: 'service',
      machine: 'guest',
      state: 'failed',
    })

    it('its machine going off and back ends the notice and never repeats it', () => {
      const w = world()
      w.store.syncIntents([{ machine: 'guest', intent: 'always' }])
      w.store.upsert([guestLink('ok'), failedService])
      w.step(31 * MIN)
      expect(w.stayed()).toEqual(['guest/web'])
      for (let i = 0; i < 5; i++) {
        w.store.upsert([guestLink('off')])
        w.step(MIN)
        w.store.upsert([guestLink('ok')])
        w.step(31 * MIN)
      }
      expect(w.stayed()).toEqual(['guest/web'])
      expect(w.told.flatMap((t) => t.ended)).toEqual(['guest/web'])
      expect(w.told.flatMap((t) => t.recovered)).toEqual([])
    })

    it('a told backup that itself goes off and comes back failing is not told again', () => {
      const w = world()
      const copy = (state: string) => row({ id: 'host/backup/a', kind: 'backup', state })
      w.store.upsert([host(), copy('ok')])
      w.store.checkAlerts()
      w.store.upsert([copy('failed')])
      w.step(27 * HOUR)
      expect(w.stayed()).toEqual(['host/backup/a'])
      for (let i = 0; i < 3; i++) {
        w.store.upsert([copy('off')])
        w.step(MIN)
        w.store.upsert([copy('failed')])
        w.step(27 * HOUR)
      }
      expect(w.stayed()).toEqual(['host/backup/a'])
      expect(w.told.flatMap((t) => t.ended)).toEqual(['host/backup/a'])
      expect(w.told.flatMap((t) => t.recovered)).toEqual([])
      // Well again: the next failure is a new one.
      w.store.upsert([copy('ok')])
      w.step(MIN)
      w.store.upsert([copy('failed')])
      w.step(27 * HOUR)
      expect(w.stayed()).toEqual(['host/backup/a', 'host/backup/a'])
    })

    it('after its machine was off, a failure not yet told gets its whole window from the return', () => {
      const w = world()
      w.store.syncIntents([{ machine: 'guest', intent: 'always' }])
      w.store.upsert([guestLink('ok'), failedService])
      w.step(5 * MIN)
      w.store.upsert([guestLink('off')])
      w.step(100 * HOUR)
      w.store.upsert([guestLink('ok')])
      w.step(29 * MIN)
      expect(w.stayed()).toEqual([])
      w.step(2 * MIN)
      expect(w.stayed()).toEqual(['guest/web'])
    })

    it('going from failed to late is the same trouble, not a new notice', () => {
      const w = world()
      const due = new Date(T0 + HOUR).toISOString()
      w.store.upsert([host(), row({ id: 'host/web', kind: 'backup', state: 'failed' })])
      w.step(27 * HOUR)
      expect(w.stayed()).toEqual(['host/web'])
      w.store.upsert([row({ id: 'host/web', kind: 'backup', state: 'ok', next_run: due })])
      w.step(40 * HOUR)
      expect(w.stayed()).toEqual(['host/web'])
    })

    it('tells again once the row was well and goes bad again', () => {
      const w = world()
      w.store.upsert([host(), row({ id: 'host/web', kind: 'service', state: 'failed' })])
      w.step(31 * MIN)
      w.store.upsert([row({ id: 'host/web', kind: 'service', state: 'ok' })])
      w.step(MIN)
      w.store.upsert([row({ id: 'host/web', kind: 'service', state: 'failed' })])
      w.step(31 * MIN)
      expect(w.stayed()).toEqual(['host/web', 'host/web'])
    })
  })

  it('a failed service is an outage after its window', () => {
    const w = world()
    w.store.upsert([host(), row({ id: 'host/web', kind: 'service', state: 'failed' })])
    w.step(31 * MIN)
    expect(w.told[0]?.stayed[0]).toMatchObject({ major: 'outage' })
  })

  it('never tells of jobs, checks, links, publication or a failed row off with its machine', () => {
    const w = world()
    w.store.upsert([
      host(),
      row({ id: 'host/job', kind: 'job', state: 'failed' }),
      row({ id: 'host/check', kind: 'check', state: 'failed' }),
      row({ id: 'host/link', kind: 'link', state: 'failed' }),
      row({ id: 'host/repo', kind: 'repo', state: 'failed', project: 'x' }),
    ])
    w.step(100 * HOUR)
    expect(w.told).toEqual([])
  })

  it('a backup of a machine turned off on purpose is off, not a problem', () => {
    const w = world()
    w.store.upsert([
      row({ id: 'guest/backup/a', kind: 'backup', machine: 'guest', state: 'failed' }),
    ])
    w.store.markStopped('guest')
    w.step(100 * HOUR)
    expect(w.told).toEqual([])
  })
})
