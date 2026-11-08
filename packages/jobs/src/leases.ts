// jobs.db: one row per job kind with its schedule state and its lease. A runner
// takes the lease to run the job once: the claim bumps the fencing token and
// sets a fresh lease id, and every later write (renew, the result) must carry
// both. A holder whose lease expired and was taken over writes nothing: its
// renew answers false and its result throws StaleLease.

import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { type Database, openDatabase, transaction } from '@aico/store'

const MIGRATIONS = [
  `CREATE TABLE jobs (
     kind TEXT PRIMARY KEY,
     next_run INTEGER NOT NULL,
     fence INTEGER NOT NULL DEFAULT 0,
     lease_id TEXT,
     holder TEXT,
     holder_machine TEXT,
     lease_expires INTEGER,
     last_run INTEGER,
     last_state TEXT,
     last_meaning TEXT,
     last_machine TEXT
   ) STRICT`,
  // Pause, Run now while paused, and the routines other projects register (data, not jobs.json).
  `ALTER TABLE jobs ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE jobs ADD COLUMN run_now INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE routines (
     kind TEXT PRIMARY KEY,
     project TEXT NOT NULL,
     what TEXT NOT NULL,
     host TEXT NOT NULL,
     at TEXT,
     every_min INTEGER,
     command TEXT,
     post TEXT,
     cwd TEXT,
     scope TEXT NOT NULL DEFAULT 'user',
     lease_s INTEGER NOT NULL,
     created_at INTEGER NOT NULL
   ) STRICT`,
  // Runs on either host: the lease authority and the machines that may take it over.
  `ALTER TABLE routines ADD COLUMN lease_host TEXT;
   ALTER TABLE routines ADD COLUMN workers TEXT`,
  // The zone a routine's `at` is read in (the registering machine's).
  `ALTER TABLE routines ADD COLUMN tz TEXT`,
  // The day a timed routine runs on (weekly, nth weekday of the month, day of the month).
  `ALTER TABLE routines ADD COLUMN on_day TEXT`,
  // The completed execution's identity, independent of the lease a restarted scheduler adopts.
  `ALTER TABLE jobs ADD COLUMN last_run_id TEXT`,
]

export function jobsDbPath(dataDir: string): string {
  return join(dataDir, 'jobs.db')
}

export interface JobState {
  kind: string
  nextRun: number
  fence: number
  leaseId: string | null
  holder: string | null
  holderMachine: string | null
  leaseExpires: number | null
  lastRun: number | null
  /** Absent on old peers; only an identified completed execution can correct its writers' deadlines. */
  lastRunId?: string | null
  lastState: string | null
  lastMeaning: string | null
  lastMachine: string | null
  /** Scheduled runs are off; Run now still runs it once. */
  paused: boolean
  /** Run now was asked and not yet started. */
  runNow: boolean
}

export interface Lease {
  kind: string
  leaseId: string
  fence: number
  holder: string
  machine: string
}

export interface JobResult {
  state: 'ok' | 'warn' | 'failed'
  meaning: string
  /** Another run of this job holds its lock: nothing ran here, so nothing is recorded or alerted. */
  busy?: true
  /** This machine shut down during the run: it says nothing about the job, so nothing is recorded or alerted. */
  cut?: true
  /** The original unit's execution id, retained when another scheduler adopts that unit. */
  runId?: string
}

/** A routine another project registered: the data behind one job (routines table). */
export interface Routine {
  kind: string
  project: string
  what: string
  /** The machine that runs it; registered on that machine. */
  host: string
  at?: string
  /** With `at`: mon, 1st-sat, day-15 (see JobDef.on). */
  on?: string
  every_min?: number
  command?: string[]
  /** A path on aico-web to POST to, as jobs.json's run.post. */
  post?: string
  /** Where a command runs; default the scheduler's. */
  cwd?: string
  /** The one machine that holds the lease (default: host). */
  lease_host?: string
  /** Machines that may run it, host first; the others take over after lease_s (default: host only). */
  workers?: string[]
  /** IANA zone `at` is read in; absent on routines registered before zones were stored. */
  tz?: string
  /** user: a systemd user unit; system: a system unit (root). */
  scope: 'user' | 'system'
  lease_s: number
  created_at: number
}

/** A write by a holder that no longer holds the lease (expired and taken over). */
export class StaleLease extends Error {
  constructor(lease: Lease) {
    super(`${lease.kind}: lease ${lease.fence} is no longer held by ${lease.holder}`)
    this.name = 'StaleLease'
  }
}

/** The lease authority did not answer at all (no socket, connection refused or dropped), as
 * opposed to answering with a refusal. Only this lets a fallback worker stand in. */
export class Unreachable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Unreachable'
  }
}

type Raw = Record<string, string | number | null>

function state(row: Raw): JobState {
  return {
    kind: row.kind as string,
    nextRun: row.next_run as number,
    fence: row.fence as number,
    leaseId: row.lease_id as string | null,
    holder: row.holder as string | null,
    holderMachine: row.holder_machine as string | null,
    leaseExpires: row.lease_expires as number | null,
    lastRun: row.last_run as number | null,
    lastRunId: row.last_run_id as string | null,
    lastState: row.last_state as string | null,
    lastMeaning: row.last_meaning as string | null,
    lastMachine: row.last_machine as string | null,
    paused: row.paused === 1,
    runNow: row.run_now === 1,
  }
}

export class JobStore {
  private readonly db: Database

  constructor(path: string) {
    this.db = openDatabase(path, MIGRATIONS)
  }

  /** Adds a kind not seen before, first due at `firstRun`; a known kind is left alone. */
  ensure(kind: string, firstRun: number): void {
    this.db
      .prepare('INSERT INTO jobs (kind, next_run) VALUES (?, ?) ON CONFLICT (kind) DO NOTHING')
      .run(kind, firstRun)
  }

  get(kind: string): JobState | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE kind = ?').get(kind) as Raw | undefined
    return row ? state(row) : null
  }

  all(): JobState[] {
    return (this.db.prepare('SELECT * FROM jobs ORDER BY kind').all() as Raw[]).map(state)
  }

  /**
   * Takes the lease when the job is at least `delayMs` past due and nobody holds an unexpired
   * lease: the fencing token goes up by one and the lease id is new. Null when not taken.
   */
  claim(
    kind: string,
    who: { holder: string; machine: string },
    now: number,
    ttlMs: number,
    delayMs = 0,
  ): Lease | null {
    return transaction(this.db, () => {
      const job = this.get(kind)
      if (!job || now < job.nextRun + delayMs) return null
      if (job.paused && !job.runNow) return null
      if (job.leaseId && (job.leaseExpires ?? 0) > now) return null
      const lease: Lease = {
        kind,
        leaseId: randomBytes(8).toString('hex'),
        fence: job.fence + 1,
        holder: who.holder,
        machine: who.machine,
      }
      this.db
        .prepare(
          `UPDATE jobs SET fence = ?, lease_id = ?, holder = ?, holder_machine = ?, lease_expires = ?
           WHERE kind = ? AND fence = ?`,
        )
        .run(lease.fence, lease.leaseId, lease.holder, lease.machine, now + ttlMs, kind, job.fence)
      return lease
    })
  }

  /** Extends a held lease; false when it is no longer this holder's. */
  renew(lease: Lease, now: number, ttlMs: number): boolean {
    return (
      this.db
        .prepare('UPDATE jobs SET lease_expires = ? WHERE kind = ? AND lease_id = ? AND fence = ?')
        .run(now + ttlMs, lease.kind, lease.leaseId, lease.fence).changes > 0
    )
  }

  /** Records the run and the next due time and frees the lease; StaleLease when not held. */
  complete(lease: Lease, result: JobResult, ranAt: number, nextRun: number): void {
    const changes = this.db
      .prepare(
        `UPDATE jobs SET next_run = ?, last_run = ?, last_run_id = ?, last_state = ?, last_meaning = ?,
           last_machine = ?, lease_id = NULL, holder = NULL, holder_machine = NULL,
           lease_expires = NULL, run_now = 0
         WHERE kind = ? AND lease_id = ? AND fence = ?`,
      )
      .run(
        nextRun,
        ranAt,
        result.runId ?? null,
        result.state,
        result.meaning,
        lease.machine,
        lease.kind,
        lease.leaseId,
        lease.fence,
      ).changes
    if (changes === 0) throw new StaleLease(lease)
  }

  /**
   * Records a run another machine made while this one could not be reached, when it covers the
   * pending due time (it started at or after it) and no live lease is held here: the fence goes up,
   * so a lease from before is refused. False when this machine ran it itself or someone holds it.
   */
  record(
    kind: string,
    result: JobResult,
    ranAt: number,
    machine: string,
    nextRun: number,
    now: number,
  ): boolean {
    return (
      this.db
        .prepare(
          `UPDATE jobs SET fence = fence + 1, next_run = ?, last_run = ?, last_run_id = ?, last_state = ?,
             last_meaning = ?, last_machine = ?, lease_id = NULL, holder = NULL,
             holder_machine = NULL, lease_expires = NULL, run_now = 0
           WHERE kind = ? AND next_run <= ? AND run_now = 0
             AND (lease_id IS NULL OR lease_expires <= ?)`,
        )
        .run(
          nextRun,
          ranAt,
          result.runId ?? null,
          result.state,
          result.meaning,
          machine,
          kind,
          ranAt,
          now,
        ).changes > 0
    )
  }

  /** Keeps this machine's copy of when a job held elsewhere is due and whether it is paused,
   * so it can stand in while that machine is down. Its own lease and results are left alone. */
  follow(kind: string, nextRun: number, paused: boolean, now: number): void {
    // A lease of its own that ran out (its run died with a restart) is dropped, fence raised.
    this.db
      .prepare(
        `INSERT INTO jobs (kind, next_run, paused) VALUES (?, ?, ?)
         ON CONFLICT (kind) DO UPDATE SET next_run = excluded.next_run, paused = excluded.paused,
           fence = fence + (lease_id IS NOT NULL), lease_id = NULL, holder = NULL,
           holder_machine = NULL, lease_expires = NULL
         WHERE lease_id IS NULL OR lease_expires <= ?`,
      )
      .run(kind, nextRun, paused ? 1 : 0, now)
  }

  /**
   * Takes over a lease its own machine's earlier process left behind (the scheduler restarted
   * while the run lived on): new fence and lease id for the new holder, so the old holder, if it
   * ever came back, is refused. Null when no lease is held, or it is held by `who` already or by
   * another machine.
   */
  adopt(
    kind: string,
    who: { holder: string; machine: string },
    now: number,
    ttlMs: number,
  ): Lease | null {
    return transaction(this.db, () => {
      const job = this.get(kind)
      if (!job?.leaseId || job.holderMachine !== who.machine || job.holder === who.holder)
        return null
      const lease: Lease = {
        kind,
        leaseId: randomBytes(8).toString('hex'),
        fence: job.fence + 1,
        holder: who.holder,
        machine: who.machine,
      }
      this.db
        .prepare(
          `UPDATE jobs SET fence = ?, lease_id = ?, holder = ?, lease_expires = ?
           WHERE kind = ? AND fence = ?`,
        )
        .run(lease.fence, lease.leaseId, lease.holder, now + ttlMs, kind, job.fence)
      return lease
    })
  }

  /** Frees the lease without recording a run (busy, or cut short by shutdown): the job is due
   * again at `retryAt` and its last result stays as it was. StaleLease when not held. */
  release(lease: Lease, retryAt: number): void {
    const changes = this.db
      .prepare(
        `UPDATE jobs SET next_run = ?, lease_id = NULL, holder = NULL, holder_machine = NULL,
           lease_expires = NULL, run_now = 0
         WHERE kind = ? AND lease_id = ? AND fence = ?`,
      )
      .run(retryAt, lease.kind, lease.leaseId, lease.fence).changes
    if (changes === 0) throw new StaleLease(lease)
  }

  /** Makes the job due now (its home machine runs it at its next tick). */
  runNow(kind: string, now: number): boolean {
    return (
      this.db.prepare('UPDATE jobs SET next_run = ?, run_now = 1 WHERE kind = ?').run(now, kind)
        .changes > 0
    )
  }

  /** Pauses the job's scheduled runs, or resumes them with the next due time `resumeAt`. */
  setPaused(kind: string, paused: boolean, resumeAt: number): boolean {
    return (
      this.db
        .prepare(
          paused
            ? 'UPDATE jobs SET paused = 1 WHERE kind = ?'
            : 'UPDATE jobs SET paused = 0, run_now = 0, next_run = ? WHERE kind = ?',
        )
        .run(...(paused ? [kind] : [resumeAt, kind])).changes > 0
    )
  }

  /** Forgets a job's state (its routine was removed). */
  forget(kind: string): void {
    this.db.prepare('DELETE FROM jobs WHERE kind = ?').run(kind)
  }

  addRoutine(routine: Routine): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO routines (kind, project, what, host, at, every_min, command, post, cwd, scope, lease_s, created_at, lease_host, workers, tz, on_day)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        routine.kind,
        routine.project,
        routine.what,
        routine.host,
        routine.at ?? null,
        routine.every_min ?? null,
        routine.command ? JSON.stringify(routine.command) : null,
        routine.post ?? null,
        routine.cwd ?? null,
        routine.scope,
        routine.lease_s,
        routine.created_at,
        routine.lease_host ?? null,
        routine.workers ? JSON.stringify(routine.workers) : null,
        routine.tz ?? null,
        routine.on ?? null,
      )
  }

  /** True when a routine of this kind was registered and is now gone. */
  removeRoutine(kind: string): boolean {
    const removed = this.db.prepare('DELETE FROM routines WHERE kind = ?').run(kind).changes > 0
    if (removed) this.forget(kind)
    return removed
  }

  routines(): Routine[] {
    return (this.db.prepare('SELECT * FROM routines ORDER BY kind').all() as Raw[]).map((row) => ({
      kind: row.kind as string,
      project: row.project as string,
      what: row.what as string,
      host: row.host as string,
      ...(row.at !== null ? { at: row.at as string } : {}),
      ...(row.every_min !== null ? { every_min: row.every_min as number } : {}),
      ...(row.command !== null ? { command: JSON.parse(row.command as string) as string[] } : {}),
      ...(row.post !== null ? { post: row.post as string } : {}),
      ...(row.cwd !== null ? { cwd: row.cwd as string } : {}),
      ...(row.lease_host !== null ? { lease_host: row.lease_host as string } : {}),
      ...(row.workers !== null ? { workers: JSON.parse(row.workers as string) as string[] } : {}),
      ...(row.tz !== null ? { tz: row.tz as string } : {}),
      ...(row.on_day !== null ? { on: row.on_day as string } : {}),
      scope: row.scope as Routine['scope'],
      lease_s: row.lease_s as number,
      created_at: row.created_at as number,
    }))
  }

  close(): void {
    this.db.close()
  }
}
