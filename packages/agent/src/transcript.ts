// agent.db: one row per run, every message of its conversation (assistant turns carry
// the model asked, the model that answered, the outcome and disjoint usage tokens),
// every tool call, and every handoff between models. Written as the run goes.
//
// The messages rows are also the run's Pi session: each row is one Pi session entry (a
// message, or a compaction with its summary), numbered by seq, so a run can be resumed or
// branched at a turn, and Pi's compaction and context builder read them unchanged.

import { join } from 'node:path'
import { type Database, openDatabase } from '@aico/store'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'

export const MIGRATIONS = [
  `CREATE TABLE runs (
     id TEXT PRIMARY KEY,
     role TEXT NOT NULL,
     cwd TEXT NOT NULL,
     task TEXT NOT NULL,
     chain TEXT NOT NULL DEFAULT '[]',
     started_at TEXT NOT NULL,
     ended_at TEXT,
     outcome TEXT,
     outcome_detail TEXT,
     input INTEGER NOT NULL DEFAULT 0,
     cache_read INTEGER NOT NULL DEFAULT 0,
     cache_write INTEGER NOT NULL DEFAULT 0,
     output INTEGER NOT NULL DEFAULT 0,
     tool_calls INTEGER NOT NULL DEFAULT 0,
     wall_ms INTEGER
   ) STRICT;
   CREATE TABLE messages (
     run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
     seq INTEGER NOT NULL,
     role TEXT NOT NULL,
     model TEXT,
     served_model TEXT,
     stop_reason TEXT,
     outcome TEXT,
     content TEXT NOT NULL,
     input INTEGER,
     cache_read INTEGER,
     cache_write INTEGER,
     output INTEGER,
     at TEXT NOT NULL,
     PRIMARY KEY (run_id, seq)
   ) STRICT;
   CREATE TABLE tool_calls (
     run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
     call_id TEXT NOT NULL,
     name TEXT NOT NULL,
     args TEXT NOT NULL,
     is_error INTEGER,
     result_chars INTEGER,
     blocked TEXT,
     started_at TEXT NOT NULL,
     ended_at TEXT,
     PRIMARY KEY (run_id, call_id)
   ) STRICT;
   CREATE TABLE handoffs (
     run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
     seq INTEGER NOT NULL,
     at TEXT NOT NULL,
     from_model TEXT NOT NULL,
     to_model TEXT NOT NULL,
     reason TEXT NOT NULL,
     handoff_tokens INTEGER NOT NULL,
     context_messages INTEGER NOT NULL,
     context_tokens INTEGER NOT NULL,
     PRIMARY KEY (run_id, seq)
   ) STRICT;`,
  // Tool calls get their own sequence: providers may reuse a call id every turn.
  `CREATE TABLE tool_calls_v2 (
     run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
     seq INTEGER NOT NULL,
     call_id TEXT NOT NULL,
     name TEXT NOT NULL,
     args TEXT NOT NULL,
     is_error INTEGER,
     result_chars INTEGER,
     blocked TEXT,
     started_at TEXT NOT NULL,
     ended_at TEXT,
     PRIMARY KEY (run_id, seq)
   ) STRICT;
   INSERT INTO tool_calls_v2
     SELECT run_id, row_number() OVER (PARTITION BY run_id ORDER BY started_at, rowid) - 1, call_id,
            name, args, is_error, result_chars, blocked, started_at, ended_at
     FROM tool_calls;
   DROP TABLE tool_calls;
   ALTER TABLE tool_calls_v2 RENAME TO tool_calls;
   CREATE INDEX tool_calls_call ON tool_calls (run_id, call_id);`,
  // Resume, branches and compaction: `meta` is the message without its content (or a
  // compaction's first kept seq, tokens and file lists), `turn` the assistant turn a row
  // belongs to; a branch names the run and turn it forked from.
  `ALTER TABLE runs ADD COLUMN parent_id TEXT;
   ALTER TABLE runs ADD COLUMN branch_turn INTEGER;
   ALTER TABLE messages ADD COLUMN turn INTEGER;
   ALTER TABLE messages ADD COLUMN meta TEXT;`,
]

export function agentDbPath(dataDir: string): string {
  return join(dataDir, 'agent.db')
}

/** Opens (creating and migrating) agent.db; `':memory:'` for tests. */
export function openAgentDb(path: string): Database {
  const db = openDatabase(path, MIGRATIONS)
  db.exec('PRAGMA foreign_keys = ON')
  return db
}

export interface Tokens {
  input: number
  cache_read: number
  cache_write: number
  output: number
}

export interface MessageRow {
  role: string
  /** The whole message as the model saw it (for resume); `content` is what is stored. */
  message?: AgentMessage
  model?: string | null
  served_model?: string | null
  stop_reason?: string | null
  outcome?: unknown
  content: unknown
  usage?: Tokens | null
}

export interface HandoffRow {
  from_model: string
  to_model: string
  reason: string
  handoff_tokens: number
  context_messages: number
  context_tokens: number
}

export interface CompactionRow {
  summary: string
  /** The seq of the first message kept after the summary. */
  firstKeptSeq: number
  tokensBefore: number
  details?: unknown
  model: string
}

/** A run as stored: what resume and branch start from. */
export interface StoredRun {
  id: string
  role: string
  cwd: string
  task: string
  chain: string
  ended_at: string | null
  outcome: string | null
  parent_id: string | null
  branch_turn: number | null
}

interface StoredMessage {
  seq: number
  role: string
  turn: number | null
  meta: string | null
  content: string
  at: string
}

const now = () => new Date().toISOString()

/** The run with this id, or the one run whose id starts with it. */
export function findRun(db: Database, idOrPrefix: string): StoredRun {
  const like = `${idOrPrefix.replace(/[\\%_]/g, '\\$&')}%`
  const rows = db
    .prepare(
      "SELECT * FROM runs WHERE id = ? OR id LIKE ? ESCAPE '\\' ORDER BY id = ? DESC LIMIT 2",
    )
    .all(idOrPrefix, like, idOrPrefix) as unknown as StoredRun[]
  const [first, second] = rows
  if (!first) throw new Error(`no run '${idOrPrefix}' in agent.db`)
  if (second && first.id !== idOrPrefix)
    throw new Error(`'${idOrPrefix}' matches more than one run`)
  return first
}

/** The Pi session entry a stored row stands for. */
function entryOf(row: StoredMessage, parentId: string | null): SessionEntry {
  if (row.meta === null)
    throw new Error('this run was recorded before resume support; it cannot be resumed')
  const meta = JSON.parse(row.meta) as Record<string, unknown>
  const base = { id: String(row.seq), parentId, timestamp: row.at }
  if (row.role === 'compaction')
    return {
      ...base,
      type: 'compaction',
      summary: JSON.parse(row.content) as string,
      firstKeptEntryId: String(meta.firstKeptSeq),
      tokensBefore: Number(meta.tokensBefore ?? 0),
      details: meta.details,
    }
  return {
    ...base,
    type: 'message',
    message: { ...meta, content: JSON.parse(row.content) } as unknown as AgentMessage,
  }
}

/** The writer for one run. */
export class Transcript {
  private seq = 0
  private handoffSeq = 0
  private toolSeq = 0
  /** Assistant responses so far: the current turn's number. */
  turn = 0
  /** The newest tool_calls row for each call id. */
  private readonly toolRows = new Map<string, number>()
  /** The run's Pi session entries, oldest first (messages as the model saw them). */
  readonly entries: SessionEntry[] = []

  constructor(
    private readonly db: Database,
    readonly runId: string,
    run: {
      role: string
      cwd: string
      task: string
      chain: unknown
      parentId?: string
      branchTurn?: number
    } | null,
  ) {
    if (run)
      db.prepare(
        'INSERT INTO runs (id, role, cwd, task, chain, started_at, parent_id, branch_turn) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        runId,
        run.role,
        run.cwd,
        run.task,
        JSON.stringify(run.chain),
        now(),
        run.parentId ?? null,
        run.branchTurn ?? null,
      )
  }

  /** An existing run, to go on from where it stopped. */
  static resume(db: Database, runId: string): Transcript {
    const transcript = new Transcript(db, runId, null)
    transcript.load(transcript.rows(runId))
    const max = (sql: string) =>
      Number((db.prepare(sql).get(runId) as { next: number | null }).next ?? 0)
    transcript.toolSeq = max('SELECT max(seq) + 1 AS next FROM tool_calls WHERE run_id = ?')
    transcript.handoffSeq = max('SELECT max(seq) + 1 AS next FROM handoffs WHERE run_id = ?')
    db.prepare(
      'UPDATE runs SET ended_at = NULL, outcome = NULL, outcome_detail = NULL WHERE id = ?',
    ).run(runId)
    return transcript
  }

  /** A new run holding `from`'s conversation up to the end of its turn `turn` (its
   * response and tool results), to go on from there. */
  static branch(
    db: Database,
    from: StoredRun,
    turn: number,
    runId: string,
    task: string,
  ): Transcript {
    const rows = new Transcript(db, from.id, null).rows(from.id)
    const turns = rows.reduce((top, row) => Math.max(top, row.turn ?? 0), 0)
    if (!Number.isInteger(turn) || turn < 1 || turn > turns)
      throw new Error(`run ${from.id} has turns 1 to ${turns}; there is no turn ${turn}`)
    const kept = rows.filter((row) => (row.turn ?? 0) <= turn)
    if (kept.some((row) => row.meta === null))
      throw new Error(`run ${from.id} was recorded before resume support; it cannot be branched`)
    const transcript = new Transcript(db, runId, {
      role: from.role,
      cwd: from.cwd,
      task,
      chain: JSON.parse(from.chain),
      parentId: from.id,
      branchTurn: turn,
    })
    db.prepare(
      `INSERT INTO messages (run_id, seq, role, model, served_model, stop_reason, outcome, content, input,
         cache_read, cache_write, output, at, turn, meta)
       SELECT ?, seq, role, model, served_model, stop_reason, outcome, content, input, cache_read, cache_write,
         output, at, turn, meta FROM messages WHERE run_id = ? AND seq <= ?`,
    ).run(runId, from.id, kept.at(-1)?.seq ?? -1)
    transcript.load(kept)
    return transcript
  }

  private rows(runId: string): StoredMessage[] {
    return this.db
      .prepare(
        'SELECT seq, role, turn, meta, content, at FROM messages WHERE run_id = ? ORDER BY seq',
      )
      .all(runId) as unknown as StoredMessage[]
  }

  private load(rows: StoredMessage[]): void {
    for (const row of rows) {
      this.entries.push(entryOf(row, this.entries.at(-1)?.id ?? null))
      this.seq = row.seq + 1
      this.turn = Math.max(this.turn, row.turn ?? 0)
    }
  }

  private insert(
    role: string,
    content: unknown,
    meta: unknown,
    turn: number,
    extra: Omit<MessageRow, 'role' | 'content' | 'message'> = {},
  ): number {
    const seq = this.seq++
    const usage = extra.usage
    this.db
      .prepare(
        `INSERT INTO messages (run_id, seq, role, model, served_model, stop_reason, outcome, content,
           input, cache_read, cache_write, output, at, turn, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.runId,
        seq,
        role,
        extra.model ?? null,
        extra.served_model ?? null,
        extra.stop_reason ?? null,
        extra.outcome ? JSON.stringify(extra.outcome) : null,
        JSON.stringify(content),
        usage?.input ?? null,
        usage?.cache_read ?? null,
        usage?.cache_write ?? null,
        usage?.output ?? null,
        now(),
        turn,
        meta === undefined ? null : JSON.stringify(meta),
      )
    return seq
  }

  message(row: MessageRow): void {
    // A prompt starts the next turn; a response is that turn; tool results belong to it.
    if (row.role === 'assistant') this.turn++
    const turn = row.role === 'user' ? this.turn + 1 : this.turn
    const { content: _content, ...meta } = (row.message ?? { role: row.role }) as unknown as Record<
      string,
      unknown
    >
    const seq = this.insert(row.role, row.content, meta, turn, row)
    if (row.message)
      this.entries.push({
        type: 'message',
        id: String(seq),
        parentId: this.entries.at(-1)?.id ?? null,
        timestamp: now(),
        message: row.message,
      })
  }

  /** A compaction: Pi's summary replaces the messages before `firstKeptSeq`. */
  compaction(row: CompactionRow): void {
    const seq = this.insert(
      'compaction',
      row.summary,
      { firstKeptSeq: row.firstKeptSeq, tokensBefore: row.tokensBefore, details: row.details },
      this.turn,
      { model: row.model },
    )
    this.entries.push({
      type: 'compaction',
      id: String(seq),
      parentId: this.entries.at(-1)?.id ?? null,
      timestamp: now(),
      summary: row.summary,
      firstKeptEntryId: String(row.firstKeptSeq),
      tokensBefore: row.tokensBefore,
      details: row.details,
    })
  }

  toolStart(callId: string, name: string, args: unknown): void {
    const seq = this.toolSeq++
    this.toolRows.set(callId, seq)
    this.db
      .prepare(
        'INSERT INTO tool_calls (run_id, seq, call_id, name, args, started_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(this.runId, seq, callId, name, JSON.stringify(args ?? {}), now())
  }

  toolEnd(callId: string, isError: boolean, resultChars: number): void {
    this.db
      .prepare(
        'UPDATE tool_calls SET is_error = ?, result_chars = ?, ended_at = ? WHERE run_id = ? AND seq = ?',
      )
      .run(isError ? 1 : 0, resultChars, now(), this.runId, this.toolRows.get(callId) ?? -1)
  }

  blocked(callId: string, reason: string): void {
    this.db
      .prepare('UPDATE tool_calls SET blocked = ? WHERE run_id = ? AND seq = ?')
      .run(reason, this.runId, this.toolRows.get(callId) ?? -1)
  }

  handoff(row: HandoffRow): void {
    this.db
      .prepare(
        `INSERT INTO handoffs (run_id, seq, at, from_model, to_model, reason, handoff_tokens, context_messages,
           context_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.runId,
        this.handoffSeq++,
        now(),
        row.from_model,
        row.to_model,
        row.reason,
        row.handoff_tokens,
        row.context_messages,
        row.context_tokens,
      )
  }

  /** Records the run's end; totals and tool calls are added to what earlier prompts of the run spent. */
  finish(
    outcome: string,
    detail: unknown,
    totals: Tokens,
    toolCalls: number,
    wallMs: number,
  ): void {
    this.db
      .prepare(
        `UPDATE runs SET ended_at = ?, outcome = ?, outcome_detail = ?, input = input + ?, cache_read = cache_read + ?,
           cache_write = cache_write + ?, output = output + ?, tool_calls = tool_calls + ?,
           wall_ms = coalesce(wall_ms, 0) + ? WHERE id = ?`,
      )
      .run(
        now(),
        outcome,
        detail === undefined ? null : JSON.stringify(detail),
        totals.input,
        totals.cache_read,
        totals.cache_write,
        totals.output,
        toolCalls,
        wallMs,
        this.runId,
      )
  }
}
