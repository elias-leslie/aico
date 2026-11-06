// Memories: short learnings and decisions agents are told, each scoped to every
// session (global), one project or one agent. Search is FTS5 over summary, tags
// and content (bm25, summary weighted highest); every write keeps a revision.

import { randomUUID } from 'node:crypto'
import { transaction } from '@aico/store'
import { type Database, json } from './db'

export const TIERS = ['mandate', 'guardrail', 'reference', 'archive'] as const
export type Tier = (typeof TIERS)[number]
export const SCOPES = ['global', 'project', 'agent'] as const
export type Scope = (typeof SCOPES)[number]

export interface Memory {
  id: string
  scope: Scope
  /** The project or agent; '' for global. */
  scopeId: string
  tier: Tier
  summary: string
  content: string
  tags: string[]
  /** Task types the memory is meant for (empty: any). */
  triggers: string[]
  /** Who it is for: audience tags, work roles, profiles (read by context delivery). */
  applicability: Record<string, unknown>
  pinned: boolean
  renderMode: string | null
  loadedCount: number
  helpfulCount: number
  harmfulCount: number
  version: number
  createdAt: string
  updatedAt: string
}

export interface Found extends Memory {
  /** 0-1, higher is a better match (bm25 folded into the range). */
  score: number
}

interface Row {
  id: string
  scope: Scope
  scope_id: string
  tier: Tier
  summary: string
  content: string
  tags: string
  triggers: string
  applicability: string
  pinned: number
  render_mode: string | null
  loaded_count: number
  helpful_count: number
  harmful_count: number
  version: number
  created_at: string
  updated_at: string
}

function fromRow(row: Row): Memory {
  return {
    id: row.id,
    scope: row.scope,
    scopeId: row.scope_id,
    tier: row.tier,
    summary: row.summary,
    content: row.content,
    tags: json(row.tags, []),
    triggers: json(row.triggers, []),
    applicability: json(row.applicability, {}),
    pinned: row.pinned === 1,
    renderMode: row.render_mode,
    loadedCount: row.loaded_count,
    helpfulCount: row.helpful_count,
    harmfulCount: row.harmful_count,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const COLUMNS =
  'id, scope, scope_id, tier, summary, content, tags, triggers, applicability, pinned, render_mode, loaded_count, helpful_count, harmful_count, version, created_at, updated_at'
const M_COLUMNS = COLUMNS.split(', ')
  .map((column) => `m.${column}`)
  .join(', ')

/**
 * Writes `memory` as it is (version included) and records that version as a
 * revision unless it is already recorded. The caller holds the transaction.
 */
export function putMemory(db: Database, memory: Memory, reason: string, at: string): void {
  db.prepare(
    `INSERT INTO memories (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET scope = excluded.scope, scope_id = excluded.scope_id,
       tier = excluded.tier, summary = excluded.summary, content = excluded.content,
       tags = excluded.tags, triggers = excluded.triggers, applicability = excluded.applicability,
       pinned = excluded.pinned, render_mode = excluded.render_mode,
       loaded_count = excluded.loaded_count, helpful_count = excluded.helpful_count,
       harmful_count = excluded.harmful_count, version = excluded.version,
       created_at = excluded.created_at, updated_at = excluded.updated_at`,
  ).run(
    memory.id,
    memory.scope,
    memory.scopeId,
    memory.tier,
    memory.summary,
    memory.content,
    JSON.stringify(memory.tags),
    JSON.stringify(memory.triggers),
    JSON.stringify(memory.applicability),
    memory.pinned ? 1 : 0,
    memory.renderMode,
    memory.loadedCount,
    memory.helpfulCount,
    memory.harmfulCount,
    memory.version,
    memory.createdAt,
    memory.updatedAt,
  )
  db.prepare(
    'INSERT OR IGNORE INTO memory_revisions (memory_id, version, doc, reason, at) VALUES (?, ?, ?, ?, ?)',
  ).run(memory.id, memory.version, JSON.stringify(memory), reason, at)
}

export interface NewMemory {
  content: string
  summary?: string
  tier?: Tier
  scope?: Scope
  scopeId?: string
  tags?: string[]
  triggers?: string[]
  pinned?: boolean
}

/** Saves a new memory (version 1); its id. */
export function addMemory(db: Database, input: NewMemory, now: string): Memory {
  const scope = input.scope ?? 'global'
  if (!input.content.trim()) throw new Error('A memory needs content.')
  if (scope !== 'global' && !input.scopeId) throw new Error(`A ${scope} memory needs --scope-id.`)
  const memory: Memory = {
    id: randomUUID(),
    scope,
    scopeId: scope === 'global' ? '' : (input.scopeId ?? ''),
    tier: input.tier ?? 'reference',
    summary: input.summary ?? '',
    content: input.content,
    tags: input.tags ?? [],
    triggers: input.triggers ?? [],
    applicability: {},
    pinned: input.pinned ?? false,
    renderMode: null,
    loadedCount: 0,
    helpfulCount: 0,
    harmfulCount: 0,
    version: 1,
    createdAt: now,
    updatedAt: now,
  }
  transaction(db, () => putMemory(db, memory, 'created', now))
  return memory
}

/** The memories whose id is or starts with each of `ids` (8-character prefixes work), in that order. */
export function getMemories(
  db: Database,
  ids: readonly string[],
): { found: Memory[]; missing: string[] } {
  const query = db.prepare(`SELECT ${COLUMNS} FROM memories WHERE id LIKE ? ORDER BY id`)
  const found: Memory[] = []
  const missing: string[] = []
  for (const id of ids) {
    const rows = query.all(`${id.toLowerCase().replace(/[%_]/g, '')}%`) as unknown as Row[]
    if (rows.length === 0) missing.push(id)
    for (const row of rows) found.push(fromRow(row))
  }
  return { found, missing }
}

export interface Where {
  tier?: Tier
  /** global: the global memories; project/agent: that scope's own memories; all: every scope. */
  scope?: Scope | 'all'
  scopeId?: string
  tag?: string
}

function whereClause(where: Where, alias: string, withGlobal: boolean) {
  const parts: string[] = []
  const args: string[] = []
  const scope = where.scope ?? 'global'
  if (scope === 'all') parts.push('1 = 1')
  else if (scope === 'global') parts.push(`${alias}.scope = 'global'`)
  else {
    parts.push(
      `(${alias}.scope = ? AND ${alias}.scope_id = ?${withGlobal ? ` OR ${alias}.scope = 'global'` : ''})`,
    )
    args.push(scope, where.scopeId ?? '')
  }
  if (where.tier) {
    parts.push(`${alias}.tier = ?`)
    args.push(where.tier)
  }
  if (where.tag) {
    parts.push(`EXISTS (SELECT 1 FROM json_each(${alias}.tags) WHERE value = ?)`)
    args.push(where.tag)
  }
  return { sql: parts.join(' AND '), args }
}

/** One scope's memories, mandates first, newest first within a tier. */
export function listMemories(
  db: Database,
  where: Where = {},
  page: { limit?: number; offset?: number } = {},
): { memories: Memory[]; next: number | null } {
  const limit = page.limit ?? 50
  const offset = page.offset ?? 0
  const clause = whereClause(where, 'm', false)
  const rows = db
    .prepare(
      `SELECT ${M_COLUMNS} FROM memories m WHERE ${clause.sql}
       ORDER BY CASE m.tier WHEN 'mandate' THEN 0 WHEN 'guardrail' THEN 1 WHEN 'reference' THEN 2 ELSE 3 END,
         m.updated_at DESC, m.id
       LIMIT ? OFFSET ?`,
    )
    .all(...clause.args, limit + 1, offset) as unknown as Row[]
  return {
    memories: rows.slice(0, limit).map(fromRow),
    next: rows.length > limit ? offset + limit : null,
  }
}

/** The words of a search as an FTS5 query: any word may match; bm25 ranks by how many and where. */
function ftsQuery(text: string): string | null {
  const words = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []
  const unique = [...new Set(words)]
  return unique.length ? unique.map((word) => `"${word}"`).join(' OR ') : null
}

/**
 * Best matches first. A project or agent scope also searches the global
 * memories, as every session in that scope is told both.
 *
 * Not the same ranking as `st memory search`: Agent Hub's search is semantic
 * (embeddings), this one is FTS5 words ranked by bm25. On 2026-11-03 the top
 * result matched on 4 of 4 topics, but the top 5 differ; for "deploy service
 * rebuild" Agent Hub's first hit (2b5032f1) is not in this top 5. M7 decides
 * which search `st memory` uses before cutting it over.
 */
export function searchMemories(
  db: Database,
  text: string,
  where: Where = {},
  options: { limit?: number; minScore?: number } = {},
): Found[] {
  const match = ftsQuery(text)
  if (!match) return []
  const clause = whereClause(where, 'm', true)
  const rows = db
    .prepare(
      `SELECT ${M_COLUMNS}, bm25(memories_fts, 5.0, 3.0, 1.0) AS rank
       FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid
       WHERE memories_fts MATCH ? AND ${clause.sql}
       ORDER BY rank, m.id LIMIT ?`,
    )
    .all(match, ...clause.args, options.limit ?? 10) as unknown as (Row & { rank: number })[]
  return rows
    .map((row) => {
      const strength = Math.max(-row.rank, 0)
      return { ...fromRow(row), score: strength / (strength + 1) }
    })
    .filter((found) => found.score >= (options.minScore ?? 0))
}

/**
 * Removes a memory by its full id. Its revisions stay, so the last text can be
 * read back. Returns whether a memory was there.
 */
export function deleteMemory(db: Database, id: string): boolean {
  return Number(db.prepare('DELETE FROM memories WHERE id = ?').run(id).changes) > 0
}
