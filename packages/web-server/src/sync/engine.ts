// The sync engine: row-level, two-way, no CRDT library. It works on a
// registry of tables (`SyncTable`) in one SQLite file (`SyncHandle`), so one
// engine covers notes.db and the view state in web.db. Everything here is a
// function of a handle and data: no timers, no network. `pullSet` takes a
// transport (5b supplies the unix-socket one; the test harness a fake).
//
// Rules, in short (docs/plans/notes-and-capture.md "Sync"):
// - Every synced row carries `<clock>` (a hybrid logical clock), `origin`,
//   `prev` + `prev_origin` (the newest version by another host that the edit
//   is built on, carried across a host's own edits), `deleted` and `seq` (a
//   per-file change counter). A peer asks for "rows after my cursor".
// - A remote row R meets the local row L: identical stamp -> skip; R descends
//   from L -> take R; L descends from R -> skip; otherwise the newer (clock,
//   then origin) wins the whole row, and a losing local edit is kept as a
//   conflict revision. One host's versions of a row are one history (the
//   later descends from the earlier); across hosts, R descends from L when
//   R's base is a version of L's host at or after L.
// - Applying a page is one transaction that also moves the cursor, so half a
//   page changes nothing and a page applied twice changes nothing.

import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { DEFAULT_MAX_AHEAD_HOURS } from '../config'

export type SyncValue = string | number | null
export type SyncRow = Record<string, SyncValue>

export interface SyncTable {
  name: string
  /** Primary key columns (single column for every table today). */
  keys: string[]
  /** The hybrid-clock column; default `updated_at`. */
  clock?: string
  /**
   * `row` (default): the row rules and tombstones above. `{ max }`: no clock and
   * no tombstones; the larger value of that column wins (`session_seen`), after `rank` if set.
   */
  merge?: 'row' | { max: string; rank?: { column: string; order: readonly string[] } }
  /** Text columns whose losing value is kept as a `conflict` revision. */
  text?: string[]
  /** Columns that must stay unique across rows; the loser's value gets `~<key>` appended. */
  unique?: string[]
  /** A column holding a blob hash (original file) the row needs. */
  blob?: string
  /** Columns that belong to each host's copy: a peer's values never come in. */
  localOnly?: string[]
  /** Two live rows with the same unique value are one thing made twice: the loser is also tombstoned. */
  dropDuplicate?: boolean
}

export interface ConflictRevision {
  id: string
  table: string
  rowId: string
  field: string
  text: string
}

export interface SyncHandle {
  /** `notes` or `web`: what a peer names this file in `?set=`. */
  set: string
  tables: readonly SyncTable[]
  hostName: string
  db: DatabaseSync
  now(): number
  schemaVersion(): number
  meta(key: string): string | null
  setMeta(key: string, value: string): void
  /** One transaction; a call made inside another joins it. */
  transaction<T>(work: () => T): T
  /** A local write: the next change number and clock value. Call inside `transaction`. */
  stamp(): { at: number; origin: string; seq: number }
  /** Moves the hybrid clock past a stamp seen from a peer. */
  observe(at: number): void
  /** Keeps a losing text as a revision (insert-only; the same id twice adds nothing). */
  saveRevision?(revision: ConflictRevision): void
  /** Rows were applied (or renamed): refresh anything derived from them (search index). */
  afterApply?(touched: { table: string; row: SyncRow }[]): void
}

export interface ChangePage {
  db_id: string
  rows: { table: string; row: SyncRow }[]
  /** The cursor after this page (the last row's `seq`; unchanged for an empty page). */
  next: number
  more: boolean
}

export interface Hello {
  host: string
  /** The peer's wall clock, for the skew estimate. */
  now: number
  sets: Record<string, { db_id: string; schema_version: number; seq: number }>
  /** Which build the peer runs (a fingerprint of its server bundle); older peers omit it. */
  build_id?: string
  /** This Aico stands in for a primary (AICO_PRIMARY_HOST): it sends only when none is alive. */
  standby?: boolean
}

export interface PeerTransport {
  hello(): Promise<Hello>
  changes(request: { set: string; since: number; limit: number; peer: string }): Promise<ChangePage>
}

export class SyncError extends Error {}

const DEFAULT_PAGE_LIMIT = 500
const MAX_AHEAD_MS = DEFAULT_MAX_AHEAD_HOURS * 3_600_000

const clockOf = (table: SyncTable) => table.clock ?? 'updated_at'
const isMax = (table: SyncTable) => typeof table.merge === 'object'
const keyText = (table: SyncTable, row: SyncRow) => table.keys.map((key) => row[key]).join('|')

function tableOf(handle: SyncHandle, name: unknown): SyncTable {
  const table = handle.tables.find((candidate) => candidate.name === name)
  if (!table) throw new SyncError(`Unknown sync table ${String(name)}`)
  return table
}

const columnCache = new WeakMap<DatabaseSync, Map<string, string[]>>()

function columnsOf(handle: SyncHandle, table: SyncTable): string[] {
  const tables = columnCache.get(handle.db) ?? new Map<string, string[]>()
  columnCache.set(handle.db, tables)
  const known = tables.get(table.name)
  if (known) return known
  const info = handle.db.prepare(`PRAGMA table_info(${table.name})`).all() as { name: string }[]
  const columns = info.map((column) => column.name)
  tables.set(table.name, columns)
  return columns
}

function readRow(handle: SyncHandle, table: SyncTable, row: SyncRow): SyncRow | null {
  const where = table.keys.map((key) => `${key} = ?`).join(' AND ')
  const found = handle.db
    .prepare(`SELECT * FROM ${table.name} WHERE ${where}`)
    .get(...table.keys.map((key) => row[key])) as SyncRow | undefined
  return found ? { ...found } : null
}

function nextSeq(handle: SyncHandle): number {
  const seq = Number(handle.meta('seq') ?? 0) + 1
  handle.setMeta('seq', String(seq))
  return seq
}

// -- Serving changes ------------------------------------------------------------

/** Rows with `seq` after `since`, oldest change first, at most `limit`. */
export function changesSince(handle: SyncHandle, since: number, limit: number): ChangePage {
  const found: { table: string; row: SyncRow }[] = []
  for (const table of handle.tables) {
    const rows = handle.db
      .prepare(`SELECT * FROM ${table.name} WHERE seq > ? ORDER BY seq LIMIT ?`)
      .all(since, limit + 1) as SyncRow[]
    for (const row of rows) found.push({ table: table.name, row: { ...row } })
  }
  found.sort((a, b) => Number(a.row.seq) - Number(b.row.seq))
  const rows = found.slice(0, limit)
  const next = rows.length > 0 ? Number(rows[rows.length - 1]?.row.seq) : since
  for (const entry of rows) delete entry.row.seq // the receiver numbers its own changes
  return { db_id: handle.meta('db_id') ?? '', rows, next, more: found.length > limit }
}

/** A peer is told apart from a stranger only by the name it gives; the link is the authentication. */
export function serveHello(
  handles: readonly SyncHandle[],
  host: string,
  now: number,
  buildId?: string,
  standby = false,
): Hello {
  const sets: Hello['sets'] = {}
  for (const handle of handles)
    sets[handle.set] = {
      db_id: handle.meta('db_id') ?? '',
      schema_version: handle.schemaVersion(),
      seq: Number(handle.meta('seq') ?? 0),
    }
  return {
    host,
    now,
    sets,
    ...(buildId ? { build_id: buildId } : {}),
    ...(standby ? { standby } : {}),
  }
}

/**
 * Answers `GET /sync/changes`. Notes which cursor the peer holds (what it
 * has applied from us), for tombstone cleanup, and the furthest page handed to
 * it. A cursor beyond either means this file was replaced by an older copy: it
 * takes a new `db_id`, and the peer, seeing the new id, starts over from 0.
 */
export function serveChanges(
  handle: SyncHandle,
  request: { since: number; limit: number; peer: string },
): ChangePage {
  const since = Math.max(0, Math.trunc(request.since) || 0)
  const limit = Math.min(Math.max(Math.trunc(request.limit) || DEFAULT_PAGE_LIMIT, 1), 2000)
  const seq = Number(handle.meta('seq') ?? 0)
  // A restored file has forgotten what it handed out: the peer's cursor is past
  // our `seq`, or past the last page we recorded giving this peer (our own
  // edits and pulls since the restore may have carried `seq` beyond it).
  const handed = Number(handle.meta(`handed:${request.peer}`) ?? 0)
  if (since > seq || (request.peer && since > handed)) {
    resetDbId(handle)
    return { db_id: handle.meta('db_id') ?? '', rows: [], next: 0, more: false }
  }
  const page = changesSince(handle, since, limit)
  if (request.peer) {
    const key = `served:${request.peer}`
    if (handle.meta(key) !== String(since)) handle.setMeta(key, String(since))
    if (page.next > handed) handle.setMeta(`handed:${request.peer}`, String(page.next))
  }
  return page
}

/** A restored file must not look like the one peers already pulled from. */
export function resetDbId(handle: SyncHandle): void {
  handle.transaction(() => {
    handle.setMeta('db_id', randomUUID())
    handle.db.prepare("DELETE FROM meta WHERE key LIKE 'served:%' OR key LIKE 'handed:%'").run()
  })
}

// -- Applying a page ----------------------------------------------------------

export interface ApplyOptions {
  /** Refuse a batch with a stamp further ahead than this (default one day). */
  maxAheadMs?: number
  /** Saved with the page, in the same transaction, so a half page never moves the cursor. */
  cursor?: { host: string; db_id: string; next: number }
}

export interface ApplyResult {
  status: 'ok' | 'clock_ahead'
  applied: number
  skipped: number
  conflicts: number
}

interface PeerState {
  db_id: string
  cursor: number
  skew_ms?: number
  status?: string
  at?: number
}

export function readPeer(handle: SyncHandle, host: string): PeerState | null {
  const text = handle.meta(`peer:${host}`)
  return text ? (JSON.parse(text) as PeerState) : null
}

function writePeer(handle: SyncHandle, host: string, state: PeerState): void {
  handle.setMeta(`peer:${host}`, JSON.stringify(state))
}

/**
 * The base a new edit of `current` is built on: the newest version by another
 * host in its history. An edit of another host's version builds on that
 * version; an edit of our own carries the base forward, so a peer that has
 * only seen the first of several edits still sees them as built on its copy.
 * Call with the table's stamp (`{ at, origin }` from `handle.stamp()`).
 */
export function baseOf(
  host: string,
  current: { origin?: unknown; prev?: unknown; prev_origin?: unknown },
  clock: unknown,
): { prev: number | null; prev_origin: string | null } {
  if (current.origin !== host) return { prev: Number(clock), prev_origin: String(current.origin) }
  return current.prev_origin != null && current.prev != null
    ? { prev: Number(current.prev), prev_origin: String(current.prev_origin) }
    : { prev: null, prev_origin: null }
}

/** True when `later` is `earlier` or was built on it. */
function descends(later: SyncRow, earlier: SyncRow, clock: string): boolean {
  if (later.origin === earlier.origin) return Number(later[clock]) >= Number(earlier[clock])
  return (
    later.prev != null &&
    later.prev_origin === earlier.origin &&
    Number(later.prev) >= Number(earlier[clock])
  )
}

const newer = (a: SyncRow, b: SyncRow, clock: string): boolean =>
  Number(a[clock]) !== Number(b[clock])
    ? Number(a[clock]) > Number(b[clock])
    : String(a.origin) > String(b.origin)

/**
 * Applies a page of changes in one transaction; applying it again changes
 * nothing. Throws `SyncError` (nothing applied) for a malformed page.
 */
export function applyPage(
  handle: SyncHandle,
  rows: readonly { table: string; row: SyncRow }[],
  options: ApplyOptions = {},
): ApplyResult {
  const limit = handle.now() + (options.maxAheadMs ?? MAX_AHEAD_MS)
  const entries = rows.map((entry) => {
    const table = tableOf(handle, entry?.table)
    if (!entry.row || typeof entry.row !== 'object' || table.keys.some((k) => entry.row[k] == null))
      throw new SyncError(`A ${table.name} row has no key`)
    if (!isMax(table) && !Number.isFinite(Number(entry.row[clockOf(table)])))
      throw new SyncError(`A ${table.name} row has no clock`)
    return { table, row: entry.row }
  })
  const ahead = entries.some(
    ({ table, row }) => !isMax(table) && Number(row[clockOf(table)]) > limit,
  )
  const result: ApplyResult = { status: 'ok', applied: 0, skipped: 0, conflicts: 0 }
  if (ahead) return { ...result, status: 'clock_ahead' }

  handle.transaction(() => {
    const touched: { table: string; row: SyncRow }[] = []
    let highest = 0
    for (const { table, row } of entries) {
      if (!isMax(table)) highest = Math.max(highest, Number(row[clockOf(table)]))
      const outcome = applyRow(handle, table, row, touched)
      if (outcome === 'skipped') result.skipped += 1
      else result.applied += 1
      if (outcome === 'conflict') result.conflicts += 1
    }
    if (highest > 0) handle.observe(highest)
    if (touched.length > 0) handle.afterApply?.(touched)
    if (options.cursor) {
      const { host, db_id, next } = options.cursor
      writePeer(handle, host, {
        ...(readPeer(handle, host) ?? { db_id, cursor: 0 }),
        db_id,
        cursor: next,
      })
    }
  })
  return result
}

type Outcome = 'applied' | 'skipped' | 'conflict'

function applyRow(
  handle: SyncHandle,
  table: SyncTable,
  remote: SyncRow,
  touched: { table: string; row: SyncRow }[],
): Outcome {
  const local = readRow(handle, table, remote)
  if (isMax(table)) {
    const { max: column, rank } = table.merge as Exclude<SyncTable['merge'], 'row' | undefined>
    // A rank (later in its order is higher) decides first, so every host lands on the same row.
    const ranked = (row: SyncRow) => (rank ? rank.order.indexOf(String(row[rank.column])) : 0)
    if (
      local &&
      (ranked(local) > ranked(remote) ||
        (ranked(local) === ranked(remote) && Number(local[column]) >= Number(remote[column])))
    )
      return 'skipped'
    write(handle, table, remote, touched)
    return 'applied'
  }
  if (!local) {
    write(handle, table, remote, touched)
    return 'applied'
  }
  const clock = clockOf(table)
  if (Number(remote[clock]) === Number(local[clock]) && remote.origin === local.origin)
    return 'skipped' // identical
  if (descends(remote, local, clock)) {
    write(handle, table, remote, touched, local) // built on what we have
    return 'applied'
  }
  if (descends(local, remote, clock)) return 'skipped' // we are past it
  // Edited apart. The newer wins the whole row.
  if (!newer(remote, local, clock)) return 'skipped'
  let conflict = false
  // Our own edit loses: keep its text. A row our own host wrote that the peer
  // also wrote (same origin both sides) is just a newer version of one history.
  if (local.origin === handle.hostName && remote.origin !== handle.hostName)
    conflict = keepLoser(handle, table, local, remote)
  write(handle, table, remote, touched, local)
  return conflict ? 'conflict' : 'applied'
}

/** Saves the local text that is about to be replaced; true when anything was kept. */
function keepLoser(handle: SyncHandle, table: SyncTable, loser: SyncRow, winner: SyncRow): boolean {
  let kept = false
  const clock = clockOf(table)
  for (const field of table.text ?? []) {
    const text = loser[field]
    if (typeof text !== 'string' || text === '' || text === winner[field]) continue
    // Both hosts reach the same loser, so the id is derived: the revision made
    // on each side is the same row, not two.
    const id = createHash('sha256')
      .update([table.name, keyText(table, loser), field, loser[clock], loser.origin].join('|'))
      .digest('hex')
      .slice(0, 12)
    handle.saveRevision?.({ id, table: table.name, rowId: keyText(table, loser), field, text })
    kept = true
  }
  return kept
}

/** Inserts or replaces the row with a fresh local `seq`, first making room for its unique values. */
function write(
  handle: SyncHandle,
  table: SyncTable,
  remote: SyncRow,
  touched: { table: string; row: SyncRow }[],
  replaced?: SyncRow,
): void {
  const row = { ...remote }
  for (const column of table.unique ?? []) claimUnique(handle, table, row, column, touched)
  const known = new Set(columnsOf(handle, table))
  const columns = Object.keys(row).filter(
    (column) => known.has(column) && column !== 'seq' && !table.localOnly?.includes(column),
  )
  const names = [...columns, 'seq']
  const values = [...columns.map((column) => row[column] as SyncValue), nextSeq(handle)]
  const updates = names.filter((name) => !table.keys.includes(name))
  handle.db
    .prepare(
      `INSERT INTO ${table.name} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})
       ON CONFLICT (${table.keys.join(', ')}) DO UPDATE SET ${updates.map((name) => `${name} = excluded.${name}`).join(', ')}`,
    )
    .run(...values)
  // The row it replaced is touched too: an item that moved notes leaves the old one's search entry stale.
  if (replaced) touched.push({ table: table.name, row: replaced })
  touched.push({ table: table.name, row })
}

/**
 * Two hosts can make different rows with the same unique value (the Groceries
 * list on both doors, the same upload retried against each). The row with the
 * lower key keeps the value (a live row beats a tombstone); the other gets
 * `value~key`. Whichever side holds the loser, the rename is a local edit with
 * its own stamp, built on the version it changed, so it syncs back and both
 * hosts end with the same row. A table with `dropDuplicate` also tombstones a
 * live loser (a retried upload is one capture, read once).
 */
function claimUnique(
  handle: SyncHandle,
  table: SyncTable,
  row: SyncRow,
  column: string,
  touched: { table: string; row: SyncRow }[],
): void {
  const value = row[column]
  if (value === null || value === undefined) return
  const other = handle.db
    .prepare(`SELECT * FROM ${table.name} WHERE ${column} = ?`)
    .all(value)
    .map((found) => ({ ...(found as SyncRow) }))
    .find((found) => keyText(table, found) !== keyText(table, row))
  if (!other) return
  const clock = clockOf(table)
  const incomingLoses =
    Number(row.deleted) !== Number(other.deleted)
      ? Number(row.deleted) === 1
      : keyText(table, row) > keyText(table, other)
  const loser = incomingLoses ? row : other
  const drop = table.dropDuplicate && Number(row.deleted) === 0 && Number(other.deleted) === 0
  // The stamp must sort after the version it changes, which may be a peer's.
  handle.observe(Number(loser[clock]))
  const stamp = handle.stamp()
  const renamed: Record<string, SyncValue> = {
    [column]: `${value}~${keyText(table, loser)}`,
    [clock]: stamp.at,
    origin: stamp.origin,
    ...baseOf(handle.hostName, loser, loser[clock]),
    ...(drop ? { deleted: 1 } : {}),
  }
  if (incomingLoses) {
    Object.assign(row, renamed) // written by the caller
    return
  }
  const names = Object.keys(renamed)
  const where = table.keys.map((key) => `${key} = ?`).join(' AND ')
  handle.db
    .prepare(
      `UPDATE ${table.name} SET ${names.map((name) => `${name} = ?`).join(', ')}, seq = ? WHERE ${where}`,
    )
    .run(
      ...names.map((name) => renamed[name] as SyncValue),
      stamp.seq,
      ...table.keys.map((key) => other[key] as SyncValue),
    )
  const updated = readRow(handle, table, other)
  if (updated) touched.push({ table: table.name, row: updated })
}

// -- Pulling from a peer ------------------------------------------------------

export type PullStatus =
  | 'ok'
  /** Peer or link down: skip quietly, try on the next tick. */
  | 'unreachable'
  /** The two files have different schemas: sync waits, local use goes on. */
  | 'schema_mismatch'
  /** The peer sent a stamp more than a day ahead of this host's clock. */
  | 'clock_ahead'
  | 'error'

export interface PullResult {
  status: PullStatus
  host?: string
  /** The peer's build, when it said. */
  buildId?: string
  /** The peer stands in for a primary. */
  standby?: boolean
  applied: number
  pages: number
  /** Peer clock minus ours, estimated; null when the peer was not reached. */
  skewMs: number | null
  error?: string
}

export interface PullOptions {
  limit?: number
  maxAheadMs?: number
}

/**
 * One pass over a peer for one file: hello, then pages until `more` is false.
 * Never throws; a failure is the result's status.
 */
export async function pullSet(
  handle: SyncHandle,
  transport: PeerTransport,
  options: PullOptions = {},
): Promise<PullResult> {
  const result: PullResult = { status: 'ok', applied: 0, pages: 0, skewMs: null }
  const limit = options.limit ?? DEFAULT_PAGE_LIMIT
  let hello: Hello
  const started = handle.now()
  try {
    hello = await transport.hello()
  } catch (error) {
    return { ...result, status: 'unreachable', error: String((error as Error).message ?? error) }
  }
  const finished = handle.now()
  result.host = hello.host
  if (hello.build_id) result.buildId = hello.build_id
  result.standby = hello.standby === true
  result.skewMs = Math.round(hello.now - (started + finished) / 2)
  const theirs = hello.sets[handle.set]
  const remember = (state: Partial<PeerState>) =>
    handle.transaction(() =>
      writePeer(handle, hello.host, {
        ...(readPeer(handle, hello.host) ?? { db_id: theirs?.db_id ?? '', cursor: 0 }),
        ...state,
        skew_ms: result.skewMs ?? undefined,
        at: handle.now(),
      }),
    )
  if (!theirs || theirs.schema_version !== handle.schemaVersion()) {
    remember({ status: 'schema_mismatch' })
    return { ...result, status: 'schema_mismatch' }
  }
  const state = readPeer(handle, hello.host)
  let dbId = theirs.db_id
  let cursor = state?.db_id === dbId ? state.cursor : 0
  let resets = 0
  for (;;) {
    let page: ChangePage
    try {
      page = await transport.changes({
        set: handle.set,
        since: cursor,
        limit,
        peer: handle.hostName,
      })
    } catch (error) {
      return { ...result, status: 'unreachable', error: String((error as Error).message ?? error) }
    }
    if (page.db_id !== dbId) {
      // The peer's file was restored since hello: begin again from 0 (once).
      if (++resets > 1)
        return { ...result, status: 'error', error: 'The peer keeps changing its database id' }
      dbId = page.db_id
      cursor = 0
      continue
    }
    try {
      const applied = applyPage(handle, page.rows, {
        maxAheadMs: options.maxAheadMs,
        cursor: { host: hello.host, db_id: dbId, next: page.next },
      })
      if (applied.status === 'clock_ahead') {
        remember({ status: 'clock_ahead' })
        return { ...result, status: 'clock_ahead' }
      }
      result.applied += applied.applied
    } catch (error) {
      return { ...result, status: 'error', error: String((error as Error).message ?? error) }
    }
    result.pages += 1
    cursor = page.next
    if (!page.more) break
  }
  remember({ status: 'ok' })
  return result
}

// -- Tombstones ---------------------------------------------------------------

/**
 * Removes tombstones older than the retention that every peer has already
 * pulled (its cursor on our file is at or past the row's `seq`). A peer we
 * have never heard from counts as cursor 0, so nothing is removed until it
 * has pulled. Returns how many rows went.
 */
export function purgeTombstones(
  handle: SyncHandle,
  options: { retentionMs: number; peers: readonly string[] },
): number {
  if (options.peers.length === 0) return 0 // no named peers: nobody to wait for is not "everyone has pulled"
  const floor = Math.min(...options.peers.map((peer) => Number(handle.meta(`served:${peer}`) ?? 0)))
  const before = handle.now() - options.retentionMs
  let removed = 0
  handle.transaction(() => {
    for (const table of handle.tables) {
      if (isMax(table)) continue
      const result = handle.db
        .prepare(
          `DELETE FROM ${table.name} WHERE deleted = 1 AND ${clockOf(table)} < ? AND seq <= ?`,
        )
        .run(before, floor)
      removed += Number(result.changes)
    }
  })
  return removed
}

// -- Blobs --------------------------------------------------------------------

/** Hashes that live rows point at and `has` says are not on disk here. */
export function missingBlobs(handle: SyncHandle, has: (hash: string) => boolean): string[] {
  const missing = new Set<string>()
  for (const table of handle.tables) {
    if (!table.blob) continue
    const rows = handle.db
      .prepare(
        `SELECT DISTINCT ${table.blob} AS hash FROM ${table.name} WHERE deleted = 0 AND ${table.blob} IS NOT NULL`,
      )
      .all() as { hash: string }[]
    for (const { hash } of rows) if (!has(hash)) missing.add(hash)
  }
  return [...missing].sort()
}
