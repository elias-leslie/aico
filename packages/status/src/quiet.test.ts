// The guard against noise coming back: states that are expected, not problems, must never reach
// the count, the badge, the tray or the phone, whoever caused them. Each case is a way a row used
// to leak into "N problems" and cost the owner a notification they did not need.

import { describe, expect, it } from 'vitest'
import type { AlertBatch } from './alerts'
import type { Major } from './major'
import { jobEnv, jobSchedule, parseRow, type StatusRow } from './row'
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

// Rows a scheduled job writes (nightly publication, the restore drill, the caretaker) carry the job's
// next run, so a stopped job can't stay green; they must not read late for anything done on purpose.
describe('rows a job writes, with its next run', () => {
  const iso = (at: number) => new Date(at).toISOString()
  const job = (fields: Record<string, unknown>) =>
    row({ id: 'jobs/nightly', what: 'Nightly', ...fields })
  const written = (due: number, extra: Record<string, unknown> = {}) => [
    row({ id: 'publish:one', what: 'One', next_run: iso(due), run_by: 'jobs/nightly', ...extra }),
    row({ id: 'publish:two', what: 'Two', next_run: iso(due), run_by: 'jobs/nightly', ...extra }),
    row({
      id: 'apps/backup/drill',
      what: 'Restore drill',
      kind: 'backup',
      next_run: iso(due),
      run_by: 'jobs/nightly',
      ...extra,
    }),
  ]
  const machine = (due: number) =>
    row({ id: 'apps/machine', what: 'apps', kind: 'machine', next_run: iso(due) })
  const shown = (w: ReturnType<typeof world>) =>
    Object.fromEntries(w.store.read().rows.map((r) => [r.id, r.shown]))
  const sustained = (w: ReturnType<typeof world>) => {
    const told: string[] = []
    const windows: Record<Major, number> = { 'data-risk': 26 * HOUR, outage: HOUR / 2 }
    w.store.onSustained(windows, ({ stayed }) => told.push(...stayed.map((s) => s.row.id)))
    return told
  }

  it('its machine off reads Off and raises nothing, and coming back raises no storm', () => {
    for (const intent of ['always', 'on-demand', 'off'] as const) {
      const w = world(intent)
      const told = sustained(w)
      w.store.upsert([
        machine(T0 + HOUR),
        job({ next_run: iso(T0 + HOUR), last_run: iso(T0) }),
        ...written(T0 + HOUR),
      ])
      if (intent === 'always') w.store.planOutage(['apps'], T0 + 1000)
      w.clock.now = T0 + 30 * HOUR
      w.store.checkAlerts()
      const view = quiet(w)
      for (const r of view.rows) expect(r.shown, r.id).toBe('off')
      // Back on: the machine reports, and nothing it missed while off counts.
      w.clock.now = T0 + 31 * HOUR
      w.store.upsert([machine(T0 + 32 * HOUR)])
      w.store.checkAlerts()
      quiet(w)
      expect(told).toEqual([])
    }
  })

  it('a paused job holds them; resuming raises nothing until its next run', () => {
    const w = world('always')
    w.store.upsert([
      machine(T0 + 900 * HOUR),
      job({ state: 'off', meaning: 'Paused.', last_run: iso(T0 - HOUR) }),
      ...written(T0 + HOUR),
    ])
    w.clock.now = T0 + 40 * HOUR
    w.store.checkAlerts()
    quiet(w)
    expect(shown(w)['publish:one']).toBe('ok')
    // Resumed: its row says when it next runs, and the rows wait for that run.
    w.store.upsert([job({ next_run: iso(T0 + 44 * HOUR), last_run: iso(T0 - HOUR) })])
    w.store.checkAlerts()
    quiet(w)
  })

  it('wait out a long run, then go late if that run left them behind', () => {
    const w = world('always')
    w.store.upsert([
      machine(T0 + 900 * HOUR),
      job({ next_run: iso(T0 + 25 * HOUR), last_run: iso(T0 - HOUR) }),
      ...written(T0 + HOUR),
    ])
    w.clock.now = T0 + 2 * HOUR // past their due time, the job still holds its lease
    w.store.checkAlerts()
    quiet(w)
    w.store.upsert([job({ next_run: iso(T0 + 25 * HOUR), last_run: iso(T0 + 2 * HOUR) })])
    w.store.checkAlerts()
    expect(shown(w)['publish:one']).toBe('late')
  })

  it.each(['writer first', 'scheduler first'])(
    'uses the completed scheduler deadline after a run crosses its following slot, once (%s)',
    (order) => {
      const w = world('always')
      w.store.upsert([
        machine(T0 + 900 * HOUR),
        job({ next_run: iso(T0 + 30 * HOUR), last_run: iso(T0) }),
      ])
      w.clock.now = T0 + 26 * HOUR
      const report = written(T0 + 24 * HOUR, { last_run: iso(w.clock.now), run_id: 'first-run' })
      // Runner records when it STARTED, whereas the writer records when it finished reporting.
      const complete = job({
        next_run: iso(T0 + 48 * HOUR),
        last_run: iso(T0),
        run_id: 'first-run',
      })
      // A writer's delayed outbox can reach Status after the scheduler has already completed.
      if (order === 'writer first') {
        w.store.upsert(report)
        w.store.upsert([complete])
      } else {
        w.store.upsert([complete])
        w.store.upsert(report)
      }
      expect(w.store.read().rows.find((r) => r.id === 'publish:one')?.next_run).toBe(
        iso(T0 + 48 * HOUR),
      )
      quiet(w)
      // A later run that omits these reports must not keep extending their deadline.
      w.clock.now = T0 + 49 * HOUR
      w.store.upsert([
        job({ next_run: iso(T0 + 72 * HOUR), last_run: iso(T0 + 48 * HOUR), run_id: 'second-run' }),
      ])
      expect(shown(w)['publish:one']).toBe('late')
    },
  )

  it('an omitted report is not extended by the next completed job when its expired deadline was never corrected', () => {
    const w = world('always')
    w.store.upsert([machine(T0 + 900 * HOUR)])
    w.clock.now = T0 + 26 * HOUR
    w.store.upsert(written(T0 + 24 * HOUR, { last_run: iso(w.clock.now) }))
    w.store.upsert([job({ next_run: iso(T0 + 48 * HOUR), last_run: iso(T0) })])
    w.clock.now = T0 + 49 * HOUR
    w.store.upsert([job({ next_run: iso(T0 + 72 * HOUR), last_run: iso(T0 + 48 * HOUR) })])
    expect(shown(w)['publish:one']).toBe('late')
    expect(w.store.read().rows.find((r) => r.id === 'publish:one')?.next_run).toBe(
      iso(T0 + 24 * HOUR),
    )
  })

  it('a job without a next deadline cannot hold a due report forever', () => {
    const w = world('always')
    w.store.upsert([machine(T0 + 900 * HOUR), job({}), ...written(T0 + HOUR)])
    w.clock.now = T0 + 2 * HOUR
    expect(shown(w)['publish:one']).toBe('late')
  })

  it('a stopped job on a running machine reads late, and the first late stays off the phone', () => {
    const w = world('always')
    const told = sustained(w)
    w.store.upsert([
      machine(T0 + 900 * HOUR),
      job({ next_run: iso(T0 + HOUR), last_run: iso(T0 - HOUR) }),
      ...written(T0 + HOUR),
    ])
    w.clock.now = T0 + 2 * HOUR
    w.store.upsert([machine(T0 + 900 * HOUR)])
    w.store.checkAlerts()
    expect(shown(w)).toMatchObject({
      'jobs/nightly': 'late',
      'publish:one': 'late',
      'publish:two': 'late',
      'apps/backup/drill': 'late',
    })
    // One tray batch, for the backup row alone; a job row late alerts nothing.
    expect(w.batches.flatMap((b) => b.changes.map((c) => c.row.id))).toEqual(['apps/backup/drill'])
    expect(told).toEqual([])
    // Only a backup still late past its window goes further; a job row never does.
    w.clock.now = T0 + 30 * HOUR
    w.store.upsert([machine(T0 + 900 * HOUR)])
    w.store.checkAlerts()
    expect(told).toEqual(['apps/backup/drill'])
  })
})

describe('what a job tells the rows it writes', () => {
  const NEXT = T0 + 24 * HOUR
  it('a timed job names its next run; only that job, and only on its scheduled run', () => {
    const env = jobEnv('nightly', NEXT)
    expect(jobSchedule('nightly', env)).toEqual({
      next_run: new Date(NEXT).toISOString(),
      run_by: 'jobs/nightly',
    })
    expect(jobSchedule('other', env)).toEqual({})
    expect(jobSchedule('nightly', {})).toEqual({})
  })
  it('an interval job counts from now: it repeats after it completes', () => {
    expect(jobSchedule('often', jobEnv('often', T0, 5), T0 + HOUR).next_run).toBe(
      new Date(T0 + HOUR + 5 * 60_000).toISOString(),
    )
  })

  it('ignores malformed scheduler metadata instead of emitting an invalid deadline', () => {
    for (const fields of [
      { AICO_JOB_NEXT_RUN: 'tomorrow' },
      { AICO_JOB_EVERY_MIN: '-5' },
      { AICO_JOB_EVERY_MIN: 'Infinity' },
      { AICO_JOB_EVERY_MIN: 'NaN' },
      { AICO_JOB_RUN_ID: 'bad execution id' },
    ]) {
      expect(jobSchedule('nightly', { ...jobEnv('nightly', NEXT), ...fields })).toEqual({})
    }
  })
})
