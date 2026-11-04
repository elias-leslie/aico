// The shared delivery fixtures (contracts/context-delivery-fixtures.json) as a
// seeded context.db and deliver() requests, for this package's tests and the
// Tether adapter conformance suite.

import { readFileSync } from 'node:fs'
import { type Database, openContext } from './db'
import { DELIVERY, type DeliverRequest, type DeliveryConfig } from './deliver'

interface FixtureMemory {
  id: string
  scope: string
  scope_id: string
  tier: string
  content: string
  triggers?: string[]
  applicability?: Record<string, unknown>
  created_at: string
}

export interface DeliveryCase {
  name: string
  request: DeliverRequest
  budgetBytes?: number
  sections: string[]
  memories: string[]
  cut: string[]
  over?: boolean
  text?: string
}

export interface DeliveryFixture {
  now: string
  /** The project registry (project_permissions): only these get project scope. */
  projects: string[]
  roles: { name: string; work_roles: string[]; context: string }[]
  prompts: {
    slug: string
    name: string
    kind: string
    is_global: number
    content: string
    context_policy?: Record<string, unknown>
  }[]
  memories: FixtureMemory[]
  toolUsage: string
  activity: { at: string; tool: string; name: string }[]
  cases: DeliveryCase[]
}

const fixture = JSON.parse(
  readFileSync(
    new URL('../../../contracts/context-delivery-fixtures.json', import.meta.url),
    'utf8',
  ),
) as DeliveryFixture
export const DELIVERY_FIXTURE: DeliveryFixture = fixture

/** A context.db (in memory unless given a path) holding the fixture's roles,
 * prompts and memories. */
export function fixtureDb(path = ':memory:'): Database {
  const db = openContext(path)
  const at = fixture.now
  for (const project of fixture.projects)
    db.prepare('INSERT INTO project_permissions (project_id, updated_at) VALUES (?, ?)').run(
      project,
      at,
    )
  fixture.roles.forEach((role, position) => {
    db.prepare(
      'INSERT INTO roles (name, label, work_roles, context, position, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(role.name, role.name, JSON.stringify(role.work_roles), role.context, position, at)
  })
  for (const prompt of fixture.prompts)
    db.prepare(
      `INSERT INTO prompts (slug, name, content, kind, is_global, context_policy, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      prompt.slug,
      prompt.name,
      prompt.content,
      prompt.kind,
      prompt.is_global,
      prompt.context_policy ? JSON.stringify(prompt.context_policy) : null,
      at,
    )
  for (const memory of fixture.memories)
    db.prepare(
      `INSERT INTO memories (id, scope, scope_id, tier, content, triggers, applicability, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      memory.id,
      memory.scope,
      memory.scope_id,
      memory.tier,
      memory.content,
      JSON.stringify(memory.triggers ?? []),
      JSON.stringify(memory.applicability ?? {}),
      memory.created_at,
      memory.created_at,
    )
  return db
}

/** A case's request with the fixture's computed blocks, and its settings. */
export function fixtureRequest(entry: DeliveryCase): {
  request: DeliverRequest
  settings: DeliveryConfig
} {
  const request: DeliverRequest = {
    ...entry.request,
    toolUsage: fixture.toolUsage,
    activity: fixture.activity.map((a) => ({ ...a, at: Date.parse(a.at) })),
    now: new Date(fixture.now),
  }
  const budgetBytes = entry.budgetBytes
  if (budgetBytes === undefined) return { request, settings: DELIVERY }
  const tools = Object.fromEntries(
    Object.entries(DELIVERY.tools).map(([id, tool]) => [id, { ...tool, budgetBytes }]),
  ) as DeliveryConfig['tools']
  return { request, settings: { ...DELIVERY, tools } }
}
