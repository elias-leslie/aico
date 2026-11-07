// The guard against noise coming back: states that are expected, not problems, must never reach
// the count, the badge, the tray or the phone, whoever caused them. Each case is a way a row used
// to leak into "N problems" and cost the owner a notification they did not need.

import { describe, expect, it } from 'vitest'
import type { AlertBatch } from './alerts'
import { parseRow, type StatusRow } from './row'
import { concentration, counted } from './show'
import { StatusStore } from './store'

const T0 = Date.parse('2026-11-07T12:00:00Z')
const HOUR = 3_600_000
const JOBS = 30
const row = (fields: Record<string, unknown>): StatusRow =>
  parseRow({ kind: 'job', machine: 'apps', state: 'ok', meaning: 'Fine.', ...fields })
const guestRows = (due: number, extra: Record<string, unknown> = {}) => [
  row({ id: 'apps/machine', what: 'apps', kind: 'machine', next_run: new Date(due).toISOString() }),
  ...Array.from({ length: JOBS }, (_, n) =>
    row({
      id: `apps/job-${n}`,
      what: `Job ${n}`,
      next_run: new Date(due).toISOString(),
      ...extra,
    }),
  ),
]

function world(intent: 'always' | 'on-demand' | 'off') {
  const clock = { now: T0 }
  const store = new StatusStore(':memory:', () => clock.now)
  const batches: AlertBatch[] = []
  store.onAlert((batch) => batches.push(batch))
  store.syncIntents([{ machine: 'apps', intent }])
  return { store, clock, batches }
}

function quiet({ store, batches }: ReturnType<typeof world>) {
  const view = store.read()
  expect(view.summary.problems).toBe(0)
  expect(view.rows.filter(counted)).toEqual([])
  expect(concentration(view.rows)).toBeNull()
  expect(batches).toEqual([])
  return view
}

describe('expected states never count as problems', () => {
  it('an on-demand guest stopped by anyone, rows and all, even after an older owner stop', () => {
    const w = world('on-demand')
    w.store.markStopped('apps', T0 - 8 * HOUR) // the morning stop, long since undone
    w.store.setObservedPower('apps', true, T0 - 7 * HOUR, T0 - 7 * HOUR)
    w.store.upsert(guestRows(T0 + HOUR))
    w.clock.now = T0 + 3 * HOUR
    w.store.setObservedPower('apps', false, w.clock.now) // stopped through Proxmox, no new mark
    w.clock.now = T0 + 5 * HOUR
    w.store.checkAlerts()
    const view = quiet(w)
    expect(view.rows.filter((r) => r.shown === 'off')).toHaveLength(JOBS + 1)
  })

  it('an on-demand guest that was never started today', () => {
    const w = world('on-demand')
    w.store.upsert(guestRows(T0 + HOUR))
    w.store.setObservedPower('apps', false, T0)
    w.clock.now = T0 + 20 * HOUR
    w.store.checkAlerts()
    quiet(w)
  })

  it('a parked machine and a planned outage', () => {
    const parked = world('off')
    parked.store.upsert(guestRows(T0 + HOUR))
    parked.clock.now = T0 + 5 * HOUR
    parked.store.checkAlerts()
    quiet(parked)
    const planned = world('always')
    planned.store.upsert(guestRows(T0 + HOUR))
    planned.store.planOutage(['apps'], T0 + 1000)
    planned.clock.now = T0 + 5 * HOUR
    planned.store.checkAlerts()
    quiet(planned)
  })

  it('jobs that finished or were skipped by their app are ok, not problems', () => {
    const w = world('always')
    w.store.upsert(
      guestRows(T0 + 24 * HOUR, { meaning: 'Last run skipped by the app’s settings.' }),
    )
    w.clock.now = T0 + HOUR
    w.store.checkAlerts()
    quiet(w)
  })

  it('but an always-on machine that goes quiet is still a crowd, named by machine', () => {
    const w = world('always')
    w.store.upsert(guestRows(T0 + HOUR))
    w.clock.now = T0 + 5 * HOUR
    w.store.checkAlerts()
    const view = w.store.read()
    expect(view.summary.problems).toBe(JOBS + 1)
    expect(concentration(view.rows)).toEqual({ machine: 'apps', count: JOBS + 1 })
    expect(w.batches).toHaveLength(1) // one alert for the machine, not one per row
    expect(w.batches[0]?.changes).toHaveLength(1)
  })
})
