// How a session is named on screen: one rule for Aico, A-Term and `st`
// (docs/api-v1.md "Display title and badge"). Clients render these fields
// as-is and never compose titles or badge wording themselves.

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Project } from '../projects'
import { getWidget, type WidgetRow } from './catalog'

export const PERSONAL_WORKSPACE_NAME = 'Personal Workspace'
/** A coordinator or lane from before colours were recorded. */
export const FALLBACK_BADGE_COLOR = '#6fa8ff'

export interface Badge {
  kind: 'coordinator' | 'child'
  text: string
  color: string
}

let personalWorkspaceRoot = join(homedir(), '.local', 'share', 'aico', 'personal-workspace')
let namesById = new Map<string, string>()
let namesByRoot = new Map<string, string>()

/** Learn project names from the project list; true when any name changed. */
export function rememberProjects(projects: readonly Project[]): boolean {
  const byId = new Map(projects.map((project) => [project.id, project.name]))
  const byRoot = new Map(projects.map((project) => [project.root, project.name]))
  const same = (a: Map<string, string>, b: Map<string, string>) =>
    a.size === b.size && [...a].every(([key, value]) => b.get(key) === value)
  if (same(byId, namesById) && same(byRoot, namesByRoot)) return false
  namesById = byId
  namesByRoot = byRoot
  return true
}

/** Test hook: the Personal Workspace root under another home. */
export function setPersonalWorkspaceRoot(root: string): void {
  personalWorkspaceRoot = root
}

export function projectName(row: WidgetRow): string | null {
  if (row.projectId && namesById.has(row.projectId)) return namesById.get(row.projectId) ?? null
  if (!row.projectRoot) return null
  if (row.projectRoot === personalWorkspaceRoot) return PERSONAL_WORKSPACE_NAME
  return namesByRoot.get(row.projectRoot) ?? null
}

/** The session's task: its name, unless that only repeats the project. */
function task(row: WidgetRow, project: string | null): string | null {
  const name = row.name?.trim()
  if (!name || (project && name.toLowerCase() === project.toLowerCase())) return null
  return name
}

/** `Project — Task`; either alone when the other is missing; else `Session <n>`. */
export function displayTitle(row: WidgetRow): string {
  const project = projectName(row)
  const parts = [project, task(row, project)].filter(Boolean)
  return parts.length ? parts.join(' — ') : `Session ${row.seq}`
}

/** `Coordinator` on a coordinator; `↳ <coordinator>` on a session it launched. */
export function badge(row: WidgetRow): Badge | null {
  const color = row.coordinatorColor ?? FALLBACK_BADGE_COLOR
  if (row.coordinator) return { kind: 'coordinator', text: 'Coordinator', color }
  if (!row.coordinatorId) return null
  const lead = getWidget(row.coordinatorId)
  const leadProject = lead ? projectName(lead) : null
  const name = (lead && (task(lead, leadProject) ?? leadProject)) || 'Coordinator'
  return { kind: 'child', text: `↳ ${name}`, color }
}
