// agent.db: one row per run, every message of its conversation (assistant turns carry
// the model asked, the model that answered, the outcome and disjoint usage tokens),
// every tool call, and every handoff between models. Written as the run goes.

import { join } from 'node:path'
import { type Database, openDatabase } from '@aico/store'

const MIGRATIONS = [
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

const now = () => new Date().toISOString()

/** The writer for one run. */
export class Transcript {
  private seq = 0
  private handoffSeq = 0

  constructor(
    private readonly db: Database,
    readonly runId: string,
    run: { role: string; cwd: string; task: string; chain: unknown },
  ) {
    db.prepare(
      'INSERT INTO runs (id, role, cwd, task, chain, started_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(runId, run.role, run.cwd, run.task, JSON.stringify(run.chain), now())
  }

  message(row: MessageRow): void {
    const usage = row.usage
    this.db
      .prepare(
        `INSERT INTO messages (run_id, seq, role, model, served_model, stop_reason, outcome, content,
           input, cache_read, cache_write, output, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.runId,
        this.seq++,
        row.role,
        row.model ?? null,
        row.served_model ?? null,
        row.stop_reason ?? null,
        row.outcome ? JSON.stringify(row.outcome) : null,
        JSON.stringify(row.content),
        usage?.input ?? null,
        usage?.cache_read ?? null,
        usage?.cache_write ?? null,
        usage?.output ?? null,
        now(),
      )
  }

  toolStart(callId: string, name: string, args: unknown): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO tool_calls (run_id, call_id, name, args, started_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(this.runId, callId, name, JSON.stringify(args ?? {}), now())
  }

  toolEnd(
    callId: string,
    isError: boolean,
    resultChars: number,
    blocked: string | null = null,
  ): void {
    this.db
      .prepare(
        'UPDATE tool_calls SET is_error = ?, result_chars = ?, blocked = COALESCE(?, blocked), ended_at = ? WHERE run_id = ? AND call_id = ?',
      )
      .run(isError ? 1 : 0, resultChars, blocked, now(), this.runId, callId)
  }

  blocked(callId: string, reason: string): void {
    this.db
      .prepare('UPDATE tool_calls SET blocked = ? WHERE run_id = ? AND call_id = ?')
      .run(reason, this.runId, callId)
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

  finish(
    outcome: string,
    detail: unknown,
    totals: Tokens,
    toolCalls: number,
    wallMs: number,
  ): void {
    this.db
      .prepare(
        `UPDATE runs SET ended_at = ?, outcome = ?, outcome_detail = ?, input = ?, cache_read = ?, cache_write = ?,
           output = ?, tool_calls = ?, wall_ms = ? WHERE id = ?`,
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
