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
  it('is on for always, and for on-demand only while running', () => {
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
      shown: 'off',
      machine_off: true,
    })
    expect(store.read().summary.problems).toBe(0)
    expect(store.isExpectedOff('apps')).toBe(true)
  })

  it('derives on-demand expectation from observed power, with no marks', () => {
    const { store, clock, batches } = watched('on-demand')
    store.upsert([machineRow(T0 + HOUR), job(T0 + HOUR)])
    // Started outside the page: running, so silence is late.
    store.setObservedPower('apps', true, T0, T0 - 5 * 60_000)
    expect(store.isExpectedOff('apps')).toBe(false)
    clock.now = T0 + 2 * HOUR
    store.checkAlerts()
    expect(batches).toHaveLength(1)
    expect(store.read().rows.find((r) => r.id === 'apps/machine')?.shown).toBe('late')
    // Shut down outside the page: off, not late, not paged, quiet count zero.
    store.setObservedPower('apps', false, clock.now)
    expect(store.isExpectedOff('apps')).toBe(true)
    const shown = store.read().rows
    expect(shown.find((r) => r.id === 'apps/machine')?.shown).toBe('off')
    expect(shown.find((r) => r.id === 'apps/job')).toMatchObject({
      shown: 'off',
      machine_off: true,
    })
    expect(store.read().summary.problems).toBe(0)
    expect(store.expectedOff().get('apps')).toBe(clock.now)
  })

  it('shows an on-demand machine off after a later stop, even with an older owner stop mark', () => {
    const { store, clock, batches } = watched('on-demand')
    // The owner stopped it in the morning; it was started again and reported all day; then it
    // was stopped by someone else (an agent through Proxmox), with no new mark.
    store.markStopped('apps', T0)
    store.setObservedPower('apps', true, T0 + HOUR, T0 + HOUR)
    store.upsert([machineRow(T0 + 6 * HOUR), job(T0 + 6 * HOUR)])
    clock.now = T0 + 8 * HOUR
    store.setObservedPower('apps', false, clock.now)
    clock.now = T0 + 9 * HOUR
    store.checkAlerts()
    expect(batches).toEqual([])
    expect(store.expectedOff().get('apps')).toBe(T0 + 8 * HOUR)
    const shown = store.read().rows
    expect(shown.find((r) => r.id === 'apps/machine')?.shown).toBe('off')
    expect(shown.find((r) => r.id === 'apps/job')).toMatchObject({
      shown: 'off',
      machine_off: true,
    })
    expect(store.read().summary.problems).toBe(0)
  })

  it('keeps the last observed power and its time when nothing new is read', () => {
    const { store } = watched('on-demand')
    store.setObservedPower('apps', true, T0, T0 - 1000)
    store.setObservedPower('apps', true, T0 + 1000, T0 + 500) // still running: since is kept
    expect(store.intents()[0]).toMatchObject({
      power: 'on',
      powerSince: T0 - 1000,
      powerAt: T0 + 1000,
    })
    expect(store.isExpectedOff('apps')).toBe(false)
  })

  it('does not page an always machine the owner shut down, and ends that when it runs again', () => {
    const { store, clock, batches } = watched('always')
    store.upsert([machineRow(T0 + HOUR)])
    store.setObservedPower('apps', true, T0)
    store.markStopped('apps', T0)
    store.setObservedPower('apps', false, T0)
    clock.now = T0 + 2 * HOUR
    store.checkAlerts()
    expect(batches).toEqual([])
    expect(store.read().rows[0]?.shown).toBe('off')
    store.markStopped('apps', null)
    store.checkAlerts()
    expect(batches).toHaveLength(1) // an always machine that is down without the owner's say is a problem
  })

  it('covers a parked machine, and one with no machine row of its own', () => {
    const { store } = watched('off')
    store.upsert([job()])
    expect(store.read().summary.problems).toBe(0)
    expect(store.read().rows[0]).toMatchObject({ shown: 'off', machine_off: true })
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
    store.setObservedPower('apps', true, T0)
    store.syncIntents([{ machine: 'apps', intent: 'on-demand' }])
    expect(store.intents()[0]).toMatchObject({ intent: 'on-demand', stoppedAt: null, power: 'on' })
    store.syncIntents([])
    expect(store.intents()).toEqual([])
  })
})

describe('planned outage', () => {
  const MIN = 60_000
  const link = (state: 'warn' | 'ok', at = T0) =>
    row({
      id: 'fleet/aico/apps',
      what: 'Link to apps',
      kind: 'machine',
      state,
      next_run: new Date(at + HOUR).toISOString(),
    })

  it('shows the machine and its rows off and never pages, even for a machine no project declares', () => {
    const { store, clock, batches } = watched()
    store.upsert([machineRow(T0 + HOUR), job(T0 + HOUR)])
    store.planOutage(['apps'], T0 + 2 * MIN)
    clock.now = T0 + 3 * HOUR
    store.checkAlerts()
    expect(batches).toEqual([])
    const shown = store.read().rows
    expect(shown.find((r) => r.id === 'apps/machine')).toMatchObject({ shown: 'off' })
    expect(shown.find((r) => r.id === 'apps/job')).toMatchObject({
      shown: 'off',
      machine_off: true,
    })
    expect(store.read().summary.problems).toBe(0)
    expect(store.isExpectedOff('apps')).toBe(true)
  })

  it('is not dated in the future while the machine is still shutting down', () => {
    const { store } = watched()
    store.upsert([machineRow(T0 + HOUR)])
    store.planOutage(['apps'], T0 + 5 * MIN)
    expect(store.read().rows[0]?.shown_since).toBe(new Date(T0).toISOString())
  })

  it('holds through reports sent before the machine is gone, and through a watcher saying it is disconnected', () => {
    const { store, clock, batches } = watched()
    store.upsert([machineRow(T0 + HOUR)])
    store.planOutage(['apps'], T0 + 5 * MIN)
    clock.now = T0 + MIN
    store.upsert([machineRow(T0 + 2 * HOUR)]) // its last report, while shutting down
    clock.now = T0 + 10 * MIN
    store.upsert([link('warn', clock.now)]) // another machine watching the link
    clock.now = T0 + 3 * HOUR
    store.checkAlerts()
    expect(batches).toEqual([])
    expect(store.plannedOutages().has('apps')).toBe(true)
    expect(store.read().rows.find((r) => r.id === 'apps/machine')?.shown).toBe('off')
  })

  it('ends when the machine reports again after it was due to be gone, and pages again after that', () => {
    const { store, clock, batches } = watched()
    store.upsert([machineRow(T0 + HOUR)])
    store.planOutage(['apps'], T0 + 5 * MIN)
    clock.now = T0 + 20 * MIN
    store.upsert([machineRow(clock.now + HOUR)])
    expect(store.plannedOutages().size).toBe(0)
    expect(store.read().rows[0]?.shown).toBe('ok')
    clock.now += 3 * HOUR
    store.checkAlerts()
    expect(batches).toHaveLength(1)
    expect(batches[0]?.changes[0]?.to).toBe('late')
  })

  it('ends when a link to the machine says it is connected, and can be taken back', () => {
    const { store, clock } = watched()
    store.planOutage(['apps'], T0 + MIN)
    clock.now = T0 + 5 * MIN
    store.upsert([link('ok', clock.now)])
    expect(store.plannedOutages().size).toBe(0)
    store.planOutage(['apps'])
    expect(store.plannedOutages().size).toBe(1)
    store.clearOutage(['apps', 'nobody'])
    expect(store.plannedOutages().size).toBe(0)
  })
})
