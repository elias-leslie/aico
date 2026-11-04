// Edits take effect on the next delivery. Optimistic versions stop a stale page
// overwriting another edit; the recurring Agent Hub import preserves local work.
import { transaction } from '@aico/store'
import type { Database } from './db'
import { getPrompt, listPrompts, putPrompt } from './prompts'

export class ContextEditError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}
export interface ContextRole {
  name: string
  label: string
  description: string
  context: string | null
  updatedAt: string
  prompts: number[]
}
export function contextCatalog(db: Database) {
  const rows = db
    .prepare(
      'SELECT r.name, r.label, r.description, coalesce(o.mode, r.context) AS context, r.updated_at FROM roles r LEFT JOIN role_context_overrides o ON o.role = r.name ORDER BY r.position, r.name',
    )
    .all() as unknown as {
    name: string
    label: string
    description: string
    context: string | null
    updated_at: string
  }[]
  const links = db.prepare('SELECT prompt_id FROM role_prompts WHERE role = ? ORDER BY position')
  const roles: ContextRole[] = rows.map((r) => ({
    name: r.name,
    label: r.label,
    description: r.description,
    context: r.context,
    updatedAt: r.updated_at,
    prompts: (links.all(r.name) as { prompt_id: number }[]).map((p) => p.prompt_id),
  }))
  return { roles, prompts: listPrompts(db) }
}
const text = (value: unknown, field: string, max: number): string => {
  if (typeof value !== 'string' || value.length > max || !value.trim())
    throw new ContextEditError(422, `${field} is required (up to ${max} characters).`)
  return value
}
export function editPrompt(
  db: Database,
  slug: string,
  value: Record<string, unknown>,
  at: string,
): void {
  transaction(db, () => {
    const prompt = getPrompt(db, slug)
    if (!prompt) throw new ContextEditError(404, 'Prompt not found.')
    if (value.version !== prompt.version || value.updatedAt !== prompt.updatedAt)
      throw new ContextEditError(409, 'This prompt changed. Reload before saving.')
    const name = text(value.name, 'Name', 200)
    const content = text(value.content, 'Text', 200_000)
    const policy = value.contextPolicy
    if (!policy || typeof policy !== 'object' || Array.isArray(policy))
      throw new ContextEditError(422, 'Context policy must be an object.')
    const p = policy as Record<string, unknown>
    if (
      !['global', 'project', 'agent', ''].includes(String(p.scope ?? '')) ||
      (p.targets !== undefined &&
        (!Array.isArray(p.targets) || !p.targets.every((t) => typeof t === 'string')))
    )
      throw new ContextEditError(422, 'Choose a valid scope and list of targets.')
    if (
      (p.scope === 'agent' || p.scope === 'project') &&
      !(Array.isArray(p.targets) && p.targets.length)
    )
      throw new ContextEditError(422, 'This scope needs at least one target.')
    putPrompt(
      db,
      { ...prompt, name, content, contextPolicy: policy, updatedAt: at },
      'Edited in Aico',
    )
    db.prepare('INSERT OR IGNORE INTO context_local_edits VALUES (?, ?)').run('prompt', slug)
  })
}
export function editRole(
  db: Database,
  name: string,
  value: Record<string, unknown>,
  at: string,
): void {
  transaction(db, () => {
    const row = db.prepare('SELECT updated_at FROM roles WHERE name = ?').get(name) as
      | { updated_at: string }
      | undefined
    if (!row) throw new ContextEditError(404, 'Role not found.')
    if (row.updated_at !== value.updatedAt)
      throw new ContextEditError(409, 'This role changed. Reload before saving.')
    const label = text(value.label, 'Name', 200)
    if (typeof value.description !== 'string' || value.description.length > 4000)
      throw new ContextEditError(422, 'Description is too long.')
    if (![null, 'default', 'blank-slate'].includes(value.context as string | null))
      throw new ContextEditError(422, 'Choose a valid context mode.')
    if (
      !Array.isArray(value.prompts) ||
      !value.prompts.every(
        (id) =>
          Number.isSafeInteger(id) &&
          db.prepare('SELECT 1 FROM prompts WHERE id = ?').get(id as number),
      )
    )
      throw new ContextEditError(422, 'Choose existing prompts.')
    db.prepare('UPDATE roles SET label = ?, description = ?, updated_at = ? WHERE name = ?').run(
      label,
      value.description,
      at,
      name,
    )
    // Named roles remain distinct from launch jobs; this only controls delivery.
    if (value.context === null)
      db.prepare('DELETE FROM role_context_overrides WHERE role = ?').run(name)
    else
      db.prepare(
        'INSERT INTO role_context_overrides VALUES (?, ?) ON CONFLICT(role) DO UPDATE SET mode = excluded.mode',
      ).run(name, value.context as string)
    db.prepare('DELETE FROM role_prompts WHERE role = ?').run(name)
    ;[...new Set(value.prompts as number[])].forEach((id, index) => {
      db.prepare('INSERT INTO role_prompts VALUES (?, ?, ?)').run(name, id, index)
    })
    db.prepare('INSERT OR IGNORE INTO context_local_edits VALUES (?, ?)').run('role', name)
  })
}

/** Apply local role context after refreshing the rest of the launch policy. */
export function localRoles(db: Database): {
  name: string
  label: string
  description: string
  context: string | null
  updated_at: string
  links: number[]
}[] {
  return (
    db
      .prepare(`SELECT r.name, r.label, r.description, r.context, r.updated_at FROM roles r
    JOIN context_local_edits e ON e.kind = 'role' AND e.item = r.name`)
      .all() as unknown as {
      name: string
      label: string
      description: string
      context: string | null
      updated_at: string
    }[]
  ).map((r) => ({
    ...r,
    links: (
      db
        .prepare('SELECT prompt_id FROM role_prompts WHERE role = ? ORDER BY position')
        .all(r.name) as { prompt_id: number }[]
    ).map((p) => p.prompt_id),
  }))
}
