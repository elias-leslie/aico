import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StatusRow } from '@aico/status'
import { describe, expect, it, vi } from 'vitest'
import { answerResult, commandJob, postJob, selfArgv, startBootClean } from './act'
import { type JobDef, nextAt, nextRun, parseJobs, readJobs, runTime, schedule } from './jobs'
import { JobStore, StaleLease } from './leases'
import { main } from './main'
import { jobRow, Runner } from './runner'

const A = { holder: 'a:1', machine: 'a' }
const B = { holder: 'b:2', machine: 'b' }
const TTL = 60_000

describe('the lease', () => {
  it('fences a holder whose lease expired and was taken over: its writes are refused', () => {
    const store = new JobStore(':memory:')
    store.ensure('export', 1000)
    const first = store.claim('export', A, 1000, TTL)
    if (!first) throw new Error('no lease')
    expect(first.fence).toBe(1)
    expect(store.claim('export', B, 1000 + TTL - 1, TTL)).toBeNull()
    expect(store.renew(first, 2000, TTL)).toBe(true)
    // A goes silent; its lease (renewed at 2000) runs out at 2000 + TTL.
    const second = store.claim('export', B, 2000 + TTL, TTL)
    expect(second).toMatchObject({ fence: 2, holder: 'b:2' })
    if (!second) throw new Error('no lease')
    expect(second.leaseId).not.toBe(first.leaseId)
    expect(store.renew(first, 2000 + TTL, TTL)).toBe(false)
    expect(() => store.complete(first, { state: 'ok', meaning: 'late' }, 0, 5)).toThrow(StaleLease)
    store.complete(second, { state: 'ok', meaning: 'done' }, 3000, 99_000)
    expect(store.get('export')).toMatchObject({
      fence: 2,
      leaseId: null,
      nextRun: 99_000,
      lastMachine: 'b',
      lastMeaning: 'done',
    })
    // Even the same fence with a forged lease id is refused.
    expect(() =>
      store.complete({ ...second, leaseId: 'x' }, { state: 'ok', meaning: '' }, 0, 0),
    ).toThrow(StaleLease)
  })

  it('is taken only when due, and late by delayMs for another machine', () => {
    const store = new JobStore(':memory:')
    store.ensure('export', 10_000)
    store.ensure('export', 99) // a known kind keeps its next run
    expect(store.claim('export', A, 9_999, TTL)).toBeNull()
    expect(store.claim('export', B, 10_000, TTL, 5_000)).toBeNull()
    expect(store.claim('export', B, 15_000, TTL, 5_000)?.fence).toBe(1)
    expect(store.runNow('export', 20_000)).toBe(true)
    expect(store.runNow('missing', 20_000)).toBe(false)
  })
})

describe('the schedule', () => {
  it('is the next local HH:MM strictly after', () => {
    const at = new Date(2026, 10, 3, 3, 30).getTime()
    expect(nextAt('03:30', at - 1)).toBe(at)
    expect(nextAt('03:30', at)).toBe(new Date(2026, 10, 4, 3, 30).getTime())
  })

  it('reads HH:MM in the zone given, across a daylight-saving change', () => {
    const ny = 'America/New_York'
    const after = Date.UTC(2026, 10, 7, 21, 0) // 16:00 EST
    expect(nextAt('16:30', after, ny)).toBe(Date.UTC(2026, 10, 7, 21, 30))
    expect(nextAt('16:30', Date.UTC(2026, 10, 7, 21, 30), ny)).toBe(Date.UTC(2026, 10, 8, 21, 30))
    // Clocks went forward on 8 March: 16:30 is 20:30 UTC afterwards, 21:30 UTC before.
    expect(nextAt('16:30', Date.UTC(2026, 2, 7, 22, 0), ny)).toBe(Date.UTC(2026, 2, 8, 20, 30))
    expect(nextAt('16:30', Date.UTC(2026, 2, 7, 21, 0), ny)).toBe(Date.UTC(2026, 2, 7, 21, 30))
    expect(nextRun({ at: '16:30', tz: 'UTC' }, Date.UTC(2026, 10, 7, 10, 0))).toBe(
      Date.UTC(2026, 10, 7, 16, 30),
    )
  })

  describe('weekly and monthly', () => {
    const ny = 'America/New_York'
    const at = (on: string, time: string, after: number) => nextAt(time, after, ny, on)

    it('runs on a weekday at a time, once per week', () => {
      // Sat 7 Nov 2026 noon EST: the next Monday 06:30 EST is 11:30 UTC.
      const sat = Date.UTC(2026, 10, 7, 17, 0)
      expect(at('mon', '06:30', sat)).toBe(Date.UTC(2026, 10, 9, 11, 30))
      expect(at('mon', '06:30', Date.UTC(2026, 10, 9, 11, 30))).toBe(Date.UTC(2026, 10, 16, 11, 30))
      expect(at('mon', '06:30', Date.UTC(2026, 10, 9, 11, 29))).toBe(Date.UTC(2026, 10, 9, 11, 30))
    })

    it('runs on the nth weekday of the month, and the last one', () => {
      // First Saturday 00:30: 7 Nov 2026 (05:30 UTC), then 5 Dec.
      expect(at('1st-sat', '00:30', Date.UTC(2026, 10, 1, 0, 0))).toBe(Date.UTC(2026, 10, 7, 5, 30))
      expect(at('1st-sat', '00:30', Date.UTC(2026, 10, 7, 5, 30))).toBe(
        Date.UTC(2026, 11, 5, 5, 30),
      )
      // Third Sunday 08:00: 15 Nov, then 20 Dec. The 8th is a second Sunday, the 22nd a fourth.
      expect(at('3rd-sun', '08:00', Date.UTC(2026, 10, 1, 0, 0))).toBe(
        Date.UTC(2026, 10, 15, 13, 0),
      )
      expect(at('3rd-sun', '08:00', Date.UTC(2026, 10, 15, 13, 0))).toBe(
        Date.UTC(2026, 11, 20, 13, 0),
      )
      expect(at('last-fri', '09:00', Date.UTC(2026, 10, 1, 0, 0))).toBe(
        Date.UTC(2026, 10, 27, 14, 0),
      )
      expect(at('4th-thu', '09:00', Date.UTC(2026, 10, 1, 0, 0))).toBe(
        Date.UTC(2026, 10, 26, 14, 0),
      )
    })

    it('runs on a day of the month, rolling over the year', () => {
      expect(at('day-15', '08:00', Date.UTC(2026, 10, 1, 0, 0))).toBe(Date.UTC(2026, 10, 15, 13, 0))
      expect(at('day-15', '08:00', Date.UTC(2026, 11, 20, 0, 0))).toBe(Date.UTC(2027, 0, 15, 13, 0))
      expect(at('day-28', '08:00', Date.UTC(2027, 1, 1, 0, 0))).toBe(Date.UTC(2027, 1, 28, 13, 0))
    })

    it('keeps the wall-clock time across a daylight-saving change', () => {
      // Clocks went forward on Sun 8 Mar 2026: Monday 06:30 is 11:30 UTC before and 10:30 after.
      expect(at('mon', '06:30', Date.UTC(2026, 2, 2, 12, 0))).toBe(Date.UTC(2026, 2, 9, 10, 30))
      expect(at('mon', '06:30', Date.UTC(2026, 1, 20, 0, 0))).toBe(Date.UTC(2026, 1, 23, 11, 30))
      // Clocks went back on Sun 1 Nov: the first Sunday that month is that day, at EST.
      expect(at('1st-sun', '08:00', Date.UTC(2026, 9, 5, 0, 0))).toBe(Date.UTC(2026, 10, 1, 13, 0))
      expect(at('mon', '06:30', Date.UTC(2026, 10, 1, 12, 0))).toBe(Date.UTC(2026, 10, 2, 11, 30))
      // A time the clock skips runs once, an hour later by the new clock (02:30 does not exist).
      expect(at('sun', '02:30', Date.UTC(2026, 2, 7, 12, 0))).toBe(Date.UTC(2026, 2, 8, 7, 30))
      expect(at('sun', '02:30', Date.UTC(2026, 2, 8, 7, 30))).toBe(Date.UTC(2026, 2, 15, 6, 30))
      // A time that happens twice (01:30 on 1 Nov) runs at the first.
      expect(at('sun', '01:30', Date.UTC(2026, 9, 25, 12, 0))).toBe(Date.UTC(2026, 10, 1, 5, 30))
    })

    it('reads the day in the machine zone when none is given, and in the given zone otherwise', () => {
      const t = nextRun({ at: '06:30', on: 'mon', tz: 'UTC' }, Date.UTC(2026, 10, 7, 17, 0))
      expect(t).toBe(Date.UTC(2026, 10, 9, 6, 30))
      // Late Sunday evening in New York is already Monday in UTC.
      expect(nextRun({ at: '01:00', on: 'mon', tz: 'UTC' }, Date.UTC(2026, 10, 9, 0, 30))).toBe(
        Date.UTC(2026, 10, 9, 1, 0),
      )
      expect(nextRun({ at: '01:00', on: 'mon', tz: ny }, Date.UTC(2026, 10, 9, 0, 30))).toBe(
        Date.UTC(2026, 10, 9, 6, 0),
      )
      const local = nextRun({ at: '06:30', on: 'mon' }, new Date(2026, 10, 7, 12, 0).getTime())
      expect(new Date(local).getDay()).toBe(1)
      expect(new Date(local).getHours()).toBe(6)
    })

    it('says it in words, and refuses a day it does not know', () => {
      expect(schedule({ at: '06:30', on: 'mon' })).toBe('every Monday at 06:30')
      expect(schedule({ at: '00:30', on: '1st-sat' })).toBe(
        'the first Saturday of each month at 00:30',
      )
      expect(schedule({ at: '08:00', on: 'last-sun' })).toBe(
        'the last Sunday of each month at 08:00',
      )
      expect(schedule({ at: '08:00', on: 'day-1' })).toBe('on the 1st of each month at 08:00')
      expect(schedule({ at: '08:00', on: 'day-22' })).toBe('on the 22nd of each month at 08:00')
      expect(schedule({ at: '08:00' })).toBe('daily at 08:00')
      const base = {
        kind: 'w',
        what: 'W',
        project: 'aico',
        home: 'a',
        lease_s: 60,
        run: { command: ['true'] },
      }
      const [job] = parseJobs({ jobs: [{ ...base, at: '06:30', on: 'mon' }] })
      expect(job).toMatchObject({ at: '06:30', on: 'mon' })
      for (const on of ['monday', '5th-sat', 'day-0', 'day-29', 'day-', 'sat-1st'])
        expect(() => parseJobs({ jobs: [{ ...base, at: '06:30', on }] })).toThrow('jobs[0].on')
      expect(() => parseJobs({ jobs: [{ ...base, on: 'mon', every_min: 5 }] })).toThrow('needs at')
    })
  })

  it('repeats every_min minutes, and a job has one of at or every_min', () => {
    const base = { kind: 'sync', what: 'Sync', project: 'aico', home: 'a', lease_s: 60 }
    const run = { command: ['true'] }
    const [job] = parseJobs({ jobs: [{ ...base, every_min: 10, run }] })
    expect(job).toMatchObject({ every_min: 10 })
    expect(job).not.toHaveProperty('at')
    expect(nextRun(job as JobDef, 1_000)).toBe(1_000 + 600_000)
    expect(() => parseJobs({ jobs: [{ ...base, run }] })).toThrow('exactly one of at')
    expect(() => parseJobs({ jobs: [{ ...base, at: '03:30', every_min: 10, run }] })).toThrow(
      'exactly one of at',
    )
    expect(() => parseJobs({ jobs: [{ ...base, every_min: 0, run }] })).toThrow('every_min')
  })

  it('reads the shipped job list and refuses a bad one by field', () => {
    const shipped = readJobs(new URL('../data/jobs.json', import.meta.url).pathname)
    expect(shipped.map((job) => job.kind)).toContain('notes-export')
    const job = { ...shipped[0] }
    expect(() => parseJobs({ jobs: [{ ...job, at: '3:30' }] })).toThrow('jobs[0].at')
    expect(() => parseJobs({ jobs: [job, job] })).toThrow('listed twice')
    expect(() => parseJobs({ jobs: [{ ...job, run: {} }] })).toThrow('jobs[0].run')
    expect(() => parseJobs({ jobs: [{ ...job, lease_s: 0 }] })).toThrow('jobs[0].lease_s')
  })
})

const job: JobDef = {
  kind: 'export',
  what: 'Notes export to Drive',
  project: 'aico',
  home: 'a',
  at: '03:30',
  run: { post: '/api/export/notes' },
  lease_s: 60,
}

function runnerFor(
  who: typeof A,
  store: JobStore,
  clock: { now: number },
  act: () => Promise<{ state: 'ok' | 'failed'; meaning: string }>,
  def: JobDef = job,
) {
  const posted: StatusRow[][] = []
  const logs: string[] = []
  const runner = new Runner({
    store,
    jobs: [def],
    machine: who.machine,
    holder: who.holder,
    act,
    postRows: async (rows) => {
      posted.push(rows)
    },
    now: () => clock.now,
    log: (line) => logs.push(line),
  })
  return { runner, posted, logs }
}

describe('the runner', () => {
  it('a running job stays due until its lease runs out, so a long run never reads late', () => {
    const job = { kind: 'k', what: 'K', project: 'p', home: 'h' } as unknown as JobDef
    const base = {
      kind: 'k',
      nextRun: 1000,
      fence: 1,
      leaseId: 'l',
      holder: 'w',
      holderMachine: 'h',
      leaseExpires: 9000,
      lastRun: 500,
      lastState: 'failed',
      lastMeaning: 'Exited 1',
      lastMachine: 'h',
      paused: false,
    } as unknown as Parameters<typeof jobRow>[1]
    expect(jobRow(job, base).next_run).toBe(new Date(9000).toISOString())
    expect(jobRow(job, { ...base, leaseId: null, leaseExpires: null }).next_run).toBe(
      new Date(1000).toISOString(),
    )
    expect(jobRow(job, { ...base, nextRun: 20000 }).next_run).toBe(new Date(20000).toISOString())
  })

  it('runs a job on its home machine when due and writes its one row with next_run', async () => {
    const clock = { now: new Date(2026, 10, 3, 3, 0).getTime() }
    const store = new JobStore(':memory:')
    const home = runnerFor(A, store, clock, async () => ({
      state: 'ok',
      meaning: 'Copied 3 notes.',
    }))
    const other = runnerFor(B, store, clock, async () => ({ state: 'ok', meaning: 'other' }))
    home.runner.start()
    other.runner.start()
    await home.runner.tick()
    expect(home.posted[0]?.[0]).toMatchObject({
      id: 'jobs/export',
      kind: 'job',
      machine: 'a',
      state: 'ok',
      next_run: new Date(2026, 10, 3, 3, 30).toISOString(),
    })
    expect(other.posted).toEqual([])
    clock.now = new Date(2026, 10, 3, 3, 30).getTime()
    await other.runner.tick()
    await home.runner.tick()
    await home.runner.idle()
    const row = home.posted.at(-1)?.[0]
    expect(row).toMatchObject({
      machine: 'a',
      meaning: 'Copied 3 notes.',
      last_run: new Date(2026, 10, 3, 3, 30).toISOString(),
      next_run: new Date(2026, 10, 4, 3, 30).toISOString(),
    })
    expect(store.get('export')?.fence).toBe(1)
  })

  it('sends the lease host a new row when another machine ran the job on its lease', async () => {
    const clock = { now: new Date(2026, 10, 3, 3, 0).getTime() }
    const store = new JobStore(':memory:')
    const def: JobDef = { ...job, home: 'a', lease_host: 'b', workers: ['a'] }
    const host = runnerFor(
      B,
      store,
      clock,
      async () => ({ state: 'ok', meaning: 'never here' }),
      def,
    )
    host.runner.start()
    await host.runner.tick()
    expect(host.posted).toHaveLength(1)
    expect(host.posted[0]?.[0]).toMatchObject({ id: 'jobs/export', machine: 'a' })
    // Nothing changed: no second row.
    await host.runner.tick()
    await host.runner.idle()
    expect(host.posted).toHaveLength(1)
    // The worker runs it on this host's lease (as the fleet link does) and posts only to its own Status.
    clock.now = new Date(2026, 10, 3, 3, 31).getTime()
    const lease = store.claim('export', A, clock.now, TTL, 0)
    if (!lease) throw new Error('no lease')
    store.complete(
      lease,
      { state: 'ok', meaning: 'Copied 3 notes.' },
      clock.now,
      clock.now + 86_400_000,
    )
    await host.runner.tick()
    await host.runner.idle()
    expect(host.posted).toHaveLength(2)
    expect(host.posted[1]?.[0]).toMatchObject({
      machine: 'a',
      state: 'ok',
      meaning: 'Copied 3 notes.',
      // Due once the lease host's own turn has passed too.
      next_run: new Date(clock.now + 86_400_000 + def.lease_s * 1000).toISOString(),
    })
  })

  it('takes the Status row of a removed routine down', async () => {
    const clock = { now: new Date(2026, 10, 3, 3, 0).getTime() }
    const store = new JobStore(':memory:')
    let jobs: JobDef[] = [job]
    const removed: string[] = []
    const runner = new Runner({
      store,
      jobs: () => jobs,
      machine: 'a',
      holder: 'a:1',
      act: async () => ({ state: 'ok', meaning: 'x' }),
      postRows: async () => {},
      removeRow: async (id) => void removed.push(id),
      now: () => clock.now,
      log: () => {},
    })
    runner.start()
    await runner.tick()
    expect(removed).toEqual([])
    jobs = []
    await runner.tick()
    await runner.tick()
    expect(removed).toEqual(['jobs/export'])
  })

  it('takes down the row of a removed routine this process never ran', async () => {
    const clock = { now: new Date(2026, 10, 3, 3, 0).getTime() }
    const store = new JobStore(':memory:')
    let jobs: JobDef[] = [{ ...job, home: 'b', lease_host: 'b', workers: ['a', 'b'] }]
    const removed: string[] = []
    const runner = new Runner({
      store,
      jobs: () => jobs,
      machine: 'a',
      holder: 'a:1',
      authority: () =>
        ({
          claim: async () => null,
          get: async () => null,
        }) as never,
      act: async () => ({ state: 'ok', meaning: 'x' }),
      postRows: async () => {},
      removeRow: async (id) => void removed.push(id),
      now: () => clock.now,
      log: () => {},
    })
    runner.start()
    await runner.tick()
    jobs = []
    await runner.tick()
    expect(removed).toEqual(['jobs/export'])
  })

  it('never runs a job homed on another machine, however overdue', async () => {
    const clock = { now: new Date(2026, 10, 3, 3, 29).getTime() }
    const store = new JobStore(':memory:')
    let ran = 0
    const other = runnerFor(B, store, clock, async () => {
      ran += 1
      return { state: 'ok', meaning: '' }
    })
    other.runner.start()
    expect(store.get('export')).toBeNull()
    store.ensure('export', clock.now)
    clock.now += 24 * 3600_000
    await other.runner.tick()
    await other.runner.idle()
    expect(ran).toBe(0)
    expect(store.get('export')).toMatchObject({ fence: 0, leaseId: null })
    expect(other.posted).toEqual([])
  })

  it('logs a failed renew or result write instead of throwing, and lets the work finish', async () => {
    const clock = { now: new Date(2026, 10, 3, 3, 29).getTime() }
    const store = new JobStore(':memory:')
    let finish: (value: { state: 'ok'; meaning: string }) => void = () => {}
    // A 30 ms lease: renewals every 10 ms of real time.
    const quick = { ...job, lease_s: 0.03 }
    const home = runnerFor(
      A,
      store,
      clock,
      () => new Promise((resolve) => (finish = resolve)),
      quick,
    )
    home.runner.start()
    clock.now += 60_000
    await home.runner.tick()
    store.renew = () => {
      throw new Error('disk I/O error')
    }
    store.complete = () => {
      throw new Error('database is locked')
    }
    await vi.waitFor(() =>
      expect(home.logs).toContain('export: could not renew lease 1: disk I/O error'),
    )
    finish({ state: 'ok', meaning: 'Copied.' })
    await home.runner.idle()
    expect(home.logs.at(-1)).toBe(
      'export: could not record its result (ok: Copied.): database is locked',
    )
  })

  it('keeps a row it could not write and sends it on the next tick', async () => {
    const clock = { now: 0 }
    const store = new JobStore(':memory:')
    let fail = true
    const sent: StatusRow[] = []
    const runner = new Runner({
      store,
      jobs: [job],
      machine: 'a',
      holder: 'a:1',
      act: async () => ({ state: 'ok', meaning: '' }),
      postRows: async (rows) => {
        if (fail) throw new Error('down')
        sent.push(...rows)
      },
      now: () => clock.now,
      log: () => {},
    })
    runner.start()
    await runner.tick()
    fail = false
    await runner.tick()
    expect(sent.map((row) => row.id)).toEqual(['jobs/export'])
  })

  it('reports an unreachable lease holder when asked to run a remote job', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aico-jobs-'))
    const env = {
      AICO_JOBS_DB: join(dir, 'jobs.db'),
      XDG_RUNTIME_DIR: dir,
      AICO_WEB_URL: 'http://127.0.0.1:9',
    }
    const lines: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((line) => lines.push(String(line)))
    const out = vi.spyOn(console, 'log').mockImplementation((line) => lines.push(String(line)))
    try {
      const code = await main(['run', 'notes-export', '--machine', 'gem'], env)
      expect(code).toBe(1)
      expect(lines[0]).toContain('lease holder davion-sidarli is not reachable')
      lines.length = 0
      await main(['list', 'notes-export', '--machine', 'gem'], env)
      expect(lines.length).toBeGreaterThan(0)
      expect(lines.every((line) => line.startsWith('notes-export'))).toBe(true)
      lines.length = 0
      await main(['list', '--machine', 'gem'], env)
      expect(lines).toHaveLength(
        readJobs(new URL('../data/jobs.json', import.meta.url).pathname).length,
      )
      const configured = readJobs(new URL('../data/jobs.json', import.meta.url).pathname)
      expect(
        lines.every((line, index) =>
          line.includes(
            `lease holder ${configured[index]?.lease_host ?? configured[index]?.home} unavailable`,
          ),
        ),
      ).toBe(true)
    } finally {
      spy.mockRestore()
      out.mockRestore()
    }
  })

  it('says a job has not run yet', () => {
    const store = new JobStore(':memory:')
    store.ensure('export', 0)
    const state = store.get('export')
    if (!state) throw new Error('no job')
    expect(jobRow(job, state).meaning).toBe('Not run yet. Runs daily at 03:30 on a.')
    const refs = jobRow(job, state).actions?.map((action) => action.ref)
    expect(refs).toEqual(['aico routines run export', 'aico routines log export'])
  })
})

describe('an every_min job', () => {
  it('is first due at once, then every_min minutes after it finishes, and says so in its row', async () => {
    const clock = { now: new Date(2026, 10, 3, 3, 0).getTime() }
    const store = new JobStore(':memory:')
    const { at: _at, ...daily } = job
    const every: JobDef = { ...daily, kind: 'sync', every_min: 10 }
    const posted: StatusRow[][] = []
    const runner = new Runner({
      store,
      jobs: [every],
      machine: 'a',
      holder: 'a:1',
      act: async () => ({ state: 'ok', meaning: 'Copied.' }),
      postRows: async (rows) => {
        posted.push(rows)
      },
      now: () => clock.now,
      log: () => {},
    })
    runner.start()
    expect(posted).toEqual([])
    expect(jobRow(every, store.get('sync') as never).meaning).toBe(
      'Not run yet. Runs every 10 minutes on a.',
    )
    await runner.tick()
    await runner.idle()
    expect(posted.at(-1)?.[0]).toMatchObject({
      id: 'jobs/sync',
      state: 'ok',
      next_run: new Date(clock.now + 600_000).toISOString(),
    })
    clock.now += 599_000
    await runner.tick()
    await runner.idle()
    expect(store.get('sync')?.fence).toBe(1)
    clock.now += 2_000
    await runner.tick()
    await runner.idle()
    expect(store.get('sync')?.fence).toBe(2)
  })
})

describe('what a job does', () => {
  it('reads aico-web answers', () => {
    expect(
      answerResult({ status: 200, body: '{"status":"skipped","message":"Gem does it."}' }),
    ).toEqual({
      state: 'ok',
      meaning: 'Gem does it.',
    })
    expect(answerResult({ status: 503, body: '{"detail":"No Drive login."}' })).toEqual({
      state: 'failed',
      meaning: 'No Drive login.',
    })
    expect(answerResult({ status: 500, body: 'oops' }).meaning).toBe('Aico answered 500.')
  })

  it('posts to aico-web, and retries a refused connection', async () => {
    const server = createServer((req, res) => {
      res.writeHead(req.method === 'POST' ? 200 : 405).end('{"message":"Done."}')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    expect(await postJob(`http://127.0.0.1:${port}`, '/x')).toEqual({
      state: 'ok',
      meaning: 'Done.',
    })
    server.close()
    const refused = await postJob(`http://127.0.0.1:${port}`, '/x', 1)
    expect(refused.state).toBe('failed')
    expect(refused.meaning).toContain('Could not reach Aico')
  })

  it('runs a command and keeps its last line', async () => {
    expect(await commandJob(['sh', '-c', 'echo one; echo two'])).toEqual({
      state: 'ok',
      meaning: 'two',
    })
    expect(await commandJob(['sh', '-c', 'echo bad >&2; exit 3'])).toEqual({
      state: 'failed',
      meaning: 'Exited 3: bad',
    })
  })
})

describe('a POST job unit', () => {
  it("starts node with the runner's own flags, so node:sqlite's warning stays out of its log", () => {
    expect(
      selfArgv({
        execPath: '/usr/bin/node',
        execArgv: ['--disable-warning=ExperimentalWarning'],
        argv: ['/usr/bin/node', '/x/aico-jobs.mjs', 'serve'],
      }),
    ).toEqual(['/usr/bin/node', '--disable-warning=ExperimentalWarning', '/x/aico-jobs.mjs'])
  })
})

it('a printed run time names its zone', () => {
  const at = Date.UTC(2026, 10, 8, 12, 30)
  expect(runTime(at, 'America/New_York')).toBe('2026-11-08 07:30:00 EST')
  expect(runTime(at, 'UTC')).toBe('2026-11-08 12:30:00 UTC')
  expect(runTime(null)).toBe('-')
})

it('asks for the after-boot cleanup in its own unit, and a start that fails stays a log line', async () => {
  const started: unknown[] = []
  await startBootClean({
    start: async (unit: string, argv: readonly string[]) => void started.push([unit, argv]),
  } as never)
  expect(started).toEqual([['aico-boot-clean', ['aico', 'deploy', 'boot-clean']]])
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
  await startBootClean({
    start: async () => {
      throw new Error('already loaded')
    },
  } as never)
  expect(quiet).toHaveBeenCalledOnce()
  quiet.mockRestore()
})
