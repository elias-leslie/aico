// A job held on the standby (lease host `ct`) that the workstation (`ws`, its home) may stand in
// for: it runs there only while ct does not answer at all, and neither machine repeats that run
// once ct is back. A real partition (both up, link down) runs it on both; these tests pin that too.
import { describe, expect, it } from 'vitest'
import { type LeaseCall, leaseCall } from './fleet-leases'
import { type JobDef, parseJobs } from './jobs'
import { type JobResult, type JobState, JobStore, type Lease, Unreachable } from './leases'
import { type LeaseAuthority, Runner } from './runner'

const job: JobDef = {
  kind: 'digest',
  what: 'Digest',
  project: 'aico',
  home: 'ws',
  lease_host: 'ct',
  workers: ['ws', 'ct'],
  fallback: ['ws'],
  at: '07:30',
  tz: 'UTC',
  run: { post: '/x' },
  lease_s: 60,
}
const DAY = 86_400_000
const SLOT = Date.parse('2026-11-08T07:30:00Z')

function world(def: JobDef = job) {
  const clock = { now: SLOT - 3_600_000 }
  const net = { ct: true, link: true, refuse: false }
  const ran: string[] = []
  const stores = { ws: new JobStore(':memory:'), ct: new JobStore(':memory:') }
  const logs: string[] = []
  const hooks = { during: (_machine: string) => {} }
  // What one machine sends the other over the fleet link; down = no answer at all.
  const call = (from: 'ws' | 'ct', to: 'ws' | 'ct', body: LeaseCall) => {
    if (!net.link || (to === 'ct' && !net.ct)) throw new Unreachable('connect ECONNREFUSED')
    if (net.refuse) throw new Error('Lease authority answered 400')
    return leaseCall(stores[to], [def], to, body, from, clock.now)
  }
  const toCt: LeaseAuthority = {
    claim: async (kind, who) => call('ws', 'ct', { op: 'claim', kind, who }) as Lease | null,
    renew: async (lease) => call('ws', 'ct', { op: 'renew', kind: lease.kind, lease }) as boolean,
    complete: async (lease, result, ranAt) => {
      call('ws', 'ct', { op: 'complete', kind: lease.kind, lease, result, ranAt })
    },
    release: async (lease) => {
      call('ws', 'ct', { op: 'release', kind: lease.kind, lease })
    },
    get: async (kind) => call('ws', 'ct', { op: 'get', kind }) as JobState | null,
    report: async (kind: string, result: JobResult, ranAt: number) =>
      call('ws', 'ct', { op: 'report', kind, result, ranAt }) as boolean,
  }
  const runner = (machine: 'ws' | 'ct') =>
    new Runner({
      store: stores[machine],
      jobs: [def],
      machine,
      holder: `${machine}-runner`,
      now: () => clock.now,
      ...(machine === 'ws' ? { authority: () => toCt } : {}),
      standinOf: async (_job, other) =>
        call(machine, other as 'ws' | 'ct', { op: 'standin', kind: def.kind }) as JobState | null,
      act: async () => {
        ran.push(machine)
        hooks.during(machine)
        return { state: 'ok', meaning: `Sent from ${machine}.` }
      },
      postRows: async () => {},
      log: (line) => logs.push(line),
    })
  const machines = { ws: runner('ws'), ct: runner('ct') }
  machines.ct.start()
  const tick = async (...which: ('ws' | 'ct')[]) => {
    for (const name of which) {
      if (name === 'ct' && !net.ct) continue
      await machines[name].tick()
      await machines[name].idle()
    }
  }
  /** The standby restarts (a new scheduler process on the same database). */
  const restartCt = () => {
    machines.ct = runner('ct')
    machines.ct.start()
  }
  return { clock, net, ran, stores, logs, hooks, tick, restartCt }
}

describe('standing in while the lease host is down', () => {
  it('runs on the home through the lease host while it answers, once', async () => {
    const w = world()
    await w.tick('ws', 'ct')
    w.clock.now = SLOT
    await w.tick('ws', 'ct', 'ws', 'ct')
    w.clock.now = SLOT + 5 * 60_000
    await w.tick('ws', 'ct')
    expect(w.ran).toEqual(['ws'])
    expect(w.stores.ct.get('digest')?.lastMachine).toBe('ws')
    // The run went through ct's lease, so the workstation keeps no result of its own.
    expect(w.stores.ws.get('digest')?.lastRun).toBeNull()
  })

  it('stands in when the lease host does not answer, and ct takes that run when it comes back', async () => {
    const w = world()
    await w.tick('ws', 'ct')
    w.net.ct = false
    w.clock.now = SLOT
    await w.tick('ws', 'ws')
    expect(w.ran).toEqual(['ws'])
    expect(w.logs.some((line) => line.includes('ct does not answer'))).toBe(true)
    // ct boots well after the slot; before running the overdue slot it asks the workstation.
    w.clock.now = SLOT + 30 * 60_000
    w.net.ct = true
    w.restartCt()
    await w.tick('ct', 'ct', 'ws', 'ct')
    expect(w.ran).toEqual(['ws'])
    const ct = w.stores.ct.get('digest')
    expect(ct?.lastMachine).toBe('ws')
    expect(ct?.nextRun).toBe(SLOT + DAY)
    expect(w.logs.some((line) => line.includes('ws ran it while this machine was down'))).toBe(true)
  })

  it('hands its run to ct when the workstation reaches ct first, so neither repeats it', async () => {
    const w = world()
    await w.tick('ws', 'ct')
    w.net.ct = false
    w.clock.now = SLOT
    await w.tick('ws')
    w.clock.now = SLOT + 10_000
    w.net.ct = true
    // The link to ct is back before ct's scheduler ticks.
    await w.tick('ws', 'ws')
    expect(w.stores.ct.get('digest')?.lastMachine).toBe('ws')
    expect(w.stores.ct.get('digest')?.nextRun).toBe(SLOT + DAY)
    w.clock.now = SLOT + 10 * 60_000
    await w.tick('ct', 'ws', 'ct')
    expect(w.ran).toEqual(['ws'])
    expect(w.logs.some((line) => line.includes('handed the run made here to ct'))).toBe(true)
  })

  it('waits for the workstation after a ct restart, then runs the slot if it never answers', async () => {
    const w = world()
    await w.tick('ws', 'ct')
    w.net.ct = false
    w.net.link = false
    w.clock.now = SLOT + 30 * 60_000
    // Both were down at the slot. ct comes back first; the link is not up yet.
    w.net.ct = true
    w.restartCt()
    await w.tick('ct')
    expect(w.ran).toEqual([])
    w.clock.now += 61_000
    await w.tick('ct')
    expect(w.ran).toEqual(['ct'])
  })

  it('never stands in on a refusal, only when there is no answer', async () => {
    const w = world()
    await w.tick('ws', 'ct')
    w.net.refuse = true
    w.clock.now = SLOT + 5 * 60_000
    await w.tick('ws', 'ws')
    expect(w.ran).toEqual([])
    expect(w.stores.ws.get('digest')?.lastRun).toBeNull()
  })

  it('does not stand in for a job paused on ct', async () => {
    const w = world()
    w.stores.ct.ensure('digest', SLOT)
    w.stores.ct.setPaused('digest', true, 0)
    await w.tick('ws')
    w.net.ct = false
    w.clock.now = SLOT + 5 * 60_000
    await w.tick('ws', 'ws')
    expect(w.ran).toEqual([])
  })

  it('does not stand in for a slot ct was running when it went quiet', async () => {
    const w = world()
    await w.tick('ws', 'ct')
    w.clock.now = SLOT + 61_000
    // ct took the slot itself (the workstation had not); the workstation sees its lease, then
    // ct goes quiet while it runs.
    w.stores.ct.claim('digest', { holder: 'ct-runner', machine: 'ct' }, w.clock.now, 60_000, 60_000)
    await w.tick('ws')
    w.net.ct = false
    w.clock.now += 5_000
    await w.tick('ws', 'ws')
    expect(w.ran).toEqual([])
  })

  it('needs the machine in the job’s fallback list', async () => {
    const { fallback: _, ...plain } = job
    const w = world(plain)
    await w.tick('ws', 'ct')
    w.net.ct = false
    w.clock.now = SLOT + 5 * 60_000
    await w.tick('ws', 'ws')
    expect(w.ran).toEqual([])
  })

  it('runs on both sides of a real partition, and nothing runs a third time once it heals', async () => {
    const w = world()
    await w.tick('ws', 'ct')
    w.net.link = false
    w.clock.now = SLOT
    await w.tick('ws', 'ct')
    w.clock.now = SLOT + 61_000
    await w.tick('ct', 'ws')
    // Both are up but cannot reach each other: each runs the slot once. This is the known cost.
    expect(w.ran).toEqual(['ws', 'ct'])
    w.net.link = true
    w.clock.now = SLOT + 10 * 60_000
    await w.tick('ws', 'ct', 'ws', 'ct')
    expect(w.ran).toEqual(['ws', 'ct'])
    expect(w.stores.ct.get('digest')?.nextRun).toBe(SLOT + DAY)
    expect(w.stores.ws.get('digest')?.nextRun).toBe(SLOT + DAY)
  })
})

describe('no repeat after either machine comes back', () => {
  it('does not run a slot again when ct stops answering right after a normal run', async () => {
    const w = world()
    await w.tick('ws', 'ct')
    w.clock.now = SLOT
    await w.tick('ws')
    w.net.ct = false
    w.clock.now = SLOT + 2_000
    await w.tick('ws', 'ws')
    expect(w.ran).toEqual(['ws'])
  })

  it('keeps a run whose result ct could not take, and hands it over instead of running it again', async () => {
    const w = world()
    await w.tick('ws', 'ct')
    w.clock.now = SLOT
    w.hooks.during = (machine) => {
      if (machine === 'ws') w.net.ct = false
    }
    await w.tick('ws')
    w.hooks.during = () => {}
    await w.tick('ws')
    expect(w.ran).toEqual(['ws'])
    expect(w.logs.some((line) => line.includes('kept the result here to hand over'))).toBe(true)
    w.clock.now = SLOT + 30 * 60_000
    w.net.ct = true
    w.restartCt()
    await w.tick('ct', 'ws', 'ct')
    expect(w.ran).toEqual(['ws'])
    expect(w.stores.ct.get('digest')?.nextRun).toBe(SLOT + DAY)
  })

  it('makes ct wait while the workstation is still running the slot in its place', async () => {
    const w = world()
    await w.tick('ws', 'ct')
    w.clock.now = SLOT + 2 * 60_000
    // ws stands in (its lease, live), and ct is back before that run ends.
    w.stores.ws.claim('digest', { holder: 'ws-runner', machine: 'ws' }, w.clock.now, 60_000)
    w.restartCt()
    w.clock.now += 10_000
    await w.tick('ct', 'ct')
    expect(w.ran).toEqual([])
    expect(w.stores.ct.get('digest')?.leaseId).toBeNull()
  })

  it('covers a short drop of the link: ct asks before running and finds the run', async () => {
    const w = world()
    await w.tick('ws', 'ct')
    w.net.link = false
    w.clock.now = SLOT
    await w.tick('ws', 'ct')
    w.net.link = true
    w.clock.now = SLOT + 61_000
    await w.tick('ct', 'ct', 'ws')
    expect(w.ran).toEqual(['ws'])
    expect(w.stores.ct.get('digest')?.lastMachine).toBe('ws')
  })

  it('stands in again once the lease ct held when it went quiet has run out', async () => {
    const w = world()
    await w.tick('ws', 'ct')
    w.clock.now = SLOT + 61_000
    w.stores.ct.claim('digest', { holder: 'ct-runner', machine: 'ct' }, w.clock.now, 60_000, 60_000)
    await w.tick('ws')
    w.net.ct = false
    w.clock.now = SLOT + 3 * 60_000
    await w.tick('ws')
    expect(w.ran).toEqual(['ws'])
  })

  it('keeps following ct after a stand-in run here died with a restart (pause still copied)', async () => {
    const w = world()
    await w.tick('ws', 'ct')
    w.stores.ws.claim('digest', { holder: 'old', machine: 'ws' }, SLOT, 60_000)
    w.stores.ct.setPaused('digest', true, 0)
    w.clock.now = SLOT + 5 * 60_000
    await w.tick('ws')
    expect(w.stores.ws.get('digest')?.paused).toBe(true)
    expect(w.stores.ws.get('digest')?.leaseId).toBeNull()
    w.net.ct = false
    w.clock.now = SLOT + DAY + 60_000
    await w.tick('ws', 'ws')
    expect(w.ran).toEqual([])
  })

  it('stands in every minute for an every-minute job and ct does not repeat it when back', async () => {
    const { at: _, tz: __, ...rest } = job
    const w = world({ ...rest, kind: 'digest', every_min: 1 })
    await w.tick('ws', 'ct')
    w.net.ct = false
    for (let minute = 1; minute <= 3; minute++) {
      w.clock.now += 60_000
      await w.tick('ws')
    }
    expect(w.ran.length).toBeGreaterThanOrEqual(3)
    const before = w.ran.length
    w.net.ct = true
    w.restartCt()
    w.clock.now += 1_000
    await w.tick('ct', 'ws', 'ct')
    expect(w.ran.length).toBe(before)
  })

  it('takes a report only from a fallback worker, and answers standin only to the lease host', () => {
    const ct = new JobStore(':memory:')
    ct.ensure('digest', SLOT)
    const report: LeaseCall = {
      op: 'report',
      kind: 'digest',
      result: { state: 'ok', meaning: 'Sent.' },
      ranAt: SLOT,
    }
    expect(() => leaseCall(ct, [job], 'ct', report, 'pi', SLOT + 1)).toThrow('not a fallback')
    expect(leaseCall(ct, [job], 'ct', report, 'ws', SLOT + 1)).toBe(true)
    // A late result from the lease before is refused once the run is recorded.
    expect(leaseCall(ct, [job], 'ct', report, 'ws', SLOT + 2)).toBe(false)
    const ws = new JobStore(':memory:')
    expect(() => leaseCall(ws, [job], 'ws', { op: 'standin', kind: 'digest' }, 'pi', SLOT)).toThrow(
      'does not fall back',
    )
    expect(leaseCall(ws, [job], 'ws', { op: 'standin', kind: 'digest' }, 'ct', SLOT)).toBeNull()
  })
})

describe('fallback in jobs.json', () => {
  const base = {
    kind: 'digest',
    what: 'Digest',
    project: 'aico',
    home: 'ws',
    lease_host: 'ct',
    workers: ['ws', 'ct'],
    at: '07:30',
    run: { post: '/x' },
    lease_s: 60,
  }
  it('takes workers other than the lease host', () => {
    expect(parseJobs({ jobs: [{ ...base, fallback: ['ws'] }] })[0]?.fallback).toEqual(['ws'])
    expect(() => parseJobs({ jobs: [{ ...base, fallback: ['ct'] }] })).toThrow('jobs[0].fallback')
    expect(() => parseJobs({ jobs: [{ ...base, fallback: ['pi'] }] })).toThrow('jobs[0].fallback')
  })
})
