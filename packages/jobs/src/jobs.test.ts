import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { StatusRow } from '@aico/status'
import { describe, expect, it } from 'vitest'
import { answerResult, commandJob, postJob } from './act'
import { type JobDef, nextAt, parseJobs, readJobs } from './jobs'
import { JobStore, StaleLease } from './leases'
import { jobRow, Runner } from './runner'

const A = { holder: 'a:1', machine: 'a' }
const B = { holder: 'b:2', machine: 'b' }
const TTL = 60_000

describe('the lease', () => {
  it('fences a holder whose lease expired and was taken over: its writes are refused', () => {
    const store = new JobStore(':memory:')
    store.ensure('export', 1000)
    const first = store.claim('export', A, 1000, TTL)
    expect(first?.fence).toBe(1)
    expect(store.claim('export', B, 1000 + TTL - 1, TTL)).toBeNull()
    expect(store.renew(first!, 2000, TTL)).toBe(true)
    // A goes silent; its lease (renewed at 2000) runs out at 2000 + TTL.
    const second = store.claim('export', B, 2000 + TTL, TTL)
    expect(second).toMatchObject({ fence: 2, holder: 'b:2' })
    expect(second?.leaseId).not.toBe(first?.leaseId)
    expect(store.renew(first!, 2000 + TTL, TTL)).toBe(false)
    expect(() => store.complete(first!, { state: 'ok', meaning: 'late' }, 0, 5)).toThrow(StaleLease)
    store.complete(second!, { state: 'ok', meaning: 'done' }, 3000, 99_000)
    expect(store.get('export')).toMatchObject({
      fence: 2,
      leaseId: null,
      nextRun: 99_000,
      lastMachine: 'b',
      lastMeaning: 'done',
    })
    // Even the same fence with a forged lease id is refused.
    expect(() =>
      store.complete({ ...second!, leaseId: 'x' }, { state: 'ok', meaning: '' }, 0, 0),
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
  takeover_after_s: 600,
}

function runnerFor(
  who: typeof A,
  store: JobStore,
  clock: { now: number },
  act: () => Promise<{ state: 'ok' | 'failed'; meaning: string }>,
) {
  const posted: StatusRow[][] = []
  const logs: string[] = []
  const runner = new Runner({
    store,
    jobs: [job],
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

  it('hands the job to another machine once the holder stops renewing, and refuses the old result', async () => {
    const clock = { now: new Date(2026, 10, 3, 3, 29).getTime() }
    const store = new JobStore(':memory:')
    let finishA: (value: { state: 'ok'; meaning: string }) => void = () => {}
    const a = runnerFor(A, store, clock, () => new Promise((resolve) => (finishA = resolve)))
    const b = runnerFor(B, store, clock, async () => ({ state: 'ok', meaning: 'Copied.' }))
    a.runner.start()
    b.runner.start()
    clock.now += 60_000
    await a.runner.tick()
    expect(store.get('export')?.holder).toBe('a:1')
    // A is stuck (its renewals never reach the DB, as if killed); B waits for overdue and expiry.
    clock.now += 600_000
    await b.runner.tick()
    await b.runner.idle()
    expect(store.get('export')).toMatchObject({ fence: 2, lastMachine: 'b' })
    expect(b.posted.at(-1)?.[0]?.meaning).toBe('Ran here instead of a. Copied.')
    finishA({ state: 'ok', meaning: 'late' })
    await a.runner.idle()
    expect(a.logs.at(-1)).toContain('result refused')
    expect(store.get('export')?.lastMeaning).toBe('Ran here instead of a. Copied.')
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

  it('says a job has not run yet', () => {
    const store = new JobStore(':memory:')
    store.ensure('export', 0)
    expect(jobRow(job, store.get('export')!).meaning).toBe('Not run yet. Runs daily at 03:30 on a.')
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
