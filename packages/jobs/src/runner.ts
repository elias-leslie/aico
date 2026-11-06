// Each configured worker claims from the job’s single lease authority. The home
// worker has first chance; backups wait one lease period past the due time. A
// lost lease never kills work, but the authority refuses its late result.

import type { StatusRow } from '@aico/status'
import { type JobDef, nextRun, schedule } from './jobs'
import { type JobResult, type JobState, type JobStore, type Lease, StaleLease } from './leases'

type MaybePromise<T> = T | Promise<T>
export interface LeaseAuthority {
  claim(
    kind: string,
    who: { holder: string; machine: string },
    now: number,
    ttlMs: number,
    delayMs?: number,
  ): MaybePromise<Lease | null>
  renew(lease: Lease, now: number, ttlMs: number): MaybePromise<boolean>
  complete(lease: Lease, result: JobResult, ranAt: number, nextRun: number): MaybePromise<void>
  /** Frees the lease without a result (a busy run); the job is due again at `retryAt`. */
  release(lease: Lease, retryAt: number): MaybePromise<void>
  get(kind: string): MaybePromise<JobState | null>
}

export type Act = (job: JobDef) => Promise<JobResult>

export interface RunnerOptions {
  store: JobStore
  authority?: (job: JobDef) => LeaseAuthority
  jobs: readonly JobDef[]
  /** This machine's id. */
  machine: string
  /** This process, as named on the leases it holds. */
  holder: string
  act: Act
  /** Writes rows to aico-web's Status (POST /api/status/rows); throws when it cannot. */
  postRows: (rows: StatusRow[]) => Promise<void>
  /** True when a run of this job already lives outside this process (still going, or finished
   * with its result not yet recorded), so a restarted scheduler adopts it instead of starting another. */
  inFlight?: (job: JobDef) => Promise<boolean>
  /** Sends Status rows an earlier writer could not post; called every tick. */
  drain?: () => Promise<void>
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
      if ((job.lease_host ?? job.home) !== machine) continue
      store.ensure(job.kind, job.every_min === undefined ? nextRun(job, this.now()) : this.now())
      const state = store.get(job.kind)
      if (state) this.queueRow(job, state)
    }
  }

  /** Claims and starts what is due among the jobs homed here, then sends the rows waiting to go out. */
  async tick(): Promise<void> {
    const { store, jobs, machine } = this.options
    for (const job of jobs) {
      if (!(job.workers ?? [job.home]).includes(machine) || this.running.has(job.kind)) continue
      const authority = this.options.authority?.(job) ?? store
      let lease: Lease | null
      try {
        lease =
          (await this.adopt(job)) ??
          (await authority.claim(
            job.kind,
            this.who,
            this.now(),
            job.lease_s * 1000,
            job.home === machine ? 0 : job.lease_s * 1000,
          ))
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

  /**
   * A lease this machine's earlier scheduler left behind, with its run still alive or finished
   * unrecorded: take it over now rather than let it expire and start the job a second time.
   */
  private async adopt(job: JobDef): Promise<Lease | null> {
    const { store, machine, holder, inFlight } = this.options
    if (!inFlight || (job.lease_host ?? job.home) !== machine) return null
    const state = store.get(job.kind)
    if (!state?.leaseId || state.holderMachine !== machine || state.holder === holder) return null
    if (!(await inFlight(job))) return null
    const lease = store.adopt(job.kind, this.who, this.now(), job.lease_s * 1000)
    if (lease) this.log(`${job.kind}: adopted the run ${state.holder} left (lease ${lease.fence})`)
    return lease
  }

  /** Resolves once every job started so far has finished (tests, shutdown). */
  async idle(): Promise<void> {
    await Promise.all(this.running.values())
    await this.flush()
  }

  private async run(job: JobDef, lease: Lease): Promise<void> {
    const store = this.options.authority?.(job) ?? this.options.store
    const ttlMs = job.lease_s * 1000
    this.log(`${job.kind}: started on ${lease.machine} (lease ${lease.fence})`)
    let held = true
    const renewal = setInterval(async () => {
      try {
        if (await store.renew(lease, this.now(), ttlMs)) return
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
    if (result.busy) {
      // Another run holds this job's lock. Nothing ran, so there is no result to record or alert on.
      try {
        await store.release(lease, finishedAt + ttlMs)
      } catch (error) {
        this.log(`${job.kind}: could not release lease ${lease.fence}: ${(error as Error).message}`)
      }
      this.log(`${job.kind}: already running: ${result.meaning}`)
      return
    }
    try {
      await store.complete(
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
    const state = await store.get(job.kind)
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
      {
        kind: 'log',
        ref: `journalctl --user -u aico-jobs.service -g ${job.kind} -n 200 --no-pager`,
      },
    ],
  }
}
