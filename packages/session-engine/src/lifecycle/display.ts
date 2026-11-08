// How a session is named on screen: one rule for the desktop, the web app and `st`
// (docs/api-v1.md "Display title and badge"). Clients render these fields
// as-is and never compose titles or badge wording themselves.

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Project } from '../project'
import { getWidget, rootRequestForWidget, type WidgetRow } from './catalog'
import { instructionsLabel, sessionInstructions } from './tui/instructions'

const PERSONAL_WORKSPACE_NAME = 'Personal Workspace'
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

function projectName(row: WidgetRow): string | null {
  if (row.projectId && namesById.has(row.projectId)) return namesById.get(row.projectId) ?? null
  if (!row.projectRoot) return null
  if (row.projectRoot === personalWorkspaceRoot) return PERSONAL_WORKSPACE_NAME
  return namesByRoot.get(row.projectRoot) ?? null
}

/** What a session's conversation is called by the tool running in it (`title`: its terminal
 * title, thread or session name) or by what the owner first asked (`prompt`). */
export interface ConversationName {
  title: string | null
  prompt: string | null
  /** What the agent is doing as of its last record (meaningful while it works). */
  doing: string | null
}

let conversationNames: (id: string) => ConversationName | undefined = () => undefined

/** Where to ask what a session's conversation is called (the session history). */
export function useConversationNames(source: (id: string) => ConversationName | undefined): void {
  conversationNames = source
}

/** What the session's conversation says it is doing, one line, or null. */
export function conversationDoing(id: string): string | null {
  return conversationNames(id)?.doing?.trim() || null
}

/** The name a session gets when its owner typed none: the tool's own name for the conversation,
 * else its first prompt (already trimmed). null: none yet. */
export function autoName(id: string): string | null {
  const found = conversationNames(id)
  return found?.title?.trim() || found?.prompt?.trim() || null
}

/** The typed name without a project prefix it was typed with ("Aico — ux-test" under Aico). */
function typedName(row: WidgetRow, project: string | null): string | null {
  const name = row.name?.trim()
  if (!name) return null
  if (project) {
    const prefix = `${project} — `
    if (name.toLowerCase().startsWith(prefix.toLowerCase()) && name.length > prefix.length)
      return name.slice(prefix.length).trim()
  }
  return name
}

/** The session's task: the name its owner typed, else what its tool calls the conversation (a
 * terminal title, thread name, session name), else the work role of a root, else the first prompt,
 * else a root's request ID. A name that only repeats the project is no task. An unnamed root goes
 * by its work-role name, so roots a coordinator started are told apart before anyone titles them. */
function task(row: WidgetRow, project: string | null): string | null {
  const conversation = conversationNames(row.id)
  const name =
    typedName(row, project) ||
    conversation?.title?.trim() ||
    rootName(row.id, true) ||
    conversation?.prompt?.trim() ||
    rootName(row.id, false)
  if (!name || (project && name.toLowerCase() === project.toLowerCase())) return null
  return name
}

/** A root's work-role name, or (not `roleOnly`) its request ID when it has no role. */
function rootName(id: string, roleOnly: boolean): string | null {
  const root = rootRequestForWidget(id)
  if (!root) return null
  return root.workRoleDisplayName?.trim() || (roleOnly ? null : root.requestId)
}

/** The task part of the display title (what follows the project), or null. */
export function taskName(row: WidgetRow): string | null {
  return task(row, projectName(row))
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
