// status.db: one row per id, the posted row as JSON plus when the server took
// it. This package owns the file (package.json aico.db); others ask aico-web.

import { hostname } from 'node:os'
import { join } from 'node:path'
import { type Database, type Migration, openDatabase, transaction } from '@aico/store'
import { type AlertBatch, type AlertHook, transitions } from './alerts'
import { expectedOffSince, type Intent, type MachineIntent, showsBack } from './intent'
import { type MajorWindows, majorOf } from './major'
import { parseRow, type StatusRow } from './row'
import {
  type Filter,
  LATE_GRACE_MS,
  type Shown,
  type ShownRow,
  type StatusView,
  type StoredRow,
  type Sustained,
  show,
  summary,
  view,
} from './show'

/**
 * What a row's alert state is remembered as. Unknown, and off with its machine, are never kept: a
 * row whose machine went away keeps the state it had, so coming back to it is no change.
 */
function seenState(row: ShownRow): Shown | null {
  return row.shown === 'unknown' || row.machine_off ? null : row.shown
}

function readRows(db: Database): StoredRow[] {
  const all = db.prepare('SELECT doc, updated_at, back_at FROM status_rows').all() as {
    doc: string
    updated_at: number
    back_at: number | null
  }[]
  return all.map(({ doc, updated_at, back_at }) => ({
    row: JSON.parse(doc) as StatusRow,
    updatedAt: updated_at,
    ...(back_at === null ? {} : { backAt: back_at }),
  }))
}

function migrations(now: () => number): Migration[] {
  return [
    `CREATE TABLE status_rows (
       id TEXT PRIMARY KEY,
       doc TEXT NOT NULL,
       updated_at INTEGER NOT NULL
     ) STRICT`,
    // Each row's state at the last alert pass (alerts.ts).
    `CREATE TABLE status_seen (
       id TEXT PRIMARY KEY,
       shown TEXT NOT NULL
     ) STRICT`,
    // Machine rows: when the machine reported again after being off or late (show.ts, back).
    // And the alert states start from the rows as they are, so a first start (or this one, after
    // seen states that kept unknown) alerts on nothing already showing.
    (db) => {
      db.exec('ALTER TABLE status_rows ADD COLUMN back_at INTEGER')
      db.exec('DELETE FROM status_seen')
      const put = db.prepare('INSERT INTO status_seen (id, shown) VALUES (?, ?)')
      for (const row of show(readRows(db), now())) put.run(row.id, seenState(row) ?? row.state)
    },
    // Where each machine is meant to be (intent.ts): declared in the registry, copied here.
    `CREATE TABLE machine_intent (
       machine TEXT PRIMARY KEY,
       intent TEXT NOT NULL CHECK (intent IN ('always', 'on-demand', 'off')),
       since INTEGER NOT NULL,
       stopped_at INTEGER,
       used_since INTEGER
     ) STRICT`,
    // Power is observed, not marked: what the hypervisor last said, since when, and as of when.
    (db) => {
      db.exec('ALTER TABLE machine_intent DROP COLUMN used_since')
      db.exec('ALTER TABLE machine_intent ADD COLUMN power_on INTEGER')
      db.exec('ALTER TABLE machine_intent ADD COLUMN power_since INTEGER')
      db.exec('ALTER TABLE machine_intent ADD COLUMN power_at INTEGER')
    },
    // Planned outages (`aico away`): a machine meant to be off for a while. It need not be a
    // declared place (the two computers are not). `at` is the moment after which a report
    // from the machine means it is back; until then it shows off.
    `CREATE TABLE planned_outage (
       machine TEXT PRIMARY KEY,
       at INTEGER NOT NULL
     ) STRICT`,
    // How long each row has been in its alert state, and whether the phone was told it stayed
    // that way (major.ts). Rows already showing start counting now.
    (db) => {
      db.exec('ALTER TABLE status_seen ADD COLUMN since INTEGER')
      db.exec('ALTER TABLE status_seen ADD COLUMN escalated INTEGER NOT NULL DEFAULT 0')
      db.prepare('UPDATE status_seen SET since = ?').run(now())
    },
  ]
}

/** This host's id on its rows: the short host name in lower case ('davion-sidarli'). */
export function machineId(name: string = hostname()): string {
  return (name.split('.')[0] as string).toLowerCase()
}

/** The status DB file in a data directory. */
export function statusDbPath(dataDir: string): string {
  return join(dataDir, 'status.db')
}

/** Told of rows that stayed bad past their window, and of those told before that are well again. */
export type SustainedHook = (told: { stayed: Sustained[]; recovered: string[] }) => void

export class StatusStore {
  private readonly db: Database
  private alertHook: AlertHook | null = null
  private sustained: { windows: MajorWindows; hook: SustainedHook } | null = null

  /** Opens `path` (`':memory:'` for tests); `now` stamps updated_at. */
  constructor(
    path: string,
    private readonly now: () => number = Date.now,
  ) {
    this.db = openDatabase(path, migrations(now))
  }

  /**
   * Writes rows, all or none (each checked by `parseRow` first); the same id replaces its row.
   * A machine row that reports after being off or late (or for the first time) marks the machine
   * back now.
   */
  upsert(rows: readonly StatusRow[]): void {
    const checked = rows.map(parseRow)
    const at = this.now()
    const before = this.db.prepare('SELECT doc, back_at FROM status_rows WHERE id = ?')
    const ended = this.db.prepare('DELETE FROM planned_outage WHERE machine = ? AND at < ?')
    const put = this.db.prepare(
      `INSERT INTO status_rows (id, doc, updated_at, back_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         doc = excluded.doc, updated_at = excluded.updated_at, back_at = excluded.back_at`,
    )
    transaction(this.db, () => {
      for (const row of checked) {
        let backAt: number | null = null
        if (row.kind === 'machine') {
          const old = before.get(row.id) as { doc: string; back_at: number | null } | undefined
          const was = old ? (JSON.parse(old.doc) as StatusRow) : null
          const away =
            !was ||
            was.state === 'off' ||
            (was.next_run !== undefined && Date.parse(was.next_run) + LATE_GRACE_MS < at)
          backAt = row.state === 'off' ? null : away ? at : (old?.back_at ?? null)
        }
        put.run(row.id, JSON.stringify(row), at, backAt)
        // A planned outage ends when the machine reports again after it was due to be gone.
        if (showsBack(row)) ended.run(row.machine, at)
      }
    })
    if (this.alertHook || this.sustained) this.checkAlerts()
  }

  /** The declared intent of each machine and what the owner did since. */
  intents(): MachineIntent[] {
    return (
      this.db
        .prepare(
          'SELECT machine, intent, since, stopped_at, power_on, power_since, power_at FROM machine_intent',
        )
        .all() as {
        machine: string
        intent: Intent
        since: number
        stopped_at: number | null
        power_on: number | null
        power_since: number | null
        power_at: number | null
      }[]
    ).map((r) => ({
      machine: r.machine,
      intent: r.intent,
      since: r.since,
      stoppedAt: r.stopped_at,
      power: r.power_on === null ? null : r.power_on ? 'on' : 'off',
      powerSince: r.power_since,
      powerAt: r.power_at,
    }))
  }

  /** Machines expected to be off, with since when (epoch ms). */
  expectedOff(): Map<string, number> {
    const off = new Map<string, number>()
    for (const m of this.intents()) {
      const since = expectedOffSince(m)
      if (since !== null) off.set(m.machine, since)
    }
    for (const [machine, at] of this.plannedOutages())
      off.set(machine, Math.max(at, off.get(machine) ?? at))
    return off
  }

  /** Machines with a planned outage, with the moment after which a report means they are back. */
  plannedOutages(): Map<string, number> {
    const rows = this.db.prepare('SELECT machine, at FROM planned_outage').all() as {
      machine: string
      at: number
    }[]
    return new Map(rows.map((r) => [r.machine, r.at]))
  }

  /**
   * Plans an outage for `machines`: they show off, and their rows with them, and never page,
   * until one reports after `at` (default now). Give `at` a little ahead of now so a report sent
   * while the machine is still shutting down does not end it.
   */
  planOutage(machines: readonly string[], at: number = this.now()): void {
    const put = this.db.prepare(
      `INSERT INTO planned_outage (machine, at) VALUES (?, ?)
       ON CONFLICT (machine) DO UPDATE SET at = excluded.at`,
    )
    transaction(this.db, () => {
      for (const machine of machines) put.run(machine, at)
    })
    if (this.alertHook || this.sustained) this.checkAlerts()
  }

  /** Takes back a planned outage (the plan failed, or the machine stays on). */
  clearOutage(machines: readonly string[]): void {
    const drop = this.db.prepare('DELETE FROM planned_outage WHERE machine = ?')
    transaction(this.db, () => {
      for (const machine of machines) drop.run(machine)
    })
    if (this.alertHook || this.sustained) this.checkAlerts()
  }

  /** Whether `machine` is meant to be off now. */
  isExpectedOff(machine: string): boolean {
    return this.expectedOff().has(machine)
  }

  /**
   * Makes the table match the registry: new machines are added, a changed intent starts over,
   * and machines no longer declared are dropped. The owner's stops and the observed power survive a sync.
   */
  syncIntents(declared: readonly { machine: string; intent: Intent }[]): void {
    const at = this.now()
    const known = new Map(this.intents().map((m) => [m.machine, m]))
    transaction(this.db, () => {
      const names = new Set(declared.map((d) => d.machine))
      for (const m of known.values())
        if (!names.has(m.machine))
          this.db.prepare('DELETE FROM machine_intent WHERE machine = ?').run(m.machine)
      for (const { machine, intent } of declared) {
        if (known.get(machine)?.intent === intent) continue
        this.db
          .prepare(
            `INSERT INTO machine_intent (machine, intent, since) VALUES (?, ?, ?)
             ON CONFLICT (machine) DO UPDATE SET
               intent = excluded.intent, since = excluded.since, stopped_at = NULL`,
          )
          .run(machine, intent, at)
      }
    })
    if (this.alertHook || this.sustained) this.checkAlerts()
  }

  /** The owner shut `machine` down (`at`, default now) or undid that (`null`). */
  markStopped(machine: string, at: number | null = this.now()): void {
    this.db.prepare('UPDATE machine_intent SET stopped_at = ? WHERE machine = ?').run(at, machine)
    if (this.alertHook || this.sustained) this.checkAlerts()
  }

  /**
   * What the hypervisor says about `machine`'s power, read at `at`; `since` is when it reached
   * that state if known (a running guest's start). Call it only with a reading: when the
   * hypervisor cannot be reached the last reading stays, with its own time.
   */
  setObservedPower(machine: string, running: boolean, at: number, since: number = at): void {
    const m = this.intents().find((i) => i.machine === machine)
    if (!m) return
    const changed = m.power !== (running ? 'on' : 'off')
    this.db
      .prepare(
        'UPDATE machine_intent SET power_on = ?, power_since = ?, power_at = ? WHERE machine = ?',
      )
      .run(running ? 1 : 0, changed ? since : (m.powerSince ?? since), at, machine)
    if (changed && (this.alertHook || this.sustained)) this.checkAlerts()
  }

  /** Drops a row (a thing that no longer exists); false when there was none. */
  remove(id: string): boolean {
    this.db.prepare('DELETE FROM status_seen WHERE id = ?').run(id)
    return this.db.prepare('DELETE FROM status_rows WHERE id = ?').run(id).changes > 0
  }

  /**
   * Hands each alerting batch to `hook`: on every upsert, and whenever the caller runs
   * checkAlerts() (on a timer, since rows go late without a write).
   */
  onAlert(hook: AlertHook): void {
    this.alertHook = hook
  }

  /**
   * Hands `hook` the rows that stayed failed or late past their class's window (major.ts), once
   * each, and the ids of rows it was told about that are well again. Checked with the alerts.
   */
  onSustained(windows: MajorWindows, hook: SustainedHook): void {
    this.sustained = { windows, hook }
  }

  /**
   * Compares the rows with the last pass, hands the batch that alerts to the hook, then records
   * the states. When the hook throws, the rows it was told of are not recorded, so the next pass
   * tells it again. Returns the batch, or null.
   */
  checkAlerts(): AlertBatch | null {
    const now = this.now()
    const rows = show(this.rows(), now, this.expectedOff())
    const seen = new Map(
      (
        this.db.prepare('SELECT id, shown FROM status_seen').all() as {
          id: string
          shown: Shown
        }[]
      ).map(({ id, shown }) => [id, shown]),
    )
    const escalated = new Set(
      (
        this.db.prepare('SELECT id FROM status_seen WHERE escalated = 1').all() as { id: string }[]
      ).map((r) => r.id),
    )
    const changes = transitions(seen, rows)
    const batch = changes.length
      ? { generated_at: new Date(now).toISOString(), changes, summary: summary(rows) }
      : null
    let unsent = new Set<string>()
    if (batch && this.alertHook) {
      try {
        this.alertHook(batch)
      } catch (error) {
        console.error('[status] alert hook failed; the next pass tries again:', error)
        unsent = new Set(changes.map((change) => change.row.id))
      }
    }
    const put = this.db.prepare(
      `INSERT INTO status_seen (id, shown, since, escalated) VALUES (?, ?, ?, 0)
       ON CONFLICT (id) DO UPDATE SET shown = excluded.shown, since = excluded.since, escalated = 0`,
    )
    transaction(this.db, () => {
      for (const row of rows) {
        const state = seenState(row)
        if (state !== null && seen.get(row.id) !== state && !unsent.has(row.id))
          put.run(row.id, state, row.shown_since ? Date.parse(row.shown_since) : now)
      }
    })
    this.checkSustained(rows, now, escalated)
    return batch
  }

  /** The sustained pass (major.ts): rows past their window are told once, recovered ones once. */
  private checkSustained(
    rows: readonly ShownRow[],
    now: number,
    wasTold: ReadonlySet<string>,
  ): void {
    if (!this.sustained) return
    const { windows, hook } = this.sustained
    const kept = new Map(
      (
        this.db.prepare('SELECT id, shown, since, escalated FROM status_seen').all() as {
          id: string
          shown: Shown
          since: number | null
          escalated: number
        }[]
      ).map((r) => [r.id, r]),
    )
    const intents = new Map(this.intents().map((m) => [m.machine, m.intent]))
    const stayed: Sustained[] = []
    const recovered: string[] = []
    for (const row of rows) {
      const record = kept.get(row.id)
      if (!record) continue
      const major = majorOf(row, intents)
      if (major && record.shown === row.shown) {
        const since = record.since ?? now
        if (!record.escalated && now - since >= windows[major]) stayed.push({ row, major, since })
      } else if (
        wasTold.has(row.id) &&
        (row.shown === 'ok' || row.shown === 'warn' || row.shown === 'off')
      )
        recovered.push(row.id)
    }
    if (!stayed.length && !recovered.length) return
    try {
      hook({ stayed, recovered })
    } catch (error) {
      console.error('[status] sustained hook failed; the next pass tries again:', error)
      return
    }
    const mark = this.db.prepare('UPDATE status_seen SET escalated = ? WHERE id = ?')
    transaction(this.db, () => {
      for (const { row } of stayed) mark.run(1, row.id)
      for (const id of recovered) mark.run(0, id)
    })
  }

  rows(): StoredRow[] {
    return readRows(this.db)
  }

  /** The rows as a reader sees them now. */
  read(filter: Filter = {}): StatusView {
    return view(this.rows(), this.now(), filter, this.expectedOff())
  }

  close(): void {
    this.db.close()
  }
}
