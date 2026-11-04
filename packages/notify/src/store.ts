// notify.db: the notice log, the outbox (one row per notice and phone), and
// which Tether ask stands for which notice or failing Status row. This package
// owns the file (package.json aico.db); others go through aico-web.

import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { type Database, openDatabase, transaction } from '@aico/store'
import type { Notice } from './notice'

const MIGRATIONS = [
  `CREATE TABLE notices (
     id TEXT PRIMARY KEY,
     received_at INTEGER NOT NULL,
     via TEXT NOT NULL,
     source TEXT NOT NULL,
     key TEXT,
     doc TEXT NOT NULL,
     repeats INTEGER NOT NULL DEFAULT 0,
     repeated_at INTEGER,
     ask_id TEXT UNIQUE,
     answer TEXT,
     answered_at INTEGER,
     outcome TEXT
   ) STRICT;
   CREATE INDEX notices_by_key ON notices (source, key, received_at);
   CREATE TABLE outbox (
     id INTEGER PRIMARY KEY,
     notice_id TEXT NOT NULL REFERENCES notices (id),
     device TEXT NOT NULL,
     state TEXT NOT NULL CHECK (state IN ('pending', 'sending', 'sent', 'failed', 'unsure')),
     attempts INTEGER NOT NULL DEFAULT 0,
     next_at INTEGER NOT NULL,
     result TEXT,
     updated_at INTEGER NOT NULL,
     UNIQUE (notice_id, device)
   ) STRICT;
   CREATE INDEX outbox_due ON outbox (state, next_at);
   CREATE TABLE row_asks (
     row_id TEXT PRIMARY KEY,
     ask_id TEXT NOT NULL,
     raised_at INTEGER NOT NULL
   ) STRICT`,
  // What the owner has read on the desktop: a notice marked read (or its ask), and the time of the
  // last Mark all read. The tray counts only what is neither.
  `CREATE TABLE notice_reads (
     notice_id TEXT PRIMARY KEY,
     read_at INTEGER NOT NULL,
     via TEXT NOT NULL
   ) STRICT;
   CREATE TABLE marks (
     name TEXT PRIMARY KEY,
     at INTEGER NOT NULL
   ) STRICT`,
]

/** A read mark is kept this long: the tray looks back a week. */
const READ_KEPT_MS = 30 * 86_400_000

/** The notify DB file in a data directory. */
export function notifyDbPath(dataDir: string): string {
  return join(dataDir, 'notify.db')
}

/** Where a notice came from: a program on this machine, or the OmniNull hub. */
export type Via = 'local' | 'ominull'

export interface StoredNotice {
  id: string
  receivedAt: number
  via: Via
  notice: Notice
  repeats: number
  askId: string | null
  answer: string | null
  outcome: string | null
  /** Each phone's delivery: state and the last result. */
  deliveries: { device: string; state: OutboxState; attempts: number; result: string | null }[]
}

export type OutboxState = 'pending' | 'sending' | 'sent' | 'failed' | 'unsure'

/** The outbox row of a notice for the phones, queued while the paired-phones file could not be read. */
export const ANY_PHONE = '*'

export interface OutboxRow {
  id: number
  noticeId: string
  device: string
  attempts: number
  receivedAt: number
}

export interface Accepted {
  id: string
  /** A repeat of an open key inside its cooldown: logged, not sent again. */
  repeat: boolean
}

interface NoticeRow {
  id: string
  received_at: number
  via: Via
  doc: string
  repeats: number
  ask_id: string | null
  answer: string | null
  outcome: string | null
}

export class NotifyStore {
  private readonly db: Database

  constructor(path: string) {
    this.db = openDatabase(path, MIGRATIONS)
  }

  /**
   * Logs a notice and queues it for each phone in `devices` (none for a desktop-only notice).
   * A notice whose key the same source sent within its cooldown is a repeat: counted on the first
   * one and never queued again, so a sender that retries until accepted sends once. An `ok` is
   * never a repeat: a recovery is news, and it is what ends the earlier notice for the tray.
   */
  accept(notice: Notice, via: Via, devices: readonly string[], now: number): Accepted {
    return transaction(this.db, () => {
      if (notice.key && notice.severity !== 'ok') {
        const earlier = this.db
          .prepare(
            `SELECT id FROM notices WHERE source = ? AND key = ? AND received_at > ?
             ORDER BY received_at DESC LIMIT 1`,
          )
          .get(notice.source, notice.key, now - notice.cooldown * 1000) as
          | { id: string }
          | undefined
        if (earlier) {
          this.db
            .prepare('UPDATE notices SET repeats = repeats + 1, repeated_at = ? WHERE id = ?')
            .run(now, earlier.id)
          return { id: earlier.id, repeat: true }
        }
      }
      const id = randomBytes(6).toString('hex')
      this.db
        .prepare(
          'INSERT INTO notices (id, received_at, via, source, key, doc) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(id, now, via, notice.source, notice.key ?? null, JSON.stringify(notice))
      const queue = this.db.prepare(
        `INSERT INTO outbox (notice_id, device, state, next_at, updated_at)
         VALUES (?, ?, 'pending', ?, ?)`,
      )
      for (const device of new Set(devices)) queue.run(id, device, now, now)
      return { id, repeat: false }
    })
  }

  get(id: string): StoredNotice | null {
    const row = this.db.prepare('SELECT * FROM notices WHERE id = ?').get(id) as
      | NoticeRow
      | undefined
    return row ? this.present(row) : null
  }

  /** The newest notices first. */
  list(limit = 50): StoredNotice[] {
    const rows = this.db
      .prepare('SELECT * FROM notices ORDER BY received_at DESC, id LIMIT ?')
      .all(limit) as unknown as NoticeRow[]
    return rows.map((row) => this.present(row))
  }

  private present(row: NoticeRow): StoredNotice {
    const deliveries = this.db
      .prepare(
        'SELECT device, state, attempts, result FROM outbox WHERE notice_id = ? ORDER BY device',
      )
      .all(row.id) as unknown as StoredNotice['deliveries']
    return {
      id: row.id,
      receivedAt: row.received_at,
      via: row.via,
      notice: JSON.parse(row.doc) as Notice,
      repeats: row.repeats,
      askId: row.ask_id,
      answer: row.answer,
      outcome: row.outcome,
      deliveries: deliveries.map((d) => ({ ...d })),
    }
  }

  // -- the outbox -------------------------------------------------------------------

  /**
   * Takes the due rows for one sender in one write: each turns `sending`, so no other pass (in
   * this process or another) sends it too.
   */
  claimDue(now: number, limit = 20): OutboxRow[] {
    return transaction(this.db, () => {
      const rows = this.db
        .prepare(
          `SELECT o.id, o.notice_id, o.device, o.attempts, n.received_at FROM outbox o
           JOIN notices n ON n.id = o.notice_id
           WHERE o.state = 'pending' AND o.next_at <= ? ORDER BY o.next_at, o.id LIMIT ?`,
        )
        .all(now, limit) as {
        id: number
        notice_id: string
        device: string
        attempts: number
        received_at: number
      }[]
      const take = this.db.prepare(
        "UPDATE outbox SET state = 'sending', updated_at = ? WHERE id = ? AND state = 'pending'",
      )
      return rows
        .filter((row) => take.run(now, row.id).changes === 1)
        .map((row) => ({
          id: row.id,
          noticeId: row.notice_id,
          device: row.device,
          attempts: row.attempts,
          receivedAt: row.received_at,
        }))
    })
  }

  /**
   * Replaces a claimed ANY_PHONE row by one pending row per phone now that the phones are known
   * (none when no phone is paired).
   */
  expand(id: number, devices: readonly string[], now: number): void {
    transaction(this.db, () => {
      const row = this.db
        .prepare("SELECT notice_id FROM outbox WHERE id = ? AND state = 'sending'")
        .get(id) as { notice_id: string } | undefined
      if (!row) return
      this.db.prepare('DELETE FROM outbox WHERE id = ?').run(id)
      const queue = this.db.prepare(
        `INSERT OR IGNORE INTO outbox (notice_id, device, state, next_at, updated_at)
         VALUES (?, ?, 'pending', ?, ?)`,
      )
      for (const device of new Set(devices)) queue.run(row.notice_id, device, now, now)
    })
  }

  /**
   * A claimed row's outcome: sent, failed for good, unsure (it may have gone out, so it is never
   * sent again), or pending again at `retryAt`.
   */
  finish(
    id: number,
    outcome:
      | { state: 'sent' | 'failed' | 'unsure'; result: string }
      | { retryAt: number; result: string },
    now: number,
  ): void {
    if ('retryAt' in outcome)
      this.db
        .prepare(
          `UPDATE outbox SET state = 'pending', attempts = attempts + 1, next_at = ?, result = ?,
           updated_at = ? WHERE id = ? AND state = 'sending'`,
        )
        .run(outcome.retryAt, outcome.result, now, id)
    else
      this.db
        .prepare(
          `UPDATE outbox SET state = ?, attempts = attempts + 1, result = ?, updated_at = ?
           WHERE id = ? AND state = 'sending'`,
        )
        .run(outcome.state, outcome.result, now, id)
  }

  /**
   * Rows left `sending` by a process that stopped mid-send: FCM may have taken them, so they turn
   * `unsure` and are never sent again (a notice goes out at most once). Run before the first pass.
   */
  markUnsure(now: number): number {
    return Number(
      this.db
        .prepare(
          `UPDATE outbox SET state = 'unsure', result = 'stopped mid-send', updated_at = ?
           WHERE state = 'sending'`,
        )
        .run(now).changes,
    )
  }

  /** What the outbox did since `since`, for its Status row. */
  outboxSummary(since: number): {
    sent: number
    failed: number
    unsure: number
    pending: number
    oldestPendingAt: number | null
    lastProblem: string | null
  } {
    const count = (sql: string, ...args: number[]) =>
      Number((this.db.prepare(sql).get(...args) as { n: number }).n)
    const pending = this.db
      .prepare(
        `SELECT COUNT(*) AS n, MIN(n.received_at) AS oldest FROM outbox o
         JOIN notices n ON n.id = o.notice_id WHERE o.state IN ('pending', 'sending')`,
      )
      .get() as { n: number; oldest: number | null }
    const problem = this.db
      .prepare(
        `SELECT result FROM outbox WHERE result IS NOT NULL AND state != 'sent' AND updated_at >= ?
         ORDER BY updated_at DESC, id DESC LIMIT 1`,
      )
      .get(since) as { result: string } | undefined
    return {
      sent: count(
        `SELECT COUNT(*) AS n FROM outbox WHERE state = 'sent' AND updated_at >= ?`,
        since,
      ),
      failed: count(
        `SELECT COUNT(*) AS n FROM outbox WHERE state = 'failed' AND updated_at >= ?`,
        since,
      ),
      unsure: count(
        `SELECT COUNT(*) AS n FROM outbox WHERE state = 'unsure' AND updated_at >= ?`,
        since,
      ),
      pending: Number(pending.n),
      oldestPendingAt: pending.oldest === null ? null : Number(pending.oldest),
      lastProblem: problem?.result ?? null,
    }
  }

  // -- Needs you --------------------------------------------------------------------

  setAsk(noticeId: string, askId: string): void {
    this.db.prepare('UPDATE notices SET ask_id = ? WHERE id = ?').run(askId, noticeId)
  }

  byAsk(askId: string): StoredNotice | null {
    const row = this.db.prepare('SELECT * FROM notices WHERE ask_id = ?').get(askId) as
      | NoticeRow
      | undefined
    return row ? this.present(row) : null
  }

  /** Records the owner's answer once; false when it was already recorded. */
  answer(noticeId: string, answer: string, now: number): boolean {
    return (
      this.db
        .prepare('UPDATE notices SET answer = ?, answered_at = ? WHERE id = ? AND answer IS NULL')
        .run(answer, now, noticeId).changes === 1
    )
  }

  setOutcome(noticeId: string, outcome: string): void {
    this.db.prepare('UPDATE notices SET outcome = ? WHERE id = ?').run(outcome, noticeId)
  }

  rowAsk(rowId: string): string | null {
    const row = this.db.prepare('SELECT ask_id FROM row_asks WHERE row_id = ?').get(rowId) as
      | { ask_id: string }
      | undefined
    return row?.ask_id ?? null
  }

  setRowAsk(rowId: string, askId: string, now: number): void {
    this.db
      .prepare(
        `INSERT INTO row_asks (row_id, ask_id, raised_at) VALUES (?, ?, ?)
         ON CONFLICT (row_id) DO UPDATE SET ask_id = excluded.ask_id, raised_at = excluded.raised_at`,
      )
      .run(rowId, askId, now)
  }

  dropRowAsk(rowId: string): void {
    this.db.prepare('DELETE FROM row_asks WHERE row_id = ?').run(rowId)
  }

  // -- Reads --------------------------------------------------------------------------

  /** The owner read these (a notice id, or the id of an ask); the first read time stays. */
  markRead(ids: readonly string[], via: string, now: number): void {
    transaction(this.db, () => {
      const insert = this.db.prepare(
        'INSERT OR IGNORE INTO notice_reads (notice_id, read_at, via) VALUES (?, ?, ?)',
      )
      for (const id of new Set(ids)) insert.run(id, now, via)
      this.db.prepare('DELETE FROM notice_reads WHERE read_at < ?').run(now - READ_KEPT_MS)
    })
  }

  /** Mark all read: everything that came at or before `at` (epoch ms) is read. Never moves back. */
  markAllRead(at: number): void {
    this.db
      .prepare(
        `INSERT INTO marks (name, at) VALUES ('read_all', ?)
         ON CONFLICT (name) DO UPDATE SET at = MAX(at, excluded.at)`,
      )
      .run(at)
  }

  /** When each marked notice was read, and the last Mark all read (0: never). */
  readMarks(): { readAllAt: number; reads: Map<string, number> } {
    const all = this.db.prepare("SELECT at FROM marks WHERE name = 'read_all'").get() as
      | { at: number }
      | undefined
    const rows = this.db
      .prepare('SELECT notice_id, read_at FROM notice_reads')
      .all() as unknown as { notice_id: string; read_at: number }[]
    return {
      readAllAt: Number(all?.at ?? 0),
      reads: new Map(rows.map((row) => [row.notice_id, Number(row.read_at)])),
    }
  }

  /** The Tether asks that stand for failing Status rows (they show as those rows, not as questions). */
  rowAskIds(): Set<string> {
    const rows = this.db.prepare('SELECT ask_id FROM row_asks').all() as unknown as {
      ask_id: string
    }[]
    return new Set(rows.map((row) => row.ask_id))
  }

  close(): void {
    this.db.close()
  }
}
