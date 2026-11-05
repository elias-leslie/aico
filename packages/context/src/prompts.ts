// Prompts: reusable instruction text (policies, role prompts, mandates), current
// text plus a revision per version written from here on. Roles link to the
// prompts they are given (role_prompts).

import { createHash } from 'node:crypto'
import { type Database, json } from './db'

export interface Prompt {
  id: number
  slug: string
  name: string
  description: string
  content: string
  /** Agent Hub's prompt_type: standard, agent_system, global_mandate, global_guardrail, chat. */
  kind: string
  isGlobal: boolean
  bootEligible: boolean
  /** Where context delivery may use it (kept as Agent Hub wrote it). */
  contextPolicy: unknown
  version: number
  updatedAt: string
}

interface Row {
  id: number
  slug: string
  name: string
  description: string
  content: string
  kind: string
  is_global: number
  boot_eligible: number
  context_policy: string | null
  version: number
  updated_at: string
}

const COLUMNS =
  'id, slug, name, description, content, kind, is_global, boot_eligible, context_policy, version, updated_at'

function fromRow(row: Row): Prompt {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    content: row.content,
    kind: row.kind,
    isGlobal: row.is_global === 1,
    bootEligible: row.boot_eligible === 1,
    contextPolicy: json(row.context_policy, null),
    version: row.version,
    updatedAt: row.updated_at,
  }
}

/**
 * Writes `prompt` (by id); a changed text becomes the next version with its own
 * revision. The caller holds the transaction.
 */
export function putPrompt(db: Database, prompt: Omit<Prompt, 'version'>, reason: string): void {
  const before = db.prepare('SELECT content, version FROM prompts WHERE id = ?').get(prompt.id) as
    | { content: string; version: number }
    | undefined
  // A prompt removed and later brought back continues its old revision numbers.
  const last = db
    .prepare('SELECT max(version) AS version FROM prompt_revisions WHERE prompt_id = ?')
    .get(prompt.id) as { version: number | null }
  const version =
    before && before.content === prompt.content ? before.version : (last.version ?? 0) + 1
  db.prepare(
    `INSERT INTO prompts (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET slug = excluded.slug, name = excluded.name,
       description = excluded.description, content = excluded.content, kind = excluded.kind,
       is_global = excluded.is_global, boot_eligible = excluded.boot_eligible,
       context_policy = excluded.context_policy, version = excluded.version,
       updated_at = excluded.updated_at`,
  ).run(
    prompt.id,
    prompt.slug,
    prompt.name,
    prompt.description,
    prompt.content,
    prompt.kind,
    prompt.isGlobal ? 1 : 0,
    prompt.bootEligible ? 1 : 0,
    prompt.contextPolicy == null ? null : JSON.stringify(prompt.contextPolicy),
    version,
    prompt.updatedAt,
  )
  db.prepare(
    'INSERT OR IGNORE INTO prompt_revisions (prompt_id, version, content, reason, at) VALUES (?, ?, ?, ?, ?)',
  ).run(prompt.id, version, prompt.content, reason, prompt.updatedAt)
}

/** All prompts by name, optionally only the global (or non-global) ones. */
export function listPrompts(db: Database, filter: { global?: boolean } = {}): Prompt[] {
  const where = filter.global === undefined ? '' : `WHERE is_global = ${filter.global ? 1 : 0}`
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM prompts ${where} ORDER BY name COLLATE NOCASE, slug`)
    .all() as unknown as Row[]
  return rows.map(fromRow)
}

export function getPrompt(db: Database, slug: string): Prompt | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM prompts WHERE slug = ?`).get(slug) as
    | Row
    | undefined
  return row ? fromRow(row) : null
}

/** The prompts a role is given, in order. */
export function rolePrompts(db: Database, role: string): Prompt[] {
  const rows = db
    .prepare(
      `SELECT ${COLUMNS.split(', ')
        .map((column) => `p.${column}`)
        .join(', ')}
       FROM role_prompts r JOIN prompts p ON p.id = r.prompt_id
       WHERE r.role = ? ORDER BY r.position, p.slug`,
    )
    .all(role) as unknown as Row[]
  return rows.map(fromRow)
}

/** Saved Aico versions, in the version-1 root instruction snapshot shape. */
export function promptRevisions(db: Database, slug: string, limit: number) {
  const prompt = getPrompt(db, slug)
  if (!prompt) return null
  const rows = db
    .prepare(
      'SELECT version, content, reason, at FROM prompt_revisions WHERE prompt_id = ? ORDER BY version DESC LIMIT ?',
    )
    .all(prompt.id, limit) as { version: number; content: string; reason: string; at: string }[]
  return rows.map((row) => ({
    id: String(row.version).padStart(4, '0'),
    prompt_name: prompt.name,
    content: row.content,
    content_hash: createHash('sha256').update(row.content).digest('hex'),
    created_at: row.at,
    reason: row.reason,
    version: row.version,
  }))
}
