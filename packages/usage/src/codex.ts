// Codex: its session logs (~/.codex/sessions/YYYY/MM/DD/*.jsonl) carry, on every
// token_count line, the account's rate limits (5h and weekly windows, plan, credit
// balance). Read only what was appended since the last pass (a cursor per file, saved
// in the same transaction as the rows it produced, so nothing counts twice) and keep:
//   - window readings (the newest wins, see readings.ts);
//   - the credits drawn: balance reports from concurrent sessions are stale, so a draw
//     is the drop below a running minimum, and a rise of lot_min_credits or more that no
//     lot explains is a new lot;
//   - per local day, model, project and speed: requests and tokens, and the credits drawn.
// A log file nobody has written to since the cutover day is read for its readings only
// (its tail, once). Conversation text is never kept.
// The whole pass runs in one write transaction, so two collects at once count a line once. A
// file that shrank or was rewritten is read again from its start and replaces what it
// contributed (credit draws are against the running minimum, so they never repeat).
// A file in a home or working directory marked private contributes numbers only: its cursor
// is keyed by a hash of its path, and neither its working directory nor its id is kept.

import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { transaction } from '@aico/store'
import config from '../data/usage.json' with { type: 'json' }
import { type Database, getState, putState } from './db'
import { localDay } from './plans'
import { type ReadingEvent, storeReading } from './readings'

const CODEX_SOURCE = 'codex_session_log'

const CHUNK = 8 * 1024 * 1024

interface FileState {
  cwd?: string
  model?: string
  speed?: string
  histStart?: number
  lastTotal?: number
  id?: string
  /** Only numbers are kept from this file. */
  private?: boolean
  /** Hash of the file's first bytes: a different one means the file was rewritten. */
  head?: string
  /** What this file added to the daily rows (key to requests, input, cached, output). */
  rolls?: Record<string, [number, number, number, number]>
}

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)

/** The first bytes' hash of a file (a rewritten file starts differently), or '' when empty. */
export function headHash(path: string, size: number): string {
  if (size === 0) return ''
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(Math.min(256, size))
    const read = readSync(fd, buffer, 0, buffer.length, 0)
    return sha(buffer.subarray(0, read).toString('latin1'))
  } finally {
    closeSync(fd)
  }
}

interface Balance {
  at: number
  balance: number
  key: string
}

interface Rollup {
  requests: number
  input: number
  cached: number
  output: number
  drawn: number
}

export interface CodexResult {
  files: number
  bytes: number
  readings: number
  /** Credits drawn found this pass. */
  drawn: number
  newLots: number
  /** Session folders that exist, and how many of them could not be read (counts only, never names). */
  roots: number
  unreadable: number
}

/** The project a working directory belongs to: the first folder under a workspaces root, else its name. */
export function projectOf(cwd: string | undefined, homes: readonly string[]): string {
  if (!cwd) return 'unknown'
  const path = cwd.replace(/\/+$/, '')
  for (const prefix of ['/srv/workspaces/projects/', '/srv/workspaces/', '/srv/scratch/', ...homes])
    if (path.startsWith(prefix)) return path.slice(prefix.length).split('/', 1)[0] || 'unknown'
  return path.split('/').pop() || 'unknown'
}

/** Complete lines appended after `offset` (up to `end`), with the offset after the last one. */
export function* newLines(path: string, offset: number, end: number): Generator<[string, number]> {
  const fd = openSync(path, 'r')
  try {
    let pos = offset
    let carry = Buffer.alloc(0)
    while (pos < end) {
      const buffer = Buffer.alloc(Math.min(CHUNK, end - pos))
      const read = readSync(fd, buffer, 0, buffer.length, pos)
      if (read <= 0) break
      pos += read
      let data = Buffer.concat([carry, buffer.subarray(0, read)])
      const base = pos - data.length
      let from = 0
      for (;;) {
        const nl = data.indexOf(10, from)
        if (nl < 0) break
        yield [data.toString('utf8', from, nl), base + nl + 1]
        from = nl + 1
      }
      carry = Buffer.from(data.subarray(from))
      data = Buffer.alloc(0)
    }
  } finally {
    closeSync(fd)
  }
}

export type Found = { path: string; size: number; mtime: number }

export interface SavedCursor {
  offset: number
  state: string
}

/**
 * The transcript files a pass reads: those under the existing `roots` changed since `sinceMs`,
 * plus any file with a saved cursor (`cursorSql` lists them) that changed in size, wherever its
 * folder is (a session that runs for days appends to the folder it began in). Sets the folder
 * counts on `result`. `hashedKey` is how a private file's cursor is stored.
 */
export function gatherFiles(
  db: Database,
  rootPaths: string[],
  sinceMs: number,
  recentFiles: (root: string, sinceMs: number) => Found[],
  cursorSql: string,
  result: { roots: number; unreadable: number },
): {
  files: Map<string, Found>
  saved: Map<string, SavedCursor>
  hashedKey: (path: string) => string
} {
  const files = new Map<string, Found>()
  const roots = rootPaths.filter((root) => existsSync(root))
  result.roots = roots.length
  for (const root of roots) {
    try {
      for (const file of recentFiles(root, sinceMs)) files.set(file.path, file)
    } catch {
      result.unreadable += 1
    }
  }
  const hashedKey = (path: string) => `private:${sha(path)}`
  const saved = new Map<string, SavedCursor>()
  for (const row of db.prepare(cursorSql).all() as unknown as (SavedCursor & { path: string })[]) {
    saved.set(row.path, row)
    if (row.path.startsWith('private:') || files.has(row.path)) continue
    if (!roots.some((root) => row.path.startsWith(`${root}/`))) continue
    try {
      const stat = statSync(row.path)
      if (stat.size !== row.offset)
        files.set(row.path, { path: row.path, size: stat.size, mtime: stat.mtimeMs })
    } catch {
      // gone
    }
  }
  return { files, saved, hashedKey }
}

/** The JSONL files under the sessions root changed since `sinceMs`, newest day folders only. */
function recentFiles(root: string, sinceMs: number): Found[] {
  const out: Found[] = []
  const start = new Date(sinceMs - 86400_000)
  const end = new Date(Date.now() + 86400_000)
  for (let at = start.getTime(); at <= end.getTime(); at += 86400_000) {
    const day = new Date(at)
    const dir = join(
      root,
      String(day.getFullYear()),
      String(day.getMonth() + 1).padStart(2, '0'),
      String(day.getDate()).padStart(2, '0'),
    )
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue
      const path = join(dir, name)
      try {
        const stat = statSync(path)
        if (stat.mtimeMs >= sinceMs) out.push({ path, size: stat.size, mtime: stat.mtimeMs })
      } catch {
        // gone between listing and stat
      }
    }
  }
  return out
}

const num = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0

export interface CodexOptions {
  /** The sessions roots, one per native home (HOME/.codex/sessions). */
  roots: string[]
  /** True for a path or working directory this collector keeps only numbers from. */
  isPrivate: (text: string) => boolean
  /** Home folders whose names stand for the project (for a working directory under them). */
  homes: readonly string[]
  now: number
  /** The first local day this package counts (YYYY-MM-DD): earlier days came from Agent Hub. */
  cutoverDay: string
  /** Lot start times already known (plans file and detected), epoch ms. */
  lotTimes: number[]
}

export function collectCodex(db: Database, options: CodexOptions): CodexResult {
  // One write transaction for the whole pass: a second collect waits here, then reads the
  // cursors the first one saved, so no line is counted twice.
  return transaction(db, () => pass(db, options))
}

function pass(db: Database, options: CodexOptions): CodexResult {
  const { now, cutoverDay } = options
  const cfg = config.codex
  const result: CodexResult = {
    files: 0,
    bytes: 0,
    readings: 0,
    drawn: 0,
    newLots: 0,
    roots: 0,
    unreadable: 0,
  }
  const [y, m, d] = cutoverDay.split('-').map(Number) as [number, number, number]
  const cutoverMs = new Date(y, m - 1, d).getTime()
  const lookbackMs = now - config.lookback_days * 86400_000
  // Never earlier than the lookback (not the cutover: once that is old, every run would walk
  // every folder since it): an older file is read only when it has a cursor.
  // A private file's cursor is keyed by a hash, so it can only be found again in the recent
  // day folders.
  const { files, saved, hashedKey } = gatherFiles(
    db,
    options.roots,
    lookbackMs,
    recentFiles,
    'SELECT path, offset, state FROM cursors',
    result,
  )
  hidePrivateCursors(db, options, saved)
  const events: ReadingEvent[] = []
  const balances: Balance[] = []
  const rollups = new Map<string, Rollup>()
  const cursors = new Map<string, { offset: number; state: FileState }>()
  const roll = (key: string): Rollup => {
    const found = rollups.get(key) ?? { requests: 0, input: 0, cached: 0, output: 0, drawn: 0 }
    rollups.set(key, found)
    return found
  }

  for (const file of [...files.values()].sort((a, b) => a.mtime - b.mtime)) {
    const prior = saved.get(hashedKey(file.path)) ?? saved.get(file.path)
    let state: FileState = prior
      ? JSON.parse(prior.state)
      : { private: options.isPrivate(file.path) }
    let offset = prior?.offset ?? 0
    // Shrunk, or its first bytes changed: the file was replaced. Read it again from the start
    // and take back what the old one added.
    if (prior) {
      let replaced = prior.offset > file.size
      if (!replaced && state.head) {
        try {
          replaced = headHash(file.path, file.size) !== state.head
        } catch {
          continue
        }
      }
      if (replaced) {
        for (const [key, [requests, input, cached, output]] of Object.entries(state.rolls ?? {})) {
          const back = roll(key)
          back.requests -= requests
          back.input -= input
          back.cached -= cached
          back.output -= output
        }
        state = { private: state.private }
        offset = 0
      }
    }
    // Untouched since before the cutover and never read: its tail is all that can still matter.
    const old = !prior && file.mtime < cutoverMs
    if (old) offset = Math.max(file.size - cfg.tail_bytes, 0)
    if (offset >= file.size) {
      if (file.size === 0 || state.head) continue
      state.head = headHash(file.path, file.size)
      cursors.set(file.path, { offset, state })
      continue
    }
    state.head ??= headHash(file.path, file.size)
    state.rolls ??= {}
    const mine = state.rolls
    let first = old && offset > 0
    let end = offset
    const projectName = () => (state.private ? 'private' : projectOf(state.cwd, options.homes))
    for (const [line, after] of newLines(file.path, offset, file.size)) {
      end = after
      if (first) {
        first = false // a tail read starts mid-line
        continue
      }
      const head = line.slice(0, 400)
      if (head.includes('"session_meta"')) {
        const meta = safe(line)?.payload
        if (meta) {
          const hide = state.private || options.isPrivate(String(meta.cwd ?? ''))
          const id = hide && meta.id !== undefined ? sha(String(meta.id)) : meta.id
          if (!state.id || id === state.id) {
            state.id = id
            if (hide) {
              state.private = true
              state.cwd = undefined
            } else state.cwd = meta.cwd ?? state.cwd
            if (Number.isInteger(meta.subagent_history_start_ordinal))
              state.histStart = meta.subagent_history_start_ordinal
          }
        }
        continue
      }
      if (head.includes('"turn_context"')) {
        const context = safe(line)?.payload
        if (context) {
          state.model = context.model ?? state.model
          state.speed = ['standard', 'fast', 'flex', 'priority'].includes(context.service_tier)
            ? context.service_tier
            : 'standard'
        }
        continue
      }
      if (!head.includes('"token_count"')) continue
      const record = safe(line)
      const payload = record?.payload
      const at = Date.parse(record?.timestamp ?? '')
      if (payload?.type !== 'token_count' || Number.isNaN(at)) continue
      const inherited =
        state.histStart !== undefined &&
        Number(/"ordinal":\s*(\d+)/.exec(head)?.[1] ?? Number.POSITIVE_INFINITY) < state.histStart
      if (inherited) continue
      const counts = !old && localDay(at) >= cutoverDay
      const key = () =>
        [localDay(at), state.model ?? 'unknown', projectName(), state.speed ?? 'standard'].join(
          '\n',
        )
      const limits = payload.rate_limits
      if (limits && typeof limits === 'object') {
        const credits = limits.credits
        let balance: number | null = null
        if (credits && credits.balance != null && !credits.unlimited) {
          const value = Number(credits.balance)
          if (Number.isFinite(value)) balance = value
        }
        if (balance !== null && counts) balances.push({ at, balance, key: key() })
        for (const name of ['primary', 'secondary']) {
          const window = limits[name]
          if (
            window &&
            Number.isInteger(window.window_minutes) &&
            typeof window.used_percent === 'number'
          )
            events.push({
              provider: 'codex',
              window_minutes: window.window_minutes,
              observedAt: at,
              used_percent: window.used_percent,
              resetsAt: num(window.resets_at) > 0 ? num(window.resets_at) * 1000 : null,
              source: CODEX_SOURCE,
              plan_type: typeof limits.plan_type === 'string' ? limits.plan_type : null,
            })
        }
      }
      if (!counts) continue
      const last = payload.info?.last_token_usage ?? {}
      const total = payload.info?.total_token_usage?.total_tokens
      const positive =
        num(last.input_tokens) + num(last.cached_input_tokens) + num(last.output_tokens) > 0
      if (positive && total !== state.lastTotal) {
        state.lastTotal = total
        const rollKey = key()
        const cached = num(last.cached_input_tokens)
        const input = Math.max(num(last.input_tokens) - cached, 0)
        const output = num(last.output_tokens)
        const add = roll(rollKey)
        add.requests += 1
        add.input += input
        add.cached += cached
        add.output += output
        const own = mine[rollKey] ?? [0, 0, 0, 0]
        mine[rollKey] = own
        own[0] += 1
        own[1] += input
        own[2] += cached
        own[3] += output
      }
    }
    if (end !== offset) {
      result.files += 1
      result.bytes += end - offset
    }
    cursors.set(file.path, { offset: old ? file.size : end, state })
  }

  // Credit draws: against a running minimum, in time order.
  let runmin = getState<number | null>(db, 'codex.runmin') ?? null
  const newLots: { at: number; credits: number }[] = []
  for (const event of balances.sort((a, b) => a.at - b.at)) {
    if (runmin === null) {
      runmin = event.balance
      continue
    }
    if (event.balance >= runmin + cfg.lot_min_credits) {
      if (!options.lotTimes.some((time) => Math.abs(time - event.at) < 3600_000)) {
        newLots.push({ at: event.at, credits: event.balance - runmin })
        options.lotTimes.push(event.at)
      }
      runmin = event.balance
    } else if (event.balance < runmin) {
      roll(event.key).drawn += runmin - event.balance
      result.drawn += runmin - event.balance
      runmin = event.balance
    }
  }

  const upsert = db.prepare(
    `INSERT INTO daily (day, provider, model, project, speed, requests, input_tokens, cached_input_tokens, output_tokens, credits_drawn)
     VALUES (?, 'codex', ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (day, provider, model, project, speed) DO UPDATE SET
       requests = requests + excluded.requests,
       input_tokens = input_tokens + excluded.input_tokens,
       cached_input_tokens = cached_input_tokens + excluded.cached_input_tokens,
       output_tokens = output_tokens + excluded.output_tokens,
       credits_drawn = credits_drawn + excluded.credits_drawn`,
  )
  for (const [key, entry] of rollups) {
    const [day, model, project, speed] = key.split('\n') as [string, string, string, string]
    upsert.run(
      day,
      model.slice(0, 100),
      project.slice(0, 200),
      speed,
      entry.requests,
      entry.input,
      entry.cached,
      entry.output,
      entry.drawn,
    )
  }
  const lot = db.prepare(
    'INSERT OR IGNORE INTO detected_lots (provider, at, credits) VALUES (?, ?, ?)',
  )
  for (const found of newLots) lot.run('codex', new Date(found.at).toISOString(), found.credits)
  result.newLots = newLots.length
  for (const event of events.sort((a, b) => a.observedAt - b.observedAt))
    if (storeReading(db, event, config.reading_min_interval_s)) result.readings += 1
  const save = db.prepare(
    'INSERT INTO cursors (path, offset, state) VALUES (?, ?, ?) ON CONFLICT (path) DO UPDATE SET offset = excluded.offset, state = excluded.state',
  )
  for (const [path, cursor] of cursors) {
    // A private file's cursor is keyed by a hash, so its path is not stored.
    const key = cursor.state.private ? hashedKey(path) : path
    if (key !== path) db.prepare('DELETE FROM cursors WHERE path = ?').run(path)
    save.run(key, cursor.offset, JSON.stringify(cursor.state))
  }
  putState(db, 'codex.runmin', runmin)
  return result
}

/**
 * Cursors saved before a path or working directory was marked private still hold its path, working
 * directory or session id: re-key them by hash and drop the rest (idempotent; the counts stay).
 */
function hidePrivateCursors(
  db: Database,
  options: CodexOptions,
  saved: Map<string, { offset: number; state: string }>,
): void {
  const drop = db.prepare('DELETE FROM cursors WHERE path = ?')
  const put = db.prepare('INSERT OR REPLACE INTO cursors (path, offset, state) VALUES (?, ?, ?)')
  for (const [path, cursor] of [...saved]) {
    if (path.startsWith('private:')) continue
    const state = JSON.parse(cursor.state) as FileState
    if (!state.private && !options.isPrivate(path) && !options.isPrivate(state.cwd ?? '')) continue
    const hidden: FileState = { ...state, private: true, cwd: undefined }
    if (state.id) hidden.id = sha(state.id)
    drop.run(path)
    saved.delete(path)
    const key = `private:${sha(path)}`
    put.run(key, cursor.offset, JSON.stringify(hidden))
    saved.set(key, { offset: cursor.offset, state: JSON.stringify(hidden) })
  }
}

/** A parsed JSON line, or undefined when it is not JSON. Codex's log shape is its own: every field is checked where used. */
// biome-ignore lint/suspicious/noExplicitAny: provider log lines, read defensively field by field
function safe(line: string): any {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}
