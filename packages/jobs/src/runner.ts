// Each configured worker claims from the job’s single lease authority. The home
// worker has first chance; backups wait one lease period past the due time. A
// lost lease never kills work, but the authority refuses its late result.
// A job's fallback workers stand in on their own lease only while its lease host does not answer
// at all, and report that run when it is back; the lease host asks them before it runs a slot
// they may have covered, so a run is not repeated after either machine comes back.

import type { StatusRow } from '@aico/status'
import { type JobDef, nextRun, schedule } from './jobs'
import {
  type JobResult,
  type JobState,
  type JobStore,
  type Lease,
  StaleLease,
  Unreachable,
} from './leases'

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
  /** A fallback worker's run made while this authority was down; false when it ran here itself. */
  report?(kind: string, result: JobResult, ranAt: number): MaybePromise<boolean>
}

export type Act = (job: JobDef) => Promise<JobResult>

export interface RunnerOptions {
  store: JobStore
  authority?: (job: JobDef) => LeaseAuthority
  /** The jobs to run; a function is read at every tick, so a newly registered routine starts without a restart. */
  jobs: readonly JobDef[] | (() => readonly JobDef[])
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
  /** What a fallback worker of this job (held here) last ran on its own lease; throws
   * Unreachable when that machine does not answer. */
  standinOf?: (job: JobDef, machine: string) => Promise<JobState | null>
  /** Takes a Status row down (DELETE /api/status/rows/ID) when its routine was removed. */
  removeRow?: (id: string) => Promise<void>
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
  /** What each queued row last said (see rowSignature), so a state another machine changed is sent again. */
  private readonly announced = new Map<string, string>()
  /** Every kind this process has known (its row may be from before a restart), to take the row down when the routine is removed. */
  private readonly rowKinds = new Set<string>()
  /** Jobs held elsewhere whose lease host held a lease when last asked: not stood in for until
   * that lease would have run out. */
  private readonly heldThere = new Map<string, number>()
  private readonly told = new Set<string>()
  private readonly started: number
  private readonly now: () => number
  private readonly log: (line: string) => void

  constructor(private readonly options: RunnerOptions) {
    this.now = options.now ?? Date.now
    this.log = options.log ?? ((line) => console.log(`[jobs] ${line}`))
    this.started = this.now()
  }

  private get jobs(): readonly JobDef[] {
    const { jobs } = this.options
    return typeof jobs === 'function' ? jobs() : jobs
  }

  private get who() {
    return { holder: this.options.holder, machine: this.options.machine }
  }

  /** Adds the new kinds homed here (first due at their next scheduled time) and queues their rows. */
  start(): void {
    this.announced.clear()
    this.sync()
  }

  /**
   * Ensures every job whose lease is held here has its state, and queues its row when it is new
   * or changed. A job another machine works reports its results to this machine's lease, not to
   * this machine's Status, so the change is picked up here.
   */
  private sync(): void {
    const { store, machine } = this.options
    for (const job of this.jobs) {
      this.rowKinds.add(job.kind)
      if ((job.lease_host ?? job.home) !== machine) continue
      store.ensure(job.kind, job.every_min === undefined ? nextRun(job, this.now()) : this.now())
      const state = store.get(job.kind)
      if (state && this.announced.get(job.kind) !== rowSignature(state)) this.queueRow(job, state)
    }
  }

  /** Takes down the Status row of each routine this process wrote one for and that was removed since. */
  private async purge(): Promise<void> {
    const { removeRow } = this.options
    if (!removeRow) return
    const kinds = new Set(this.jobs.map((job) => job.kind))
    for (const kind of [...this.rowKinds]) {
      if (kinds.has(kind)) continue
      try {
        await removeRow(`jobs/${kind}`)
      } catch (error) {
        this.log(
          `could not remove the Status row of ${kind}, will retry: ${(error as Error).message}`,
        )
        continue
      }
      this.rowKinds.delete(kind)
      this.announced.delete(kind)
      this.unsent.delete(`jobs/${kind}`)
    }
  }

  /** Claims and starts what is due among the jobs homed here, then sends the rows waiting to go out. */
  async tick(): Promise<void> {
    const { store, machine } = this.options
    this.sync()
    for (const job of this.jobs) {
      if (!(job.workers ?? [job.home]).includes(machine) || this.running.has(job.kind)) continue
      const remote = this.options.authority?.(job) ?? store
      const standsIn = remote !== store && (job.fallback ?? []).includes(machine)
      let authority: LeaseAuthority = remote
      let lease: Lease | null = await this.adopt(job, standsIn)
      if (lease) authority = store
      else
        try {
          if (standsIn) await this.follow(job, remote)
          else if (remote === store && (await this.coveredElsewhere(job))) continue
          lease = await remote.claim(
            job.kind,
            this.who,
            this.now(),
            job.lease_s * 1000,
            homeFirstMs(job, machine, store.get(job.kind)?.lastMachine),
          )
        } catch (error) {
          if (!standsIn || !(error instanceof Unreachable)) {
            this.log(`${job.kind}: could not take the lease: ${(error as Error).message}`)
            continue
          }
          lease =
            (this.heldThere.get(job.kind) ?? 0) > this.now()
              ? null
              : store.claim(
                  job.kind,
                  this.who,
                  this.now(),
                  job.lease_s * 1000,
                  homeFirstMs(job, machine, store.get(job.kind)?.lastMachine),
                )
          if (!lease) continue
          authority = store
          this.log(
            `${job.kind}: ${job.lease_host} does not answer (${error.message}); running it here on this machine's own lease`,
          )
        }
      if (!lease) continue
      try {
        const state = await authority.get(job.kind)
        if (state) this.queueRow(job, state)
      } catch (error) {
        this.log(`${job.kind}: could not read its active lease: ${(error as Error).message}`)
      }
      const work = this.run(job, lease, authority).finally(() => this.running.delete(job.kind))
      this.running.set(job.kind, work)
    }
    await this.flush()
    // Last: a hung aico-web must not hold up what is due.
    await this.purge()
  }

  /**
   * A lease this machine's earlier scheduler left behind, with its run still alive or finished
   * unrecorded: take it over now rather than let it expire and start the job a second time.
   */
  private async adopt(job: JobDef, standsIn: boolean): Promise<Lease | null> {
    const { store, machine, holder, inFlight } = this.options
    if (!inFlight || ((job.lease_host ?? job.home) !== machine && !standsIn)) return null
    const state = store.get(job.kind)
    if (!state?.leaseId || state.holderMachine !== machine || state.holder === holder) return null
    if (!(await inFlight(job))) return null
    const lease = store.adopt(job.kind, this.who, this.now(), job.lease_s * 1000)
    if (lease) this.log(`${job.kind}: adopted the run ${state.holder} left (lease ${lease.fence})`)
    return lease
  }

  /**
   * A job held elsewhere that this machine may stand in for: hands over a run it made here while
   * the lease host was down (once that host answers again), then keeps the host's due time and
   * pause here. Throws Unreachable when the lease host does not answer.
   */
  private async follow(job: JobDef, remote: LeaseAuthority): Promise<void> {
    const { store, machine } = this.options
    let there = await remote.get(job.kind)
    if (!there) return
    const here = store.get(job.kind)
    if (
      here?.lastMachine === machine &&
      here.lastRun !== null &&
      here.lastState &&
      here.lastRun >= there.nextRun &&
      (there.lastRun ?? 0) < here.lastRun &&
      remote.report
    ) {
      const result = {
        state: here.lastState as JobResult['state'],
        meaning: here.lastMeaning ?? '',
      }
      if (await remote.report(job.kind, result, here.lastRun)) {
        this.log(`${job.kind}: handed the run made here to ${job.lease_host}`)
        there = (await remote.get(job.kind)) ?? there
      } else if (!this.told.has(`${job.kind}:${here.lastRun}`)) {
        this.told.add(`${job.kind}:${here.lastRun}`)
        this.log(
          `${job.kind}: ${job.lease_host} did not take the run made here; it ran or holds it there too`,
        )
      }
    }
    if (there.leaseId && there.holderMachine !== machine)
      this.heldThere.set(job.kind, there.leaseExpires ?? 0)
    else this.heldThere.delete(job.kind)
    store.follow(job.kind, there.nextRun, there.paused, this.now())
  }

  /**
   * Before this lease host runs a due slot of a job with fallback workers, asks them whether one
   * already ran it while this machine was down, and records that run instead of repeating it.
   * Just after a start it waits for an answer (the link to them may not be up yet).
   */
  private async coveredElsewhere(job: JobDef): Promise<boolean> {
    const { store, machine, standinOf } = this.options
    const others = (job.fallback ?? []).filter((name) => name !== machine)
    if (!standinOf || !others.length) return false
    const now = this.now()
    const state = store.get(job.kind)
    const delay = homeFirstMs(job, machine, state?.lastMachine)
    if (!state || state.runNow || state.paused || now < state.nextRun + delay) return false
    if (state.leaseId && (state.leaseExpires ?? 0) > now) return false
    for (const other of others) {
      let seen: JobState | null
      try {
        seen = await standinOf(job, other)
      } catch (error) {
        if (error instanceof Unreachable && now - this.started < job.lease_s * 1000) return true
        continue
      }
      // It is running the job in this machine's place right now: wait for its result.
      if (seen?.leaseId && seen.holderMachine === other && (seen.leaseExpires ?? 0) > now)
        return true
      if (
        seen?.lastMachine !== other ||
        seen.lastRun === null ||
        seen.lastRun < state.nextRun ||
        !seen.lastState
      )
        continue
      const result = {
        state: seen.lastState as JobResult['state'],
        meaning: seen.lastMeaning ?? '',
      }
      if (!store.record(job.kind, result, seen.lastRun, other, nextRun(job, now), now)) continue
      this.log(`${job.kind}: ${other} ran it while this machine was down; took its result`)
      const after = store.get(job.kind)
      if (after) this.queueRow(job, after)
      return true
    }
    return false
  }

  /** This run went through another machine's lease, for a job this machine may stand in for. */
  private standsIn(job: JobDef, authority: LeaseAuthority): boolean {
    return authority !== this.options.store && (job.fallback ?? []).includes(this.options.machine)
  }

  /** Resolves once every job started so far has finished (tests, shutdown). */
  async idle(): Promise<void> {
    await Promise.all(this.running.values())
    await this.flush()
  }

  private async run(job: JobDef, lease: Lease, store: LeaseAuthority): Promise<void> {
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
    if (result.busy || result.cut) {
      // Another run holds this job's lock, or this machine shut down under the run. Either way there is
      // no result to record or alert on: the last result stands and the job is due again.
      try {
        await store.release(lease, finishedAt + ttlMs)
        const state = await store.get(job.kind)
        if (state) this.queueRow(job, state)
      } catch (error) {
        this.log(`${job.kind}: could not release lease ${lease.fence}: ${(error as Error).message}`)
      }
      this.log(`${job.kind}: ${result.cut ? 'cut short' : 'already running'}: ${result.meaning}`)
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
      // Ran on the lease host's lease, which then stopped answering: keep the run here as a
      // stand-in, so it is handed over when the lease host is back instead of run again.
      if (error instanceof Unreachable && this.standsIn(job, store)) {
        const own = this.options.store
        const kept = own.record(
          job.kind,
          { ...result, meaning: cut(result.meaning) },
          startedAt,
          this.options.machine,
          nextRun(job, finishedAt),
          finishedAt,
        )
        this.log(
          `${job.kind}: ${job.lease_host} stopped answering; ${kept ? 'kept the result here to hand over' : 'could not keep the result here'}`,
        )
        const state = own.get(job.kind)
        if (kept && state) this.queueRow(job, state)
        return
      }
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
    // Ran on the lease host's lease: this machine's copy of the due time moves on too, so it does
    // not stand in for this slot if the lease host stops answering before the next follow.
    if (this.standsIn(job, store)) {
      const own = this.options.store
      own.follow(job.kind, nextRun(job, finishedAt), own.get(job.kind)?.paused ?? false, finishedAt)
    }
    const state = await store.get(job.kind)
    if (state) this.queueRow(job, state)
  }

  private queueRow(job: JobDef, state: JobState): void {
    const row = jobRow(job, state, this.now())
    this.unsent.set(row.id, row)
    this.rowKinds.add(job.kind)
    this.announced.set(job.kind, rowSignature(state))
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

/** What the job's Status row says, apart from the clock. */
const rowSignature = (state: JobState) =>
  [
    state.paused,
    state.lastRun,
    state.lastState,
    state.lastMeaning,
    state.lastMachine,
    state.nextRun,
    state.leaseExpires,
  ].join('|')

/**
 * How long past due a machine other than the home waits, so the home goes first. Once a stand-in
 * has run the job the home is away: waiting again would run it later than its schedule every time
 * (and show it late). The home's next run hands it back.
 */
export function homeFirstMs(job: JobDef, machine: string, lastMachine?: string | null): number {
  if (job.home === machine) return 0
  return lastMachine && lastMachine !== job.home ? 0 : job.lease_s * 1000
}

/** The job's one Status row: where and how it last ran, and when it is due next. */
export function jobRow(job: JobDef, state: JobState, now = Date.now()): StatusRow {
  const ran = state.lastRun !== null
  if (state.paused)
    return {
      id: `jobs/${job.kind}`,
      what: job.what,
      kind: 'job',
      machine: state.lastMachine ?? job.home,
      project: job.project,
      // Off, not late: a paused routine is stopped on purpose and has no next run.
      state: 'off',
      meaning: ran
        ? cut(`Paused. Last run ${state.lastState}: ${state.lastMeaning || 'Finished.'}`)
        : `Paused. ${schedule(job)} on ${job.home} once resumed.`,
      ...(ran ? { last_run: iso(state.lastRun as number) } : {}),
      actions: actionsOf(job),
    }
  return {
    id: `jobs/${job.kind}`,
    what: job.what,
    kind: 'job',
    machine: state.lastMachine ?? job.home,
    project: job.project,
    state: (state.lastState as JobResult['state'] | null) ?? 'ok',
    meaning: ran
      ? cut(
          state.lastState === 'failed' && state.leaseId && (state.leaseExpires ?? 0) > now
            ? `Retrying. Last run failed: ${state.lastMeaning || 'It failed.'}`
            : state.lastMeaning || 'Finished.',
        )
      : `Not run yet. Runs ${schedule(job)} on ${job.home}.`,
    ...(ran ? { last_run: iso(state.lastRun as number) } : {}),
    // While it runs the scheduler still holds the due time it started at, so a long run would read
    // late; it is due when its lease runs out instead (a dead worker's row goes late from there).
    // It isn't due until its stand-in's turn has passed too: the home being off is not a late run.
    next_run: iso(
      Math.max(
        state.nextRun + (job.lease_host ? homeFirstMs(job, job.lease_host, state.lastMachine) : 0),
        state.leaseExpires ?? 0,
      ),
    ),
    actions: actionsOf(job),
  }
}

const actionsOf = (job: JobDef): StatusRow['actions'] => [
  { kind: 'run', ref: `aico routines run ${job.kind}` },
  { kind: 'log', ref: `aico routines log ${job.kind}` },
]
