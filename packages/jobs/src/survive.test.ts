import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  act,
  answerResult,
  exitResult,
  postedResult,
  type UnitHost,
  type UnitJobOptions,
  unitArgv,
  unitInFlight,
  unitJob,
  unitName,
} from './act'
import type { JobDef } from './jobs'
import { JobStore } from './leases'
import { type Act, jobRow, Runner } from './runner'

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

/** A command that prints `line` once the test creates DIR/release: the run lasts exactly as long as the test needs, not a guessed delay. */
const held = (dir: string, line: string) => [
  'sh',
  '-c',
  `while [ ! -e "${dir}/release" ]; do sleep 0.02; done; echo '${line}'`,
]
const release = (dir: string) => writeFileSync(join(dir, 'release'), '')

/** Waits for a condition the code under test reaches by itself (no fixed sleep to outrun a loaded machine). */
async function until(condition: () => boolean) {
  while (!condition()) await new Promise((resolve) => setTimeout(resolve, 5))
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

it('a failed job keeps its failure while an active retry explains what is happening now', () => {
  const store = new JobStore(':memory:')
  store.ensure(job.kind, 0)
  const first = store.claim(job.kind, { holder: 'a:1', machine: 'a' }, 0, 60_000)
  if (!first) throw new Error('no first lease')
  store.complete(
    first,
    { state: 'failed', meaning: '2 sources failed: Jobinator, Dadbot.' },
    0,
    1_000,
  )
  const second = store.claim(job.kind, { holder: 'a:2', machine: 'a' }, 1_000, 60_000)
  if (!second) throw new Error('no retry lease')
  const state = store.get(job.kind)
  if (!state) throw new Error('no job')
  expect(jobRow(job, state, 1_000)).toMatchObject({
    state: 'failed',
    meaning: 'Retrying. Last run failed: 2 sources failed: Jobinator, Dadbot.',
  })
  expect(jobRow(job, state, 61_000)).toMatchObject({
    state: 'failed',
    meaning: '2 sources failed: Jobinator, Dadbot.',
  })
})

it('publishes the active retry when it starts, before waiting for its result', async () => {
  const store = new JobStore(':memory:')
  store.ensure(job.kind, 0)
  const first = store.claim(job.kind, { holder: 'a:1', machine: 'a' }, 0, 60_000)
  if (!first) throw new Error('no first lease')
  store.complete(first, { state: 'failed', meaning: '1 source failed: Dadbot.' }, 0, 1_000)
  const rows: ReturnType<typeof jobRow>[] = []
  let finish: (() => void) | undefined
  const held = new Promise<void>((resolve) => {
    finish = resolve
  })
  const runner = new Runner({
    store,
    jobs: [job],
    machine: 'a',
    holder: 'a:2',
    now: () => 1_000,
    log: () => {},
    act: async () => {
      await held
      return { state: 'ok', meaning: 'Backup finished.' }
    },
    postRows: async (batch) => void rows.push(...batch),
  })
  await runner.tick()
  const retry = rows.at(-1)
  finish?.()
  await runner.idle()
  expect(retry).toMatchObject({
    state: 'failed',
    meaning: 'Retrying. Last run failed: 1 source failed: Dadbot.',
  })
})

describe('a run survives a scheduler restart', () => {
  it('adopts the live run: one start, one recorded result, the old holder fenced out', async () => {
    const dir = scratch()
    const command = held(dir, 'copied 3 files')
    const { host, started } = fakeUnits()
    const units = { host, dir, pollMs: 20 }
    const store = new JobStore(':memory:')
    const logs: string[] = []
    // The first scheduler starts the unit, then dies without recording anything.
    const first = runnerFor(
      store,
      'a:1',
      async (j) => {
        await host.start(unitName(j.kind), unitArgv(join(dir, j.kind), command))
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
    const second = runnerFor(store, 'a:2', (j) => unitJob(j.kind, command, units), units, logs)
    second.start()
    await second.tick()
    release(dir)
    await second.idle()
    expect(readFileSync(join(dir, 'backup.boot'), 'utf8').trim()).toBe(
      readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    )
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
    const run = held(dir, 'once')
    const both = Promise.all([unitJob('backup', run, units), unitJob('backup', run, units)])
    await until(() => started.length > 0)
    release(dir)
    const [one, two] = await both
    expect(started).toHaveLength(1)
    // One of them takes the code file; the other, finding it gone, reports it was not left.
    expect([one.meaning, two.meaning].sort()).toContain('once')
  })
})

describe('a POST job survives a scheduler restart too', () => {
  // Stands in for `node aico-jobs.mjs`: `post PATH` holds "the request" open, then prints the result.
  const self = (dir: string) => [
    ...held(dir, '{"state":"warn","meaning":"Copied; one peer behind."}'),
    'self',
  ]
  const postJobDef: JobDef = {
    ...job,
    kind: 'notes-export',
    run: { post: '/api/export/notes' },
  }

  it('runs in its own unit; the next scheduler adopts it and records its answer once', async () => {
    const dir = scratch()
    const { host, started } = fakeUnits()
    const units = { host, dir, pollMs: 20 }
    const store = new JobStore(':memory:')
    const logs: string[] = []
    const make = (holder: string, run: Act) =>
      new Runner({
        store,
        jobs: [postJobDef],
        machine: 'a',
        holder,
        act: run,
        inFlight: (j) => unitInFlight(j.kind, units),
        postRows: async () => {},
        log: (line) => logs.push(line),
      })
    // The first scheduler starts the unit and is killed before it records anything.
    // It only starts the unit: a scheduler still polling in this process would race the next one for the code file.
    const first = make('a:1', async (j) => {
      await host.start(
        unitName(j.kind),
        unitArgv(join(dir, j.kind), [...self(dir), 'post', '/api/export/notes']),
      )
      return new Promise(() => {})
    })
    first.start()
    await first.tick()
    expect(started).toEqual(['aico-job-notes-export'])

    const second = make('a:2', act(self(dir), units))
    second.start()
    await second.tick()
    release(dir)
    await second.idle()
    expect(logs.some((line) => line.includes('adopted the run a:1 left'))).toBe(true)
    expect(started).toEqual(['aico-job-notes-export'])
    expect(store.get('notes-export')).toMatchObject({
      leaseId: null,
      lastState: 'warn',
      lastMeaning: 'Copied; one peer behind.',
    })
  })

  it("reads the printed result, and a run that printed none as a command's exit", () => {
    expect(postedResult(0, 'noise\n{"state":"ok","meaning":"Uploaded."}\n')).toEqual({
      state: 'ok',
      meaning: 'Uploaded.',
    })
    expect(postedResult(0, '{"state":"ok","busy":true,"meaning":"Already running."}')).toEqual({
      state: 'ok',
      busy: true,
      meaning: 'Already running.',
    })
    expect(postedResult(1, 'aico jobs: boom')).toEqual({
      state: 'failed',
      meaning: 'Exited 1: aico jobs: boom',
    })
    expect(
      answerResult({ status: 409, body: '{"detail":"An export is already running"}' }),
    ).toEqual({ state: 'ok', busy: true, meaning: 'An export is already running' })
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
    // A JSON report at the end is for tools: the line before it, or Finished.
    expect(exitResult(0, null, 'Reaped 2 guests.\n{\n  "reaped": [\n    "a"\n  ]\n}')).toEqual({
      state: 'ok',
      meaning: 'Reaped 2 guests.',
    })
    expect(exitResult(0, null, '{"closed":[],"kept":0}')).toEqual({
      state: 'ok',
      meaning: 'Finished.',
    })
    expect(exitResult(0, null, '  "x": 1\n}')).toEqual({ state: 'ok', meaning: 'Finished.' })
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

describe('a run this machine shut down under (owner 2026-11-08: off is just off)', () => {
  const NOW = 10_000
  /** A unit that already ended: its code file holds `code` (no file with null), written before `bootedAt` if set. */
  const ended = (
    code: number | null,
    host: Partial<UnitHost> = {},
    bootId?: string,
    scope?: 'user' | 'system',
  ) => {
    const dir = scratch()
    if (code !== null) writeFileSync(join(dir, 'drive.code'), `${code}\n`)
    if (bootId) writeFileSync(join(dir, 'drive.boot'), `${bootId}\n`)
    writeFileSync(join(dir, 'drive.log'), 'The backup did not finish cleanly.\n')
    const units = { active: async () => false, start: async () => {}, ...host }
    // A live unit that goes away, as the runner sees it: the code is read once it has ended.
    let looks = 0
    return unitJob(
      'drive',
      ['true'],
      { dir, pollMs: 1, host: { ...units, active: async () => looks++ === 0 } },
      undefined,
      { scope },
    )
  }
  const stopping = async () => true
  const running = async () => false

  it('reads as cut short, not failed, while the machine is stopping', async () => {
    for (const code of [130, 143, 1, null])
      expect(await ended(code, { stopping })).toMatchObject({ cut: true, state: 'ok' })
  })

  it('passes the unit scope so stopping a user manager does not hide a system job failure', async () => {
    const host = {
      stopping: async (where?: { scope?: 'user' | 'system' }) => where?.scope !== 'system',
    }
    expect(await ended(1, host, undefined, 'system')).toMatchObject({ state: 'failed' })
    expect(await ended(1, host, undefined, 'user')).toMatchObject({ cut: true })
  })

  it('reads as cut short after the boot when it left a signal exit from the last boot', async () => {
    const earlier = { stopping: running, bootedAt: () => Date.now() + 60_000 }
    expect(await ended(130, earlier)).toMatchObject({ cut: true })
    expect(await ended(143, earlier)).toMatchObject({ cut: true })
  })

  it('uses boot identity even when wall-clock timestamps disagree', async () => {
    const host = { stopping: running, bootId: () => 'this-boot', bootedAt: () => 0 }
    // The clock moved back after a reboot: the previous boot's exit file looks newer than this boot.
    expect(await ended(143, host, 'last-boot')).toMatchObject({ cut: true })
    // The clock moved forward in this boot: an old-looking exit file is still this boot's failure.
    expect(
      await ended(143, { ...host, bootedAt: () => Date.now() + 60_000 }, 'this-boot'),
    ).toMatchObject({ state: 'failed' })
    expect(await ended(139, host, 'last-boot')).toMatchObject({ state: 'failed' })
  })

  it('a real failure still reads failed: any exit on a running machine, or a plain exit from the last boot', async () => {
    const thisBoot = { stopping: running, bootedAt: () => 0 }
    const lastBoot = { stopping: running, bootedAt: () => Date.now() + 60_000 }
    expect(await ended(1, thisBoot)).toMatchObject({ state: 'failed' })
    expect(await ended(1, lastBoot)).toMatchObject({ state: 'failed' })
    // A signal exit can be a real crash, not a shutdown: SIGKILL (including OOM) and SIGSEGV.
    expect(await ended(137, lastBoot)).toMatchObject({ state: 'failed' })
    expect(await ended(139, lastBoot)).toMatchObject({ state: 'failed' })
    // Stopped by hand: this boot's 130, and a unit gone with no result.
    expect(await ended(130, thisBoot)).toMatchObject({ state: 'failed' })
    expect(await ended(null, thisBoot)).toEqual({
      state: 'failed',
      meaning: 'It was stopped before it left a result.',
    })
    // Not knowing whether the machine is stopping isn't a reason to hide a failure.
    expect(
      await ended(1, { stopping: async () => Promise.reject(new Error('no bus')) }),
    ).toMatchObject({
      state: 'failed',
    })
  })

  it('a finished run stays finished, even while the machine stops', async () => {
    const finished = await ended(0, { stopping })
    expect(finished.state).toBe('ok')
    expect(finished).not.toHaveProperty('cut')
  })

  it('records nothing: the last result stands, the job is due again, no failed row goes out', async () => {
    const store = new JobStore(':memory:')
    store.ensure('backup', 0)
    const first = store.claim('backup', { holder: 'a:1', machine: 'a' }, 0, 60_000)
    if (!first) throw new Error('no lease')
    store.complete(first, { state: 'ok', meaning: 'Backup finished.' }, 1_000, 2_000)
    const rows: string[] = []
    let lastRow: ReturnType<typeof jobRow> | undefined
    const logs: string[] = []
    const runner = new Runner({
      store,
      jobs: [job],
      machine: 'a',
      holder: 'a:1',
      act: async () => ({ state: 'ok', cut: true, meaning: 'This machine shut down.' }),
      postRows: async (batch) => {
        lastRow = batch.at(-1)
        rows.push(...batch.map((row) => `${row.id}:${row.state}`))
      },
      now: () => NOW,
      log: (line) => logs.push(line),
    })
    await runner.tick()
    await runner.idle()
    expect(store.get('backup')).toMatchObject({
      leaseId: null,
      lastState: 'ok',
      lastMeaning: 'Backup finished.',
      lastRun: 1_000,
      nextRun: NOW + 60_000,
    })
    expect(logs).toContain('backup: cut short: This machine shut down.')
    expect(rows.every((row) => !row.endsWith(':failed'))).toBe(true)
    expect(lastRow).toMatchObject({
      state: 'ok',
      meaning: 'Backup finished.',
      last_run: new Date(1_000).toISOString(),
      next_run: new Date(NOW + 60_000).toISOString(),
    })
  })
})
