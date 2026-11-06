import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  exitResult,
  type UnitHost,
  type UnitJobOptions,
  unitArgv,
  unitInFlight,
  unitJob,
  unitName,
} from './act'
import type { JobDef } from './jobs'
import { JobStore } from './leases'
import { type Act, Runner } from './runner'

const scratch = () => mkdtempSync(join(tmpdir(), 'jobs-'))

/** Real detached processes standing in for transient units: they outlive a "scheduler". */
function fakeUnits() {
  const live = new Set<string>()
  const started: string[] = []
  const host: UnitHost = {
    active: async (unit) => live.has(unit),
    start: async (unit, argv) => {
      if (live.has(unit)) throw new Error('Unit already exists')
      started.push(unit)
      live.add(unit)
      const child = spawn(argv[0] as string, argv.slice(1), { stdio: 'ignore' })
      child.on('exit', () => live.delete(unit))
    },
  }
  return { host, started }
}

const job: JobDef = {
  kind: 'backup',
  what: 'Backup',
  project: 'aico',
  home: 'a',
  every_min: 60,
  run: { command: ['sh', '-c', 'sleep 0.4; echo copied 3 files'] },
  lease_s: 60,
}

const runnerFor = (
  store: JobStore,
  holder: string,
  act: Act,
  units: UnitJobOptions,
  logs: string[],
) =>
  new Runner({
    store,
    jobs: [job],
    machine: 'a',
    holder,
    act,
    inFlight: (j) => unitInFlight(j.kind, units),
    postRows: async () => {},
    now: () => Date.now(),
    log: (line) => logs.push(line),
  })

describe('a run survives a scheduler restart', () => {
  it('adopts the live run: one start, one recorded result, the old holder fenced out', async () => {
    const dir = scratch()
    const { host, started } = fakeUnits()
    const units = { host, dir, pollMs: 20 }
    const store = new JobStore(':memory:')
    const logs: string[] = []
    // The first scheduler starts the unit, then dies without recording anything.
    const first = runnerFor(
      store,
      'a:1',
      async (j) => {
        await host.start(
          unitName(j.kind),
          unitArgv(join(dir, j.kind), (j.run as { command: string[] }).command),
        )
        return new Promise(() => {})
      },
      units,
      logs,
    )
    first.start()
    await first.tick()
    expect(started).toEqual(['aico-job-backup'])
    expect(store.get('backup')?.holder).toBe('a:1')

    // The next scheduler finds the lease held by a dead holder and the unit live: it adopts.
    const second = runnerFor(
      store,
      'a:2',
      (j) => unitJob(j.kind, (j.run as { command: string[] }).command, units),
      units,
      logs,
    )
    second.start()
    await second.tick()
    await second.idle()
    expect(logs.some((line) => line.includes('adopted the run a:1 left'))).toBe(true)
    expect(started).toEqual(['aico-job-backup'])
    expect(store.get('backup')).toMatchObject({
      leaseId: null,
      lastState: 'ok',
      lastMeaning: 'copied 3 files',
      fence: 2,
    })
  })

  it('records a run that finished while no scheduler was up, without running it again', async () => {
    const dir = scratch()
    const { host, started } = fakeUnits()
    const units = { host, dir, pollMs: 20 }
    const store = new JobStore(':memory:')
    store.ensure('backup', 0)
    expect(store.claim('backup', { holder: 'a:1', machine: 'a' }, 0, 60_000)).not.toBeNull()
    writeFileSync(join(dir, 'backup.log'), 'copied 9 files\n')
    writeFileSync(join(dir, 'backup.code'), '0\n')
    const logs: string[] = []
    const next = runnerFor(
      store,
      'a:2',
      (j) => unitJob(j.kind, (j.run as { command: string[] }).command, units),
      units,
      logs,
    )
    next.start()
    await next.tick()
    await next.idle()
    expect(started).toEqual([])
    expect(store.get('backup')).toMatchObject({ lastState: 'ok', lastMeaning: 'copied 9 files' })
  })

  it('joins the live unit when asked to run the same job twice', async () => {
    const dir = scratch()
    const { host, started } = fakeUnits()
    const units = { host, dir, pollMs: 20 }
    const run = ['sh', '-c', 'sleep 0.3; echo once']
    const [one, two] = await Promise.all([
      unitJob('backup', run, units),
      unitJob('backup', run, units),
    ])
    expect(started).toHaveLength(1)
    // One of them takes the code file; the other, finding it gone, reports it was not left.
    expect([one.meaning, two.meaning].sort()).toContain('once')
    expect(readFileSync(join(dir, 'backup.log'), 'utf8')).toBe('once\n')
  })
})

describe('a busy run is not a failed one', () => {
  it('reads exit 75 as busy and any other nonzero exit as failed', async () => {
    expect(exitResult(75, null, 'Already running: the drive backup is in progress.')).toEqual({
      state: 'ok',
      busy: true,
      meaning: 'Already running: the drive backup is in progress.',
    })
    expect(exitResult(1, null, 'boom')).toEqual({ state: 'failed', meaning: 'Exited 1: boom' })
    const { host } = fakeUnits()
    const result = await unitJob('lock', ['sh', '-c', 'echo held; exit 75'], {
      host,
      dir: scratch(),
      pollMs: 20,
    })
    expect(result).toMatchObject({ busy: true })
  })

  it('records no result and frees the lease, so the last good run stands and nothing alerts', async () => {
    const store = new JobStore(':memory:')
    store.ensure('backup', 0)
    const first = store.claim('backup', { holder: 'a:1', machine: 'a' }, 0, 60_000)
    if (!first) throw new Error('no lease')
    store.complete(first, { state: 'ok', meaning: 'copied 3 files' }, 1_000, 2_000)
    const rows: string[] = []
    const logs: string[] = []
    const clock = { now: 5_000 }
    const runner = new Runner({
      store,
      jobs: [job],
      machine: 'a',
      holder: 'a:1',
      act: async () => ({ state: 'ok', busy: true, meaning: 'Already running.' }),
      postRows: async (batch) => void rows.push(...batch.map((row) => `${row.id}:${row.state}`)),
      now: () => clock.now,
      log: (line) => logs.push(line),
    })
    await runner.tick()
    await runner.idle()
    expect(store.get('backup')).toMatchObject({
      leaseId: null,
      lastState: 'ok',
      lastMeaning: 'copied 3 files',
      lastRun: 1_000,
      nextRun: 5_000 + 60_000,
    })
    expect(logs).toContain('backup: already running: Already running.')
    expect(rows.every((row) => !row.endsWith(':failed'))).toBe(true)
  })
})
