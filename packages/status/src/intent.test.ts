import { describe, expect, it } from 'vitest'
import type { AlertBatch } from './alerts'
import { expectedState } from './intent'
import { parseRow, type StatusRow } from './row'
import { StatusStore } from './store'

const T0 = Date.parse('2026-11-06T12:00:00Z')
const HOUR = 3_600_000
const row = (fields: Record<string, unknown>): StatusRow =>
  parseRow({ kind: 'job', machine: 'apps', state: 'ok', meaning: 'Fine.', ...fields })
const machineRow = (due: number) =>
  row({
    id: 'apps/machine',
    what: 'apps',
    kind: 'machine',
    state: 'ok',
    next_run: new Date(due).toISOString(),
  })
const job = (due?: number) =>
  row({
    id: 'apps/job',
    what: 'Nightly',
    ...(due ? { next_run: new Date(due).toISOString() } : {}),
  })

function watched(intent?: 'always' | 'on-demand' | 'off') {
  const clock = { now: T0 }
  const store = new StatusStore(':memory:', () => clock.now)
  const batches: AlertBatch[] = []
  store.onAlert((batch) => batches.push(batch))
  if (intent) store.syncIntents([{ machine: 'apps', intent }])
  return { store, clock, batches }
}

describe('expectedState', () => {
  it('is on for always, and for on-demand only while in use', () => {
    expect(expectedState('always', false)).toBe('on')
    expect(expectedState('on-demand', false)).toBe('off')
    expect(expectedState('on-demand', true)).toBe('on')
    expect(expectedState('off', true)).toBe('off')
  })
})

describe('machine intent', () => {
  it('pages when a machine meant to be always on goes late', () => {
    const { store, clock, batches } = watched('always')
    store.upsert([machineRow(T0 + HOUR), job(T0 + HOUR)])
    clock.now = T0 + 2 * HOUR
    store.checkAlerts()
    expect(batches).toHaveLength(1)
    expect(batches[0]?.changes[0]?.to).toBe('late')
    expect(store.isExpectedOff('apps')).toBe(false)
  })

  it('shows an on-demand machine off, with its rows, and never pages for it', () => {
    const { store, clock, batches } = watched('on-demand')
    store.upsert([machineRow(T0 + HOUR), job(T0 + HOUR)])
    clock.now = T0 + 2 * HOUR
    store.checkAlerts()
    expect(batches).toEqual([])
    const shown = store.read().rows
    expect(shown.find((r) => r.id === 'apps/machine')?.shown).toBe('off')
    expect(shown.find((r) => r.id === 'apps/job')).toMatchObject({
      shown: 'unknown',
      unknown_why: 'off',
    })
    expect(store.read().summary.problems).toBe(0)
    expect(store.isExpectedOff('apps')).toBe(true)
  })

  it('expects an on-demand machine on while it is in use, and off again after shutdown', () => {
    const { store, clock, batches } = watched('on-demand')
    store.upsert([machineRow(T0 + HOUR)])
    store.markUsed('apps', T0)
    expect(store.isExpectedOff('apps')).toBe(false)
    clock.now = T0 + 2 * HOUR
    store.checkAlerts()
    expect(batches).toHaveLength(1)
    store.markStopped('apps', clock.now)
    expect(store.isExpectedOff('apps')).toBe(true)
    expect(store.intents()[0]).toMatchObject({ usedSince: null, stoppedAt: clock.now })
  })

  it('covers a parked machine, and one with no machine row of its own', () => {
    const { store } = watched('off')
    store.upsert([job()])
    expect(store.read().summary.problems).toBe(0)
    expect(store.read().rows[0]).toMatchObject({ unknown_why: 'off' })
  })

  it('lets the owner stop an always-on machine, and ends that when it reports again', () => {
    const { store, clock, batches } = watched('always')
    store.upsert([machineRow(T0 + HOUR)])
    store.markStopped('apps', T0)
    clock.now = T0 + 2 * HOUR
    store.checkAlerts()
    expect(batches).toEqual([])
    store.upsert([machineRow(T0 + 4 * HOUR)])
    expect(store.read().rows[0]?.shown).toBe('ok')
    store.markStopped('apps', null)
    expect(store.isExpectedOff('apps')).toBe(false)
  })

  it('keeps the owner moves across a sync and starts over when the intent changes', () => {
    const { store } = watched('always')
    store.markStopped('apps', T0)
    store.syncIntents([{ machine: 'apps', intent: 'always' }])
    expect(store.isExpectedOff('apps')).toBe(true)
    store.syncIntents([{ machine: 'apps', intent: 'on-demand' }])
    expect(store.intents()[0]).toMatchObject({ intent: 'on-demand', stoppedAt: null })
    store.syncIntents([])
    expect(store.intents()).toEqual([])
  })
})
