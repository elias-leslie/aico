import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StatusRow } from '@aico/status'
import { describe, expect, it, vi } from 'vitest'
import { answerResult, commandJob, postJob } from './act'
import { type JobDef, nextAt, nextRun, parseJobs, readJobs } from './jobs'
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

  it('ships the Agent Hub import every 10 minutes on davion-sidarli', () => {
    const shipped = readJobs(new URL('../data/jobs.json', import.meta.url).pathname)
    expect(shipped.find((job) => job.kind === 'context-import')).toMatchObject({
      home: 'davion-sidarli',
      every_min: 10,
      run: { command: expect.arrayContaining(['import-agent-hub']) },
    })
    const command = shipped.find((job) => job.kind === 'context-import')!.run
    expect('command' in command && command.command[0]).toBe(
      new URL('../../web-server/scripts/aico', new URL('../data/jobs.json', import.meta.url))
        .pathname,
    )
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
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(home.logs).toContain('export: could not renew lease 1: disk I/O error')
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
    // The log action never pages and shows a bounded tail.
    const log = jobRow(job, state).actions?.find((action) => action.kind === 'log')
    expect(log?.ref).toBe('journalctl --user -u aico-jobs.service -g export -n 200 --no-pager')
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
