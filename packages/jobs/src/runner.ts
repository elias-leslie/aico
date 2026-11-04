// The runner: each tick, takes the lease of every job homed on this machine
// that is due, and runs it. Jobs homed elsewhere are never run here: leases
// live in each host's own jobs.db, so this machine cannot see whether the home
// machine ran it (M11 carries leases over the fleet link). The holder renews
// every third of the lease while the work runs. Work is never stopped for
// taking long: a holder that lost its lease lets the work finish, and its
// result is refused (StaleLease). A refused result does not undo the work it
// stands for, so every job must be safe to run twice (idempotent).

import type { StatusRow } from '@aico/status'
import { type JobDef, nextRun, schedule } from './jobs'
import { type JobResult, type JobState, type JobStore, type Lease, StaleLease } from './leases'

export type Act = (job: JobDef) => Promise<JobResult>

export interface RunnerOptions {
  store: JobStore
  jobs: readonly JobDef[]
  /** This machine's id. */
  machine: string
  /** This process, as named on the leases it holds. */
  holder: string
  act: Act
  /** Writes rows to aico-web's Status (POST /api/status/rows); throws when it cannot. */
  postRows: (rows: StatusRow[]) => Promise<void>
  now?: () => number
  log?: (line: string) => void
}

const MEANING_MAX = 300
const cut = (text: string) =>
  text.length <= MEANING_MAX ? text : `${text.slice(0, MEANING_MAX - 1)}…`
const iso = (ms: number) => new Date(ms).toISOString()

export class Runner {
  private readonly running = new Map<string, Promise<void>>()
  private readonly unsent = new Map<string, StatusRow>()
  private readonly now: () => number
  private readonly log: (line: string) => void

  constructor(private readonly options: RunnerOptions) {
    this.now = options.now ?? Date.now
    this.log = options.log ?? ((line) => console.log(`[jobs] ${line}`))
  }

  private get who() {
    return { holder: this.options.holder, machine: this.options.machine }
  }

  /** Adds the new kinds homed here (first due at their next scheduled time) and queues their rows. */
  start(): void {
    const { store, jobs, machine } = this.options
    for (const job of jobs) {
      if (job.home !== machine) continue
      store.ensure(job.kind, job.every_min === undefined ? nextRun(job, this.now()) : this.now())
      const state = store.get(job.kind)
      if (state) this.queueRow(job, state)
    }
  }

  /** Claims and starts what is due among the jobs homed here, then sends the rows waiting to go out. */
  async tick(): Promise<void> {
    const { store, jobs, machine } = this.options
    for (const job of jobs) {
      if (job.home !== machine || this.running.has(job.kind)) continue
      let lease: Lease | null
      try {
        lease = store.claim(job.kind, this.who, this.now(), job.lease_s * 1000)
      } catch (error) {
        this.log(`${job.kind}: could not take the lease: ${(error as Error).message}`)
        continue
      }
      if (!lease) continue
      const work = this.run(job, lease).finally(() => this.running.delete(job.kind))
      this.running.set(job.kind, work)
    }
    await this.flush()
  }

  /** Resolves once every job started so far has finished (tests, shutdown). */
  async idle(): Promise<void> {
    await Promise.all(this.running.values())
    await this.flush()
  }

  private async run(job: JobDef, lease: Lease): Promise<void> {
    const { store } = this.options
    const ttlMs = job.lease_s * 1000
    this.log(`${job.kind}: started on ${lease.machine} (lease ${lease.fence})`)
    let held = true
    const renewal = setInterval(() => {
      try {
        if (store.renew(lease, this.now(), ttlMs)) return
      } catch (error) {
        // A failed write is not a lost lease: try again at the next renewal.
        this.log(`${job.kind}: could not renew lease ${lease.fence}: ${(error as Error).message}`)
        return
      }
      held = false
      clearInterval(renewal)
      this.log(
        `${job.kind}: lost lease ${lease.fence}; letting the work finish, its result will be refused`,
      )
    }, ttlMs / 3)
    renewal.unref()
    const startedAt = this.now()
    let result: JobResult
    try {
      result = await this.options.act(job)
    } catch (error) {
      result = { state: 'failed', meaning: `It stopped: ${(error as Error).message}` }
    } finally {
      clearInterval(renewal)
    }
    const finishedAt = this.now()
    try {
      store.complete(
        lease,
        { ...result, meaning: cut(result.meaning) },
        startedAt,
        nextRun(job, finishedAt),
      )
    } catch (error) {
      // The work is done either way; a refused result does not undo it (jobs are idempotent).
      if (error instanceof StaleLease)
        this.log(`${job.kind}: result refused: ${error.message}${held ? '' : ' (lease was lost)'}`)
      else
        this.log(
          `${job.kind}: could not record its result (${result.state}: ${result.meaning}): ${(error as Error).message}`,
        )
      return
    }
    this.log(`${job.kind}: ${result.state}: ${result.meaning}`)
    const state = store.get(job.kind)
    if (state) this.queueRow(job, state)
  }

  private queueRow(job: JobDef, state: JobState): void {
    const row = jobRow(job, state)
    this.unsent.set(row.id, row)
  }

  private async flush(): Promise<void> {
    if (this.unsent.size === 0) return
    const rows = [...this.unsent.values()]
    try {
      await this.options.postRows(rows)
      for (const row of rows) if (this.unsent.get(row.id) === row) this.unsent.delete(row.id)
    } catch (error) {
      this.log(
        `could not write ${rows.length} Status row(s), will retry: ${(error as Error).message}`,
      )
    }
  }
}

/** The job's one Status row: where and how it last ran, and when it is due next. */
export function jobRow(job: JobDef, state: JobState): StatusRow {
  const ran = state.lastRun !== null
  return {
    id: `jobs/${job.kind}`,
    what: job.what,
    kind: 'job',
    machine: state.lastMachine ?? job.home,
    project: job.project,
    state: (state.lastState as JobResult['state'] | null) ?? 'ok',
    meaning: ran
      ? cut(state.lastMeaning || 'Finished.')
      : `Not run yet. Runs ${schedule(job)} on ${job.home}.`,
    ...(ran ? { last_run: iso(state.lastRun as number) } : {}),
    next_run: iso(state.nextRun),
    actions: [
      { kind: 'run', ref: `aico jobs run ${job.kind}` },
      { kind: 'log', ref: `journalctl --user -u aico-jobs.service -g ${job.kind}` },
    ],
  }
}
