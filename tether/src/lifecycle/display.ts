// How a session is named on screen: one rule for the desktop, the web app and `st`
// (docs/api-v1.md "Display title and badge"). Clients render these fields
// as-is and never compose titles or badge wording themselves.

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Project } from '../projects'
import { getWidget, rootRequestForWidget, type WidgetRow } from './catalog'
import { instructionsLabel, sessionInstructions } from './tui/instructions'

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

/** The session's task: its name, unless that only repeats the project. An
 * unnamed root goes by its work-role name, else its request ID, so roots a
 * coordinator started are told apart before anyone titles them. */
function task(row: WidgetRow, project: string | null): string | null {
  const name = row.name?.trim() || rootName(row.id)
  if (!name || (project && name.toLowerCase() === project.toLowerCase())) return null
  return name
}

function rootName(id: string): string | null {
  const root = rootRequestForWidget(id)
  return root ? root.workRoleDisplayName?.trim() || root.requestId : null
}

/** `Project — Task`; either alone when the other is missing; else `Session <n>`.
 * Chosen instructions follow as `· prompt@revision`. */
export function displayTitle(row: WidgetRow): string {
  const project = projectName(row)
  const parts = [project, task(row, project)].filter(Boolean)
  const title = parts.length ? parts.join(' — ') : `Session ${row.seq}`
  const instructions = sessionInstructions(row.id)
  return instructions ? `${title} · ${instructionsLabel(instructions)}` : title
}

/** `Coordinator` on a coordinator; `↳ <coordinator>` on a session it launched. */
export function badge(row: WidgetRow): Badge | null {
  const color = row.coordinatorColor ?? FALLBACK_BADGE_COLOR
  if (row.coordinator) return { kind: 'coordinator', text: 'Coordinator', color }
  if (!row.coordinatorId) return null
  return { kind: 'child', text: `↳ ${leadName(row.coordinatorId) ?? 'Coordinator'}`, color }
}

/** What a lane's badge calls its coordinator `id`: the lead's task or
 * project; null when the lead is unknown here or unnamed. */
export function leadName(id: string): string | null {
  const lead = getWidget(id)
  if (!lead) return null
  const project = projectName(lead)
  return (task(lead, project) ?? project) || null
}
