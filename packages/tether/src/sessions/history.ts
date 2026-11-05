// The session history: one row per conversation a tool kept a transcript for
// (schema v31 `transcripts`). Tether reads each tool's transcript itself, one
// reader per tool (readers/), keeps the totals the owner looks at, and reads
// the events from the file when they are asked for. Nothing here copies a
// conversation.
//
// `scan()` is one pass: it finds the transcripts under the native homes, and
// for each new or grown one reads the lines past where it stopped. A file that
// was rewritten (shorter, or its first or last bytes changed) is read again
// from the start. A tick reads at most `budget` bytes, newest files first, so a
// first run over old files spreads over many ticks.

import { homedir } from 'node:os'
import { basename, delimiter } from 'node:path'
import { completeEnd, edgeHash, fileFacts, readBackward, readForward } from './lines'
import { READERS, readerFor } from './readers'
import type {
  Fold,
  HistoryTool,
  Outcome,
  Reader,
  SessionEvent,
  TranscriptFile,
  Usage,
} from './types'

export interface HistoryOptions {
  /** Native homes whose transcripts are read. */
  homes: string[]
  now?: () => number
  /** The project a working directory belongs to, or null. */
  projectOf?: (cwd: string) => string | null
  /** A transcript whose path or working directory matches is never read. */
  skip?: RegExp[]
  /** New transcripts older than this are not picked up (a known one is always followed). */
  sinceMs?: number
  /** Bytes one `scan()` reads at most. */
  budget?: number
  /** Rows idle longer than this go. */
  keepMs?: number
}

export interface SessionSummary {
  id: string
  tool: HistoryTool
  parentId: string | null
  project: string | null
  cwd: string | null
  model: string | null
  startedAt: number | null
  endedAt: number | null
  outcome: Outcome | null
  tokens: Tokens
  toolCalls: number
  filesWritten: number
}

export interface Tokens {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
}

export interface SessionDetail extends SessionSummary {
  path: string
  files: { path: string; writes: number }[]
  /** Subagent transcripts of this conversation: their count and token total. */
  subagents: { count: number; tokens: Tokens; toolCalls: number }
  /** A pushed run's turns and the model that ran each (the Aico agent); absent otherwise. */
  turns?: RunTurn[]
}

/** The tool that pushes its runs instead of keeping a transcript Tether reads. */
export const PUSHED_TOOL = 'aico-agent'

export interface RunTurn {
  turn: number
  model: string
  /** How the turn ended (`stop`, `toolUse`, `error`...). */
  stop: string
}

/** What `aico agent run` pushes at its start and end (`PUT /v1/history/aico-agent/:run`). */
export interface PushedRun {
  chat?: { title: string; state: string; updatedAt: number }
  runId: string
  cwd: string
  role: string | null
  startedAt: number
  /** Null while a prompt runs. */
  endedAt: number | null
  outcome: Outcome | null
  tokens: Tokens
  toolCalls: number
  turns: RunTurn[]
}

export interface EventPage {
  items: SessionEvent[]
  /** Pass as `before` for the older events; null: this is the start. */
  older: number | null
  /** Pass as `from` for newer events past this page; null: this is the end. */
  newer: number | null
  size: number
}

const DAY = 24 * 3600_000
const SLICE = 4 << 20

interface Row {
  id: string
  tool: string
  path: string
  parent_id: string | null
  project: string | null
  cwd: string | null
  model: string | null
  started_at: number | null
  ended_at: number | null
  outcome: Outcome | null
  input_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  output_tokens: number
  tool_calls: number
  ignored: number
  read_offset: number
  file_size: number
  file_mtime: number
  file_inode: number
  head_hash: string | null
  tail_hash: string | null
  reader_state: string | null
}

interface Known {
  id: string
  path: string
  file_size: number
  file_mtime: number
  file_inode: number
  ignored: number
}

function tokensOf(row: Row): Tokens {
  return {
    input: row.input_tokens,
    cacheRead: row.cache_read_tokens,
    cacheWrite: row.cache_write_tokens,
    output: row.output_tokens,
  }
}

function yieldLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

export type TranscriptRow = Row

/** The part of the store's SQLite handle the history uses (only the store package imports node:sqlite). */
type SqlValue = string | number | bigint | null

export interface HistoryDb {
  exec(sql: string): void
  prepare(sql: string): {
    all(...args: SqlValue[]): unknown[]
    get(...args: SqlValue[]): unknown
    run(...args: SqlValue[]): unknown
  }
}

export class History {
  private readonly now: () => number
  private readonly options: Required<Omit<HistoryOptions, 'now' | 'projectOf'>> &
    Pick<HistoryOptions, 'projectOf'>

  constructor(
    private readonly db: HistoryDb,
    options: HistoryOptions,
  ) {
    this.now = options.now ?? Date.now
    this.options = {
      homes: options.homes,
      projectOf: options.projectOf,
      skip: options.skip ?? [],
      sinceMs: options.sinceMs ?? 3 * DAY,
      budget: options.budget ?? 48 << 20,
      keepMs: options.keepMs ?? 90 * DAY,
    }
  }

  // --- ingestion ------------------------------------------------------------

  /** Bind an observed native conversation to the workload Tether owns. */
  bind(session: string, tool: string, nativeId: string): void {
    if (tool === 'claude') tool = 'claude-code'
    this.db
      .prepare(`INSERT INTO transcript_owners (transcript_id, session_id, ended_at)
      VALUES (?, ?, (SELECT retired_at FROM retired_session_ids WHERE id = ?))
      ON CONFLICT(transcript_id) DO UPDATE SET session_id = excluded.session_id,
      ended_at = CASE WHEN session_id = excluded.session_id THEN coalesce(ended_at, excluded.ended_at) ELSE excluded.ended_at END
      WHERE session_id != excluded.session_id OR (ended_at IS NULL AND excluded.ended_at IS NOT NULL)`)
      .run(`${tool}:${nativeId}`, session, session)
  }

  endOwned(session: string): void {
    this.db
      .prepare(
        'UPDATE transcript_owners SET ended_at = ? WHERE session_id = ? AND ended_at IS NULL',
      )
      .run(this.now(), session)
    this.settleEnded()
  }

  private settleEnded(): void {
    this.db.exec(`UPDATE transcripts SET outcome = 'aborted'
      WHERE ignored = 0 AND outcome IS NULL AND id IN
      (SELECT transcript_id FROM transcript_owners WHERE ended_at IS NOT NULL)`)
  }

  endRetired(): void {
    this.db.exec(`UPDATE transcript_owners SET ended_at =
      (SELECT retired_at FROM retired_session_ids WHERE id = transcript_owners.session_id)
      WHERE ended_at IS NULL AND session_id IN (SELECT id FROM retired_session_ids)`)
    this.settleEnded()
  }

  /** One pass over the transcripts; returns how many it read from. */
  async scan(): Promise<{ files: number; bytes: number }> {
    const known = new Map<string, Known>()
    for (const row of this.db
      .prepare('SELECT id, path, file_size, file_mtime, file_inode, ignored FROM transcripts')
      .all() as unknown as Known[]) {
      known.set(row.path, row)
    }
    const due: { reader: Reader; file: TranscriptFile; mtime: number }[] = []
    const cutoff = this.now() - this.options.sinceMs
    for (const home of this.options.homes) {
      for (const reader of READERS) {
        for (const file of reader.discover(home)) {
          const facts = fileFacts(file.path)
          if (!facts) continue
          const seen = known.get(file.path)
          if (seen) {
            if (
              seen.file_size === facts.size &&
              seen.file_mtime === facts.mtime &&
              seen.file_inode === facts.inode
            ) {
              continue
            }
          } else if (facts.mtime < cutoff) continue
          due.push({ reader, file, mtime: facts.mtime })
        }
      }
    }
    due.sort((a, b) => b.mtime - a.mtime)
    let bytes = 0
    let files = 0
    for (const item of due) {
      if (bytes >= this.options.budget) break
      files += 1
      bytes += await this.follow(item.reader, item.file, this.options.budget - bytes)
      await yieldLoop()
    }
    this.prune()
    this.settleEnded()
    return { files, bytes }
  }

  private blocked(text: string): boolean {
    return this.options.skip.some((pattern) => pattern.test(text))
  }

  /** Reads one transcript from where it stopped; returns the bytes read. */
  private async follow(reader: Reader, file: TranscriptFile, budget: number): Promise<number> {
    const facts = fileFacts(file.path)
    if (!facts) return 0
    const id = `${reader.tool}:${reader.nativeIdOf(file.path)}`
    const row = this.db.prepare('SELECT * FROM transcripts WHERE path = ?').get(file.path) as
      | Row
      | undefined
    if (row?.ignored) {
      this.touch(row.path, facts)
      return 0
    }
    if (!row && this.blocked(file.path)) {
      this.insertIgnored(id, reader.tool, file.path, facts)
      return 0
    }
    let offset = row?.read_offset ?? 0
    let state: Record<string, unknown> = row?.reader_state
      ? (JSON.parse(row.reader_state) as Record<string, unknown>)
      : reader.initialState()
    let totals = row ? { ...row } : this.blankRow(id, reader.tool, file, facts)
    let rewritten = false
    if (row && offset > 0) {
      const same =
        facts.size >= offset &&
        edgeHash(file.path, 'head', offset) === row.head_hash &&
        edgeHash(file.path, 'tail', offset) === row.tail_hash
      if (!same) {
        rewritten = true
        offset = 0
        state = reader.initialState()
        totals = this.blankRow(id, reader.tool, file, facts)
      }
    }
    const written = new Map<string, number>()
    let spent = 0
    let blockedCwd = false
    while (spent < budget && offset < facts.size) {
      const slice = Math.min(SLICE, budget - spent)
      const before = offset
      const { end } = readForward(file.path, offset, slice, (line) => {
        if (!line.text || reader.skip?.(line.text)) return true
        let record: unknown
        try {
          record = JSON.parse(line.text)
        } catch {
          return true
        }
        if (!record || typeof record !== 'object' || Array.isArray(record)) return true
        const { fold } = reader.read(record as Record<string, unknown>, state, false)
        applyFold(totals, fold, written)
        if (!blockedCwd && totals.cwd && this.blocked(totals.cwd)) blockedCwd = true
        return !blockedCwd
      })
      if (end === before) break // only a partial line is there so far
      spent += end - before
      offset = end
      if (blockedCwd) break
      await yieldLoop()
    }
    if (blockedCwd) {
      this.db.prepare('DELETE FROM transcripts WHERE path = ?').run(file.path)
      this.insertIgnored(id, reader.tool, file.path, facts)
      return spent
    }
    if (!totals.project && totals.cwd) {
      totals.project = this.options.projectOf?.(totals.cwd) ?? basename(totals.cwd)
    }
    totals.parent_id = file.parentNativeId ? `${reader.tool}:${file.parentNativeId}` : null
    totals.read_offset = offset
    // A read the budget cut short saves the size it reached, so the next scan sees the
    // file as changed and carries on; a partial last line waits for the file to grow.
    totals.file_size = spent >= budget && offset < facts.size ? offset : facts.size
    totals.file_mtime = facts.mtime
    totals.file_inode = facts.inode
    totals.head_hash = edgeHash(file.path, 'head', offset)
    totals.tail_hash = edgeHash(file.path, 'tail', offset)
    totals.reader_state = JSON.stringify(state)
    this.save(totals, written, rewritten)
    return spent
  }

  private blankRow(
    id: string,
    tool: string,
    file: TranscriptFile,
    facts: ReturnType<typeof fileFacts>,
  ): Row {
    return {
      id,
      tool,
      path: file.path,
      parent_id: null,
      project: null,
      cwd: null,
      model: null,
      started_at: null,
      ended_at: null,
      outcome: null,
      input_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      output_tokens: 0,
      tool_calls: 0,
      ignored: 0,
      read_offset: 0,
      file_size: facts?.size ?? 0,
      file_mtime: facts?.mtime ?? 0,
      file_inode: facts?.inode ?? 0,
      head_hash: null,
      tail_hash: null,
      reader_state: null,
    }
  }

  private insertIgnored(
    id: string,
    tool: string,
    path: string,
    facts: NonNullable<ReturnType<typeof fileFacts>>,
  ): void {
    this.db
      .prepare(
        `INSERT INTO transcripts (id, tool, native_id, path, ignored, file_size, file_mtime, file_inode)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET ignored = 1, path = excluded.path`,
      )
      .run(id, tool, id.slice(tool.length + 1), path, facts.size, facts.mtime, facts.inode)
  }

  private touch(path: string, facts: NonNullable<ReturnType<typeof fileFacts>>): void {
    this.db
      .prepare(
        'UPDATE transcripts SET file_size = ?, file_mtime = ?, file_inode = ? WHERE path = ?',
      )
      .run(facts.size, facts.mtime, facts.inode, path)
  }

  private save(row: Row, written: Map<string, number>, reset: boolean): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const exists = this.db.prepare('SELECT 1 FROM transcripts WHERE id = ?').get(row.id)
      if (!exists) {
        this.db
          .prepare(
            `INSERT INTO transcripts (id, tool, native_id, path, file_size, file_mtime, file_inode)
             VALUES (?, ?, ?, ?, 0, 0, 0)`,
          )
          .run(row.id, row.tool, row.id.slice(row.tool.length + 1), row.path)
      }
      this.db
        .prepare(
          `UPDATE transcripts SET parent_id = ?, project = ?, cwd = ?, model = ?, path = ?,
             started_at = ?, ended_at = ?, outcome = ?, input_tokens = ?, cache_read_tokens = ?,
             cache_write_tokens = ?, output_tokens = ?, tool_calls = ?, read_offset = ?,
             file_size = ?, file_mtime = ?, file_inode = ?, head_hash = ?, tail_hash = ?,
             reader_state = ?
           WHERE id = ?`,
        )
        .run(
          row.parent_id,
          row.project,
          row.cwd,
          row.model,
          row.path,
          row.started_at,
          row.ended_at,
          row.outcome,
          row.input_tokens,
          row.cache_read_tokens,
          row.cache_write_tokens,
          row.output_tokens,
          row.tool_calls,
          row.read_offset,
          row.file_size,
          row.file_mtime,
          row.file_inode,
          row.head_hash,
          row.tail_hash,
          row.reader_state,
          row.id,
        )
      if (reset) this.db.prepare('DELETE FROM transcript_files WHERE transcript_id = ?').run(row.id)
      const upsert = this.db.prepare(
        `INSERT INTO transcript_files (transcript_id, path, writes) VALUES (?, ?, ?)
         ON CONFLICT(transcript_id, path) DO UPDATE SET writes = writes + excluded.writes`,
      )
      for (const [path, writes] of written) upsert.run(row.id, path, writes)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private prune(): void {
    this.db
      .prepare('DELETE FROM transcripts WHERE COALESCE(ended_at, file_mtime) < ?')
      .run(this.now() - this.options.keepMs)
  }

  // --- pushed runs ----------------------------------------------------------

  /** A run the Aico agent pushed: its row replaces what it pushed before. Its path is
   * the command that shows the whole run; its turns are kept in `reader_state`. A run
   * in a skipped folder is not kept: returns false. */
  record(run: PushedRun): boolean {
    if (this.blocked(run.cwd)) return false
    const id = `${PUSHED_TOOL}:${run.runId}`
    const model = run.turns.at(-1)?.model ?? null
    const project = this.options.projectOf?.(run.cwd) ?? basename(run.cwd)
    this.db
      .prepare(
        `INSERT INTO transcripts (id, tool, native_id, path, project, cwd, model, started_at, ended_at,
           outcome, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, tool_calls,
           file_mtime, reader_state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET project = excluded.project, cwd = excluded.cwd,
           model = excluded.model, started_at = excluded.started_at, ended_at = excluded.ended_at,
           outcome = excluded.outcome, input_tokens = excluded.input_tokens,
           cache_read_tokens = excluded.cache_read_tokens, cache_write_tokens = excluded.cache_write_tokens,
           output_tokens = excluded.output_tokens, tool_calls = excluded.tool_calls,
           file_mtime = excluded.file_mtime, reader_state = excluded.reader_state`,
      )
      .run(
        id,
        PUSHED_TOOL,
        run.runId,
        `aico agent show ${run.runId}`,
        project,
        run.cwd,
        model,
        run.startedAt,
        run.endedAt,
        run.outcome,
        run.tokens.input,
        run.tokens.cacheRead,
        run.tokens.cacheWrite,
        run.tokens.output,
        run.toolCalls,
        this.now(),
        JSON.stringify({ role: run.role, turns: run.turns, ...(run.chat && { chat: run.chat }) }),
      )
    return true
  }

  /** A pushed run's start and end, by the agent's own run id (its live state). */
  readonly agentRun = (
    runId: string,
  ): { startedAt: number | null; endedAt: number | null } | null => {
    const row = this.db
      .prepare('SELECT started_at, ended_at FROM transcripts WHERE id = ?')
      .get(`${PUSHED_TOOL}:${runId}`) as
      | { started_at: number | null; ended_at: number | null }
      | undefined
    return row ? { startedAt: row.started_at, endedAt: row.ended_at } : null
  }

  // --- reading --------------------------------------------------------------

  list(options: { limit?: number; tool?: string; project?: string } = {}): SessionSummary[] {
    const where = ['ignored = 0', 'parent_id IS NULL', 'cwd IS NOT NULL']
    const args: (string | number)[] = []
    if (options.tool) {
      where.push('tool = ?')
      args.push(options.tool)
    }
    if (options.project) {
      where.push('project = ?')
      args.push(options.project)
    }
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 500)
    const rows = this.db
      .prepare(
        `SELECT t.*, (SELECT count(*) FROM transcript_files f WHERE f.transcript_id = t.id) AS files_written
         FROM transcripts t WHERE ${where.join(' AND ')}
         ORDER BY COALESCE(ended_at, file_mtime) DESC LIMIT ${limit}`,
      )
      .all(...args) as unknown as (Row & { files_written: number })[]
    return rows.map(summaryOf)
  }

  /** A session by its full id or the start of its tool's own id. */
  find(idOrPrefix: string): Row | 'ambiguous' | undefined {
    const exact = this.db
      .prepare('SELECT * FROM transcripts WHERE id = ? AND ignored = 0')
      .get(idOrPrefix)
    if (exact) return exact as unknown as Row
    const like = `${idOrPrefix.replace(/[\\%_]/g, '\\$&')}%`
    const rows = this.db
      .prepare(
        `SELECT * FROM transcripts WHERE ignored = 0 AND (native_id LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\') LIMIT 2`,
      )
      .all(like, like) as unknown as Row[]
    return rows.length > 1 ? 'ambiguous' : rows[0]
  }

  get(row: Row): SessionDetail {
    const files = this.db
      .prepare(
        'SELECT path, writes FROM transcript_files WHERE transcript_id = ? ORDER BY writes DESC, path',
      )
      .all(row.id) as { path: string; writes: number }[]
    const kids = this.db
      .prepare(
        `SELECT count(*) AS count, COALESCE(sum(input_tokens), 0) AS input, COALESCE(sum(cache_read_tokens), 0) AS cacheRead,
                COALESCE(sum(cache_write_tokens), 0) AS cacheWrite, COALESCE(sum(output_tokens), 0) AS output,
                COALESCE(sum(tool_calls), 0) AS toolCalls
         FROM transcripts WHERE parent_id = ? AND ignored = 0`,
      )
      .get(row.id) as unknown as {
      count: number
      input: number
      cacheRead: number
      cacheWrite: number
      output: number
      toolCalls: number
    }
    return {
      ...summaryOf({ ...row, files_written: files.length }),
      ...(row.tool === PUSHED_TOOL && { turns: pushedTurns(row) }),
      path: row.path,
      files,
      subagents: {
        count: kids.count,
        toolCalls: kids.toolCalls,
        tokens: {
          input: kids.input,
          cacheRead: kids.cacheRead,
          cacheWrite: kids.cacheWrite,
          output: kids.output,
        },
      },
    }
  }

  /** Events read from the transcript: the last `limit` before `before` (default: the end), or
   * the first `limit` from `from`. */
  events(
    row: Row,
    options: { limit?: number; before?: number; from?: number },
  ): EventPage | 'gone' {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500)
    if (row.tool === PUSHED_TOOL) return turnEvents(row, limit, options)
    const reader = readerFor(row.tool)
    const facts = fileFacts(row.path)
    if (!reader || !facts) return 'gone'
    const state = reader.initialState()
    const budget = 32 << 20
    const parse = (text: string, offset: number): SessionEvent[] => {
      if (!text || reader.skip?.(text)) return []
      let record: unknown
      try {
        record = JSON.parse(text)
      } catch {
        return []
      }
      if (!record || typeof record !== 'object' || Array.isArray(record)) return []
      return reader
        .read(record as Record<string, unknown>, state, true)
        .events.map((event) => ({ ...event, offset }))
    }
    if (options.from !== undefined) {
      const items: SessionEvent[] = []
      let next = options.from
      readForward(row.path, options.from, budget, (line) => {
        items.push(...parse(line.text, line.start))
        next = line.end
        return items.length < limit
      })
      return {
        items,
        older: options.from > 0 ? options.from : null,
        newer: next < facts.size && next > options.from ? next : null,
        size: facts.size,
      }
    }
    const before = options.before ?? completeEnd(row.path)
    const collected: SessionEvent[][] = []
    let count = 0
    const resume = readBackward(row.path, before, budget, (line) => {
      // Claude's state (message ids) only matters for tokens, so lines read newest first are fine here.
      const found = parse(line.text, line.start)
      if (found.length) {
        collected.push(found)
        count += found.length
      }
      return count < limit
    })
    return {
      items: collected.reverse().flat(),
      older: resume > 0 ? resume : null,
      newer: null,
      size: facts.size,
    }
  }
}

function summaryOf(row: Row & { files_written: number }): SessionSummary {
  return {
    id: row.id,
    tool: row.tool as HistoryTool,
    parentId: row.parent_id,
    project: row.project,
    cwd: row.cwd,
    model: row.model,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    outcome: row.outcome,
    tokens: tokensOf(row),
    toolCalls: row.tool_calls,
    filesWritten: row.files_written,
  }
}

function pushedTurns(row: Row): RunTurn[] {
  try {
    return (JSON.parse(row.reader_state ?? '{}') as { turns?: RunTurn[] }).turns ?? []
  } catch {
    return []
  }
}

/** A pushed run's events: one note per turn naming the model that ran it (its messages
 * stay with the agent: `aico agent show`). An event's offset is its turn's index. */
function turnEvents(
  row: Row,
  limit: number,
  options: { before?: number; from?: number },
): EventPage {
  const all = pushedTurns(row).map(
    (turn, index): SessionEvent => ({
      offset: index,
      at: null,
      role: 'system',
      kind: 'note',
      text: `turn ${turn.turn}: ${turn.model} (${turn.stop})`,
      model: turn.model,
    }),
  )
  const start =
    options.from !== undefined
      ? Math.min(options.from, all.length)
      : Math.max(0, Math.min(options.before ?? all.length, all.length) - limit)
  const end = Math.min(all.length, start + limit)
  return {
    items: all.slice(start, end),
    older: start > 0 ? start : null,
    newer: end < all.length ? end : null,
    size: all.length,
  }
}

function applyFold(row: Row, fold: Fold, written: Map<string, number>): void {
  if (fold.cwd && !row.cwd) row.cwd = fold.cwd
  if (fold.model) row.model = fold.model
  if (fold.at !== undefined) {
    if (row.started_at === null || fold.at < row.started_at) row.started_at = fold.at
    if (row.ended_at === null || fold.at > row.ended_at) row.ended_at = fold.at
  }
  addUsage(row, fold.usage)
  if (fold.usageTotal) setUsage(row, fold.usageTotal)
  if (fold.toolCalls) row.tool_calls += fold.toolCalls
  for (const path of fold.files ?? []) written.set(path, (written.get(path) ?? 0) + 1)
  if (fold.outcome !== undefined) row.outcome = fold.outcome
}

function addUsage(row: Row, usage: Usage | undefined): void {
  if (!usage) return
  row.input_tokens += usage.input
  row.cache_read_tokens += usage.cacheRead
  row.cache_write_tokens += usage.cacheWrite
  row.output_tokens += usage.output
}

function setUsage(row: Row, usage: Usage): void {
  row.input_tokens = usage.input
  row.cache_read_tokens = usage.cacheRead
  row.cache_write_tokens = usage.cacheWrite
  row.output_tokens = usage.output
}

/** The longest project root that contains `cwd`. */
export function projectOfRoots(roots: ReadonlyMap<string, string>): (cwd: string) => string | null {
  return (cwd) => {
    let best: { id: string; length: number } | null = null
    for (const [id, root] of roots) {
      const inside = cwd === root || cwd.startsWith(root.endsWith('/') ? root : `${root}/`)
      if (inside && (!best || root.length > best.length)) best = { id, length: root.length }
    }
    return best?.id ?? null
  }
}

/**
 * The history for a Tether instance. `TETHER_HISTORY_HOMES` (path-list) replaces
 * the one native home (this user's); `TETHER_HISTORY_SKIP` (comma list of words)
 * names projects whose transcripts are never read (default: neri);
 * `TETHER_HISTORY_DAYS` is how far back a first pass looks (default 3).
 */
export function historyFromEnv(
  db: HistoryDb,
  env: NodeJS.ProcessEnv,
  roots: ReadonlyMap<string, string>,
): History {
  const homes = (env.TETHER_HISTORY_HOMES ?? '').split(delimiter).filter(Boolean)
  const words = (env.TETHER_HISTORY_SKIP ?? 'neri')
    .split(',')
    .map((w) => w.trim())
    .filter(Boolean)
  const days = Number(env.TETHER_HISTORY_DAYS)
  return new History(db, {
    homes: homes.length ? homes : [env.HOME ?? homedir()],
    projectOf: projectOfRoots(roots),
    // A whole word, so "generic" does not match "neri".
    skip: words.map(
      (word) =>
        new RegExp(`(?<![a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`, 'i'),
    ),
    sinceMs: Number.isFinite(days) && days > 0 ? days * DAY : undefined,
  })
}

/** How often a pass over the transcripts runs. */
const SCAN_MS = 15_000

export function startHistoryScan(history: History | undefined): void {
  if (!history) return
  let running = false
  const pass = () => {
    if (running) return
    running = true
    history
      .scan()
      .catch((error) => console.error('[tether] session history pass failed:', error))
      .finally(() => {
        running = false
      })
  }
  setTimeout(pass, 2000).unref()
  setInterval(pass, SCAN_MS).unref()
}
