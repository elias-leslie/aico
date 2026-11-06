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
  lastState: string | null
  lastMeaning: string | null
  lastMachine: string | null
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
}

/** A write by a holder that no longer holds the lease (expired and taken over). */
export class StaleLease extends Error {
  constructor(lease: Lease) {
    super(`${lease.kind}: lease ${lease.fence} is no longer held by ${lease.holder}`)
    this.name = 'StaleLease'
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
    lastState: row.last_state as string | null,
    lastMeaning: row.last_meaning as string | null,
    lastMachine: row.last_machine as string | null,
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
        `UPDATE jobs SET next_run = ?, last_run = ?, last_state = ?, last_meaning = ?,
           last_machine = ?, lease_id = NULL, holder = NULL, holder_machine = NULL,
           lease_expires = NULL
         WHERE kind = ? AND lease_id = ? AND fence = ?`,
      )
      .run(
        nextRun,
        ranAt,
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

  /** Frees the lease without recording a run (another run held the job's lock): the job is due
   * again at `retryAt` and its last result stays as it was. StaleLease when not held. */
  release(lease: Lease, retryAt: number): void {
    const changes = this.db
      .prepare(
        `UPDATE jobs SET next_run = ?, lease_id = NULL, holder = NULL, holder_machine = NULL,
           lease_expires = NULL
         WHERE kind = ? AND lease_id = ? AND fence = ?`,
      )
      .run(retryAt, lease.kind, lease.leaseId, lease.fence).changes
    if (changes === 0) throw new StaleLease(lease)
  }

  /** Makes the job due now (its home machine runs it at its next tick). */
  runNow(kind: string, now: number): boolean {
    return this.db.prepare('UPDATE jobs SET next_run = ? WHERE kind = ?').run(now, kind).changes > 0
  }

  close(): void {
    this.db.close()
  }
}
