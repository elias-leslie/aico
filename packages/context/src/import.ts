// The Agent Hub import (cutlist 3.1, M6): copies the live rows into context.db
// and can run again any time (M7's cutover runs it once more), upserting by the
// source id. Carried: active memories (latest revision) and the memory setting,
// enabled prompts (current text), the launch policy's jobs plus the agent rows
// kept as role names (with their prompt links), the context budgets and the
// project permission rows. Everything else stays in Agent Hub for its archive.
//
// The project rows are copied without being read: nothing here prints, logs or
// looks at their values; the result holds counts and hashes only.

import { createHash } from 'node:crypto'
import { transaction } from '@aico/store'
import { type Database, getSetting, putSetting } from './db'
import { localRoles } from './editor'
import { policyFromAgentHub, savePolicy } from './launch'
import { type Memory, putMemory, type Scope, TIERS } from './memory'
import { putPrompt } from './prompts'

export type AgentHubDataset =
  | 'memories'
  | 'memory_settings'
  | 'prompts'
  | 'agents'
  | 'budgets'
  | 'project_rows'
  | 'project_hash'

/** Read-only access to Agent Hub: its bounded export and checkout files. */
export interface AgentHubSource {
  /** Opaque JSON text in source order; agent roles are explicitly curated by Aico. */
  rows(dataset: AgentHubDataset, agentRoles?: readonly string[]): string[]
  /** A file of the Agent Hub checkout, as text. */
  file(path: string): string
}

export const POLICY_FILE = 'backend/app/routing/model_selection_policy.json'
export const WORK_ROLES_FILE = 'backend/app/services/session_roles.json'

/** project_permissions as Agent Hub's table lists its columns (row_to_json keeps this order). */
const PROJECT_COLUMNS = [
  'id',
  'project_id',
  'root_path',
  'updated_at',
  'created_at',
  'daily_cost_budget_usd',
  'monthly_cost_budget_usd',
  'budget_alert_threshold',
] as const

export interface ImportResult {
  /** Rows copied this run (counts from Agent Hub). */
  memories: number
  memorySettings: number
  prompts: number
  jobs: number
  namedRoles: number
  rolePrompts: number
  budgets: number
  projectRows: number
  /** Imported rows removed here because Agent Hub archived, disabled or deleted them since the last run. */
  removed: { memories: number; prompts: number }
  /** sha256 of the project rows: in Agent Hub, as received, and as stored here. */
  projectHash: { source: string; received: string; stored: string; match: boolean }
  missingRoles: string[]
}

const rowsOf = <T>(
  source: AgentHubSource,
  dataset: AgentHubDataset,
  agentRoles?: readonly string[],
): T[] => source.rows(dataset, agentRoles).map((text) => JSON.parse(text) as T)

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

function compact(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      ([, item]) => !(Array.isArray(item) && item.length === 0) && item !== null,
    ),
  )
}

interface SourceMemory {
  id: string
  group_id: string | null
  scope: string | null
  scope_id: string | null
  summary: string | null
  content: string
  tags: string[] | null
  tier: number
  pinned: boolean | null
  render_mode: string | null
  trigger_task_types: string[] | null
  applicability: unknown
  loaded_count: number | null
  helpful_count: number | null
  harmful_count: number | null
  version: number | null
  created_at: string
  updated_at: string
}

/** Where Agent Hub serves a memory: its group ('global', 'project-X', 'agent-X'), else its scope columns. */
function scopeOf(row: SourceMemory): { scope: Scope; scopeId: string } {
  const group = row.group_id ?? ''
  if (group === 'global') return { scope: 'global', scopeId: '' }
  for (const scope of ['project', 'agent'] as const)
    if (group.startsWith(`${scope}-`)) return { scope, scopeId: group.slice(scope.length + 1) }
  if (row.scope === 'project' || row.scope === 'agent')
    return { scope: row.scope, scopeId: row.scope_id ?? '' }
  return { scope: 'global', scopeId: '' }
}

function memoryOf(row: SourceMemory): Memory {
  const tier = TIERS[row.tier - 1]
  if (!tier) throw new Error(`memory ${row.id}: unknown tier ${row.tier}`)
  return {
    id: row.id,
    ...scopeOf(row),
    tier,
    summary: row.summary ?? '',
    content: row.content,
    tags: row.tags ?? [],
    triggers: row.trigger_task_types ?? [],
    applicability: compact(row.applicability),
    pinned: row.pinned === true,
    renderMode: row.render_mode,
    loadedCount: row.loaded_count ?? 0,
    helpfulCount: row.helpful_count ?? 0,
    harmfulCount: row.harmful_count ?? 0,
    version: row.version ?? 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** The project rows as stored here, in Agent Hub's row_to_json text, one per line. */
export function storedProjectText(db: Database): string {
  const rows = db
    .prepare(`SELECT ${PROJECT_COLUMNS.join(', ')} FROM project_permissions ORDER BY id`)
    .all() as Record<string, unknown>[]
  return rows
    .map((row) =>
      JSON.stringify(Object.fromEntries(PROJECT_COLUMNS.map((column) => [column, row[column]]))),
    )
    .join('\n')
}

/**
 * Copies Agent Hub's live rows into `db` in one transaction. `agentRoles` are the
 * agent rows kept as role names (the curated list); `now` stamps role rows.
 */
export function importAgentHub(
  db: Database,
  source: AgentHubSource,
  options: { agentRoles: readonly string[]; now: string },
): ImportResult {
  const reason = 'imported from Agent Hub'
  const memories = rowsOf<SourceMemory>(source, 'memories').map(memoryOf)
  const settings = rowsOf<Record<string, unknown>>(source, 'memory_settings')
  const prompts = rowsOf<{
    id: number
    slug: string
    name: string
    description: string | null
    content: string
    prompt_type: string | null
    is_global: boolean | null
    boot_eligible: boolean | null
    context_policy: unknown
    updated_at: string
  }>(source, 'prompts')
  const agents = rowsOf<{
    slug: string
    name: string
    description: string | null
    updated_at: string
    prompt_ids: number[] | null
  }>(source, 'agents', options.agentRoles)
  const budgets = rowsOf<{
    harness: string
    role: string
    warn_tokens: number
    jump_pct: number | null
    note: string | null
    updated_at: string
  }>(source, 'budgets')
  const projectLines = source.rows('project_rows')
  const [sourceHash] = rowsOf<string>(source, 'project_hash')
  const policy = policyFromAgentHub(
    JSON.parse(source.file(POLICY_FILE)),
    JSON.parse(source.file(WORK_ROLES_FILE)),
  )

  // An empty answer is a broken source, not an empty Agent Hub: deleting
  // everything on it would wipe context.db.
  if (memories.length === 0 || prompts.length === 0)
    throw new Error(
      `Agent Hub returned ${memories.length} active memories and ${prompts.length} enabled prompts; nothing was written`,
    )

  let removedMemories = 0
  let removedPrompts = 0
  let links = 0
  transaction(db, () => {
    // Imported rows Agent Hub no longer has active or enabled (archived, disabled or
    // deleted) go first, so a slug reused under a new id cannot collide.
    removedMemories = Number(
      db
        .prepare(
          `DELETE FROM memories WHERE id NOT IN (SELECT value FROM json_each(?))
           AND id IN (SELECT memory_id FROM memory_revisions WHERE reason = ?)`,
        )
        .run(JSON.stringify(memories.map((memory) => memory.id)), reason).changes,
    )
    removedPrompts = Number(
      db
        .prepare(
          `DELETE FROM prompts WHERE id NOT IN (SELECT value FROM json_each(?))
           AND slug NOT IN (SELECT item FROM context_local_edits WHERE kind = 'prompt')
           AND id IN (SELECT prompt_id FROM prompt_revisions WHERE reason = ?)`,
        )
        .run(JSON.stringify(prompts.map((prompt) => prompt.id)), reason).changes,
    )
    for (const memory of memories) putMemory(db, memory, reason, memory.updatedAt)
    if (settings[0]) putSetting(db, 'memory', settings[0])

    const editedRoles = localRoles(db)
    for (const prompt of prompts) {
      if (
        db
          .prepare("SELECT 1 FROM context_local_edits WHERE kind = 'prompt' AND item = ?")
          .get(prompt.slug)
      )
        continue
      putPrompt(
        db,
        {
          id: prompt.id,
          slug: prompt.slug,
          name: prompt.name,
          description: prompt.description ?? '',
          content: prompt.content,
          kind: prompt.prompt_type ?? 'standard',
          isGlobal: prompt.is_global === true,
          bootEligible: prompt.boot_eligible === true,
          contextPolicy: prompt.context_policy ?? null,
          updatedAt: prompt.updated_at,
        },
        reason,
      )
    }

    savePolicy(db, policy, options.now)
    const putRole = db.prepare(
      `INSERT INTO roles (name, label, description, position, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET label = excluded.label, description = excluded.description,
         context = NULL, tools = '{}', work_roles = '[]', subagent = NULL,
         position = excluded.position, updated_at = excluded.updated_at`,
    )
    const link = db.prepare(
      'INSERT INTO role_prompts (role, prompt_id, position) SELECT ?, id, ? FROM prompts WHERE id = ?',
    )
    agents.forEach((agent, index) => {
      putRole.run(
        agent.slug,
        agent.name,
        agent.description ?? '',
        policy.jobs.length + index,
        agent.updated_at,
      )
      db.prepare('DELETE FROM role_prompts WHERE role = ?').run(agent.slug)
      ;(agent.prompt_ids ?? []).forEach((id, position) => {
        links += Number(link.run(agent.slug, position, id).changes)
      })
    })

    const putBudget = db.prepare(
      'INSERT OR IGNORE INTO context_budgets (harness, role, warn_tokens, jump_pct, note, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    for (const budget of getSetting(db, 'budgets.imported') ? [] : budgets)
      putBudget.run(
        budget.harness,
        budget.role,
        budget.warn_tokens,
        budget.jump_pct,
        budget.note,
        budget.updated_at,
      )
    putSetting(db, 'budgets.imported', true)
    for (const role of editedRoles) {
      db.prepare(
        'UPDATE roles SET label = ?, description = ?, context = ?, updated_at = ? WHERE name = ?',
      ).run(role.label, role.description, role.context, role.updated_at, role.name)
      db.prepare('DELETE FROM role_prompts WHERE role = ?').run(role.name)
      role.links.forEach((id, i) => {
        db.prepare(
          'INSERT OR IGNORE INTO role_prompts SELECT ?, id, ? FROM prompts WHERE id = ?',
        ).run(role.name, i, id)
      })
    }

    db.exec('DELETE FROM project_permissions')
    const putProject = db.prepare(
      `INSERT INTO project_permissions (${PROJECT_COLUMNS.join(', ')}) VALUES (${PROJECT_COLUMNS.map(() => '?').join(', ')})`,
    )
    for (const line of projectLines) {
      const row = JSON.parse(line) as Record<string, string | number | null>
      putProject.run(...PROJECT_COLUMNS.map((column) => row[column] ?? null))
    }
  })

  const received = sha256(projectLines.join('\n'))
  const stored = sha256(storedProjectText(db))
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n
  return {
    memories: memories.length,
    memorySettings: settings.length,
    prompts: prompts.length,
    jobs: policy.jobs.length,
    namedRoles: agents.length,
    rolePrompts: links,
    budgets: count('SELECT count(*) AS n FROM context_budgets'),
    projectRows: count('SELECT count(*) AS n FROM project_permissions'),
    removed: { memories: removedMemories, prompts: removedPrompts },
    projectHash: {
      source: sourceHash ?? '',
      received,
      stored,
      match: sourceHash === received && received === stored,
    },
    missingRoles: options.agentRoles.filter((slug) => !agents.some((agent) => agent.slug === slug)),
  }
}
