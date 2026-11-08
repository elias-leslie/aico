// notify.db: the notice log, the outbox (one row per notice and phone), and
// which Tether ask stands for which notice or failing Status row. This package
// owns the file (package.json aico.db); others go through aico-web.

import { createHash, randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
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
  // One list across every full Aico (the `notify` sync set): notices and read marks travel, and
  // notice_sends says who already sent what. The outbox and row_asks stay this machine's own. Rows
  // from before this have seq 0 and stay where they are.
  `ALTER TABLE notices ADD COLUMN sync_at INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE notices ADD COLUMN origin TEXT NOT NULL DEFAULT '';
   ALTER TABLE notices ADD COLUMN prev INTEGER;
   ALTER TABLE notices ADD COLUMN prev_origin TEXT;
   ALTER TABLE notices ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE notices ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
   CREATE INDEX notices_seq ON notices (seq);
   ALTER TABLE notice_reads ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
   CREATE INDEX notice_reads_seq ON notice_reads (seq);
   ALTER TABLE marks ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
   CREATE INDEX marks_seq ON marks (seq);
   CREATE TABLE notice_sends (
     notice_id TEXT PRIMARY KEY,
     state TEXT NOT NULL,
     at INTEGER NOT NULL,
     sent_by TEXT NOT NULL,
     seq INTEGER NOT NULL DEFAULT 0
   ) STRICT;
   CREATE INDEX notice_sends_seq ON notice_sends (seq);
   CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT`,
]

/** The notify set's version: two Aicos sync it only when they agree. */
export const NOTIFY_SCHEMA_VERSION = MIGRATIONS.length

/** A notice that arrived from another Aico waits this long, so word that it was sent can catch up. */
export const SYNC_SETTLE_MS = 5000
/** A notice older than this never starts its way to the phone here: the outbox would give it up. */
const QUEUE_KEPT_MS = 24 * 3600_000
const EVENT_BUCKET_MS = 60_000

/**
 * A notice's id, the same on every Aico for the same event: its source and key (a keyed notice), or
 * its words (one without), in the same minute. Two Aicos that raise one event make one row, not two.
 */
export function eventId(notice: Notice, now: number, salt = ''): string {
  const what = notice.key
    ? [notice.source, notice.key, notice.severity === 'ok' ? 'ok' : 'open', salt]
    : [notice.source, notice.title, notice.body]
  return createHash('sha256')
    .update([...what, Math.floor(now / EVENT_BUCKET_MS)].join('\0'))
    .digest('hex')
    .slice(0, 12)
}

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

/** The file as the sync engine needs it (web-server's SyncHandle, less what names the set). */
export interface NotifySyncParts {
  hostName: string
  db: Database
  now(): number
  meta(key: string): string | null
  setMeta(key: string, value: string): void
  transaction<T>(work: () => T): T
  stamp(): { at: number; origin: string; seq: number }
  observe(at: number): void
}

export class NotifyStore {
  private readonly db: Database
  private readonly hostName: string

  /** `hostName`: this Aico's name on what it writes (AICO_HOST_NAME). */
  constructor(path: string, options: { hostName?: string } = {}) {
    this.db = openDatabase(path, MIGRATIONS)
    this.hostName = options.hostName ?? hostname().toLowerCase()
    if (this.meta('db_id') === null) this.setMeta('db_id', randomUUID())
    if (this.meta('seq') === null) this.setMeta('seq', '0')
  }

  // -- Sync plumbing ------------------------------------------------------------------

  private meta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value ?? null
  }

  private setMeta(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value)
  }

  /** One transaction; a call made inside another joins it. */
  private tx<T>(work: () => T): T {
    return this.db.isTransaction ? work() : transaction(this.db, work)
  }

  /** The next change number and clock value for one write (never behind a peer's). */
  private stamp(): { at: number; origin: string; seq: number } {
    const seq = Number(this.meta('seq') ?? 0) + 1
    const at = Math.max(Date.now(), Number(this.meta('hlc_last') ?? 0) + 1)
    this.setMeta('seq', String(seq))
    this.setMeta('hlc_last', String(at))
    return { at, origin: this.hostName, seq }
  }

  /** A change to a notice in the list; one from before the list synced stays this machine's. */
  private touch(id: string): void {
    const row = this.db
      .prepare('SELECT sync_at, origin, prev, prev_origin, seq FROM notices WHERE id = ?')
      .get(id) as
      | {
          sync_at: number
          origin: string
          prev: number | null
          prev_origin: string | null
          seq: number
        }
      | undefined
    if (!row || Number(row.seq) === 0) return
    // Built on another Aico's version, or carrying our own edit's base forward (engine's baseOf).
    const base =
      row.origin !== this.hostName
        ? { prev: Number(row.sync_at), prev_origin: row.origin }
        : { prev: row.prev, prev_origin: row.prev_origin }
    const stamp = this.stamp()
    this.db
      .prepare(
        'UPDATE notices SET sync_at = ?, origin = ?, prev = ?, prev_origin = ?, seq = ? WHERE id = ?',
      )
      .run(stamp.at, stamp.origin, base.prev, base.prev_origin, stamp.seq, id)
  }

  syncParts(): NotifySyncParts {
    return {
      hostName: this.hostName,
      db: this.db,
      now: () => Date.now(),
      meta: (key) => this.meta(key),
      setMeta: (key, value) => this.setMeta(key, value),
      transaction: (work) => this.tx(work),
      stamp: () => this.stamp(),
      observe: (at) => {
        if (at > Number(this.meta('hlc_last') ?? 0)) this.setMeta('hlc_last', String(at))
      },
    }
  }

  /**
   * Rows that came from another Aico (inside the sync's transaction). A notice headed for the phone
   * and sent by nobody yet gets its outbox rows here: whichever Aico is the sender then sends it, and
   * the others hold it until word comes that it went. Word that it went, or that it no longer goes
   * to the phone, drops the rows still waiting. The true return: rows were queued.
   */
  takeSynced(
    touched: readonly { table: string; id: string }[],
    devices: readonly string[],
    now: number,
  ): boolean {
    let queued = false
    const ids = new Set(touched.map((row) => row.id))
    for (const id of ids) {
      const row = this.db
        .prepare('SELECT received_at, source, key, doc FROM notices WHERE id = ?')
        .get(id) as
        | { received_at: number; source: string; key: string | null; doc: string }
        | undefined
      const drop = () =>
        this.db.prepare(`DELETE FROM outbox WHERE notice_id = ? AND state = 'pending'`).run(id)
      if (this.sentByOther(id)) {
        drop()
        continue
      }
      if (!row) continue
      const notice = JSON.parse(row.doc) as Notice
      if (notice.push !== 'phone') {
        drop()
        continue
      }
      const queuedHere = this.db
        .prepare('SELECT COUNT(*) AS n FROM outbox WHERE notice_id = ?')
        .get(id) as { n: number }
      if (
        Number(queuedHere.n) > 0 ||
        this.hasSend(id) ||
        now - Number(row.received_at) > QUEUE_KEPT_MS ||
        this.sameEventEarlier(id, row, notice)
      )
        continue
      const queue = this.db.prepare(
        `INSERT OR IGNORE INTO outbox (notice_id, device, state, next_at, updated_at)
         VALUES (?, ?, 'pending', ?, ?)`,
      )
      for (const device of new Set(devices)) queue.run(id, device, now + SYNC_SETTLE_MS, now)
      queued = devices.length > 0 || queued
    }
    return queued
  }

  private hasSend(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM notice_sends WHERE notice_id = ?').get(id)
  }

  private sentByOther(id: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM notice_sends WHERE notice_id = ? AND sent_by != ?')
      .get(id, this.hostName)
  }

  /** Two Aicos raised one keyed problem either side of a minute: only the first goes to the phone. */
  private sameEventEarlier(
    id: string,
    row: { received_at: number; source: string; key: string | null },
    notice: Notice,
  ): boolean {
    if (!row.key || notice.severity === 'ok') return false
    const earlier = this.db
      .prepare(
        `SELECT doc FROM notices WHERE source = ? AND key = ? AND id != ? AND received_at > ?
         AND (received_at < ? OR (received_at = ? AND id < ?))
         ORDER BY received_at DESC, id DESC LIMIT 1`,
      )
      .get(
        row.source,
        row.key,
        id,
        Number(row.received_at) - notice.cooldown * 1000,
        row.received_at,
        row.received_at,
        id,
      ) as { doc: string } | undefined
    return !!earlier && (JSON.parse(earlier.doc) as Notice).severity !== 'ok'
  }

  /**
   * Logs a notice and queues it for each phone in `devices` (none for a desktop-only notice).
   * A notice whose key the same source sent within its cooldown is a repeat: counted on the first
   * one and never queued again, so a sender that retries until accepted sends once. An `ok` is
   * never a repeat: a recovery is news, and it is what ends the earlier notice for the tray.
   */
  accept(notice: Notice, via: Via, devices: readonly string[], now: number): Accepted {
    return this.tx(() => {
      if (notice.key && notice.severity !== 'ok') {
        const earlier = this.db
          .prepare(
            `SELECT id, doc FROM notices WHERE source = ? AND key = ? AND received_at > ?
             ORDER BY received_at DESC, rowid DESC LIMIT 1`,
          )
          .get(notice.source, notice.key, now - notice.cooldown * 1000) as
          | { id: string; doc: string }
          | undefined
        // A problem that comes back after its recovery is news again: only a newest notice that
        // is itself still a problem makes this one a repeat.
        if (earlier && (JSON.parse(earlier.doc) as Notice).severity !== 'ok') {
          this.db
            .prepare('UPDATE notices SET repeats = repeats + 1, repeated_at = ? WHERE id = ?')
            .run(now, earlier.id)
          this.touch(earlier.id)
          return { id: earlier.id, repeat: true }
        }
      }
      let id = eventId(notice, now)
      // The same event already came in this minute (here, or from another Aico): one entry. A keyed
      // problem that gets this far is news (it came back after its recovery, or has no cooldown).
      if (this.db.prepare('SELECT 1 FROM notices WHERE id = ?').get(id)) {
        if (notice.key && notice.severity !== 'ok') id = eventId(notice, now, String(now))
      }
      if (this.db.prepare('SELECT 1 FROM notices WHERE id = ?').get(id)) {
        this.db
          .prepare('UPDATE notices SET repeats = repeats + 1, repeated_at = ? WHERE id = ?')
          .run(now, id)
        this.touch(id)
        return { id, repeat: true }
      }
      const stamp = this.stamp()
      this.db
        .prepare(
          `INSERT INTO notices (id, received_at, via, source, key, doc, sync_at, origin, seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          now,
          via,
          notice.source,
          notice.key ?? null,
          JSON.stringify(notice),
          stamp.at,
          stamp.origin,
          stamp.seq,
        )
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

  /** Notices for one sender's standing condition, newest first. */
  forKey(source: string, key: string): StoredNotice[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM notices WHERE source = ? AND key = ? ORDER BY received_at DESC, rowid DESC',
      )
      .all(source, key) as unknown as NoticeRow[]
    return rows.map((row) => this.present(row))
  }

  private present(row: NoticeRow): StoredNotice {
    const deliveries = this.db
      .prepare(
        'SELECT device, state, attempts, result FROM outbox WHERE notice_id = ? ORDER BY device',
      )
      .all(row.id) as unknown as StoredNotice['deliveries']
    // Another Aico sent it, so this one has no row of its own for it.
    const send = deliveries.length
      ? undefined
      : (this.db
          .prepare('SELECT state, sent_by FROM notice_sends WHERE notice_id = ?')
          .get(row.id) as { state: OutboxState; sent_by: string } | undefined)
    if (send)
      deliveries.push({
        device: send.sent_by,
        state: send.state,
        attempts: 1,
        result: `${send.state} by ${send.sent_by}`,
      })
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
    return this.tx(() => {
      const rows = this.db
        .prepare(
          `SELECT o.id, o.notice_id, o.device, o.attempts, n.received_at FROM outbox o
           JOIN notices n ON n.id = o.notice_id
           WHERE o.state = 'pending' AND o.next_at <= ?
           AND NOT EXISTS (SELECT 1 FROM notice_sends s WHERE s.notice_id = o.notice_id AND s.sent_by != ?)
           ORDER BY o.next_at, o.id LIMIT ?`,
        )
        .all(now, this.hostName, limit) as {
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
    this.tx(() => {
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
    if ('retryAt' in outcome) {
      this.db
        .prepare(
          `UPDATE outbox SET state = 'pending', attempts = attempts + 1, next_at = ?, result = ?,
           updated_at = ? WHERE id = ? AND state = 'sending'`,
        )
        .run(outcome.retryAt, outcome.result, now, id)
      return
    }
    this.tx(() => {
      const done = this.db
        .prepare(
          `UPDATE outbox SET state = ?, attempts = attempts + 1, result = ?, updated_at = ?
           WHERE id = ? AND state = 'sending'`,
        )
        .run(outcome.state, outcome.result, now, id)
      if (done.changes !== 1) return
      const row = this.db.prepare('SELECT notice_id FROM outbox WHERE id = ?').get(id) as {
        notice_id: string
      }
      this.recordSend(row.notice_id, outcome.state, now)
    })
  }

  /** Tells the other Aicos a notice's push is settled, so none of them sends it. Sent stays sent. */
  private recordSend(noticeId: string, state: OutboxState, now: number): void {
    const had = this.db
      .prepare('SELECT state, at FROM notice_sends WHERE notice_id = ?')
      .get(noticeId) as { state: string; at: number } | undefined
    if (had?.state === 'sent' && state !== 'sent') return
    const { at, seq } = this.stamp()
    this.db
      .prepare(
        `INSERT INTO notice_sends (notice_id, state, at, sent_by, seq) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (notice_id) DO UPDATE SET state = excluded.state, at = excluded.at,
         sent_by = excluded.sent_by, seq = excluded.seq`,
      )
      .run(noticeId, state, Math.max(at, now), this.hostName, seq)
  }

  /** A claimed row the owner's Settings choice stopped: it never goes out, and it failed nothing. */
  dropOutboxRow(id: number): void {
    this.db.prepare(`DELETE FROM outbox WHERE id = ? AND state = 'sending'`).run(id)
  }

  /** What a notice says after the door changed its route (a push dropped from the queue). */
  rewriteNotice(id: string, notice: Notice): void {
    this.tx(() => {
      this.db.prepare('UPDATE notices SET doc = ? WHERE id = ?').run(JSON.stringify(notice), id)
      this.touch(id)
    })
  }

  /** The notices received since `since` (epoch ms), newest first, with their deliveries. */
  since(since: number): StoredNotice[] {
    const rows = this.db
      .prepare('SELECT * FROM notices WHERE received_at >= ? ORDER BY received_at DESC, rowid DESC')
      .all(since) as unknown as NoticeRow[]
    return rows.map((row) => this.present(row))
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
    this.tx(() => {
      this.db.prepare('UPDATE notices SET ask_id = ? WHERE id = ?').run(askId, noticeId)
      this.touch(noticeId)
    })
  }

  byAsk(askId: string): StoredNotice | null {
    const row = this.db.prepare('SELECT * FROM notices WHERE ask_id = ?').get(askId) as
      | NoticeRow
      | undefined
    return row ? this.present(row) : null
  }

  /** Records the owner's answer once; false when it was already recorded. */
  answer(noticeId: string, answer: string, now: number): boolean {
    return this.tx(() => {
      const first =
        this.db
          .prepare('UPDATE notices SET answer = ?, answered_at = ? WHERE id = ? AND answer IS NULL')
          .run(answer, now, noticeId).changes === 1
      if (first) this.touch(noticeId)
      return first
    })
  }

  setOutcome(noticeId: string, outcome: string): void {
    this.tx(() => {
      this.db.prepare('UPDATE notices SET outcome = ? WHERE id = ?').run(outcome, noticeId)
      this.touch(noticeId)
    })
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
    this.tx(() => {
      const known = this.db.prepare('SELECT 1 FROM notice_reads WHERE notice_id = ?')
      const insert = this.db.prepare(
        'INSERT INTO notice_reads (notice_id, read_at, via, seq) VALUES (?, ?, ?, ?)',
      )
      for (const id of new Set(ids)) if (!known.get(id)) insert.run(id, now, via, this.stamp().seq)
      this.db.prepare('DELETE FROM notice_reads WHERE read_at < ?').run(now - READ_KEPT_MS)
    })
  }

  /** Mark all read: everything that came at or before `at` (epoch ms) is read. Never moves back. */
  markAllRead(at: number): void {
    this.tx(() => {
      const had = this.db.prepare("SELECT at FROM marks WHERE name = 'read_all'").get() as
        | { at: number }
        | undefined
      if (had && Number(had.at) >= at) return
      this.db
        .prepare(
          `INSERT INTO marks (name, at, seq) VALUES ('read_all', ?, ?)
           ON CONFLICT (name) DO UPDATE SET at = excluded.at, seq = excluded.seq`,
        )
        .run(at, this.stamp().seq)
    })
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
