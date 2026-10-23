// Sessions in the shape the web UI reads (the Python backend's
// ATermSessionResponse, kept field for field), and what the UI may do to each.
// Every session is a Tether session; Tether words the title and badge.

import type { SessionDescriptor } from 'tether/client'
import type { Link } from './db'
import { HttpError } from './tether'

export const SHELL_MODE = 'shell'

export type AgentState = 'not_started' | 'starting' | 'running' | 'stopped' | 'error'

const ACTIVITY = new Set(['working', 'idle', 'blocked', 'unknown'])
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

export interface WebSession {
  id: string
  name: string
  task: string | null
  badge: { kind: string; text: string; color: string } | null
  is_coordinator: boolean
  coordinator_id: string | null
  user_id: null
  project_id: string | null
  working_dir: string | null
  display_order: number
  mode: string
  session_number: number
  is_alive: boolean
  created_at: string | null
  last_accessed_at: string | null
  agent_state: AgentState
  claude_state: AgentState
  tmux_session_name: string | null
  tmux_session_id: string | null
  tmux_pane_id: string | null
  tmux_socket: string | null
  tmux_source: 'tether'
  tmux_source_label: 'Tether'
  /** No tab of this app shows it (a session another app started). */
  is_external: boolean
  is_root: boolean
  is_legacy: false
  source: 'tether'
  origin: string | null
  status: string | null
  generation: string | null
  pane_id: string | null
  activity: string
  activity_previous: string
  activity_at: number | null
  activity_detail: string | null
  can_rename: boolean
  can_respawn: boolean
  can_end: boolean
}

/** Tether's lifecycle status as the UI's agent badge. */
export function agentStateFor(mode: string, status: string | null): AgentState {
  if (status === 'pending') return 'starting'
  if (status === 'uncertain') return 'error'
  if (mode === SHELL_MODE) return 'not_started'
  return status === 'running' ? 'running' : 'not_started'
}

const iso = (ms: unknown): string | null =>
  typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : null

const activity = (value: unknown): string =>
  typeof value === 'string' && ACTIVITY.has(value) ? value : 'unknown'

function badgeOf(descriptor: SessionDescriptor): WebSession['badge'] {
  const badge = descriptor.badge
  if (!badge || typeof badge !== 'object') return null
  const { kind, text, color } = badge
  if (kind !== 'coordinator' && kind !== 'child') return null
  if (typeof text !== 'string' || !text.trim()) return null
  if (typeof color !== 'string' || !HEX_COLOR.test(color)) return null
  return { kind, text, color }
}

export function fromTether(descriptor: SessionDescriptor, link: Link | null): WebSession {
  const mode = descriptor.tool || SHELL_MODE
  const status = typeof descriptor.status === 'string' ? descriptor.status : null
  const title = descriptor.displayTitle?.trim()
  const task = typeof descriptor.name === 'string' ? descriptor.name.trim() || null : null
  const state = agentStateFor(mode, status)
  const isRoot = !!descriptor.rootRequestId
  const tmux = descriptor.tmux ?? ({} as Partial<SessionDescriptor['tmux']>)
  return {
    id: descriptor.id,
    name: title || descriptor.label || descriptor.id,
    task,
    badge: badgeOf(descriptor),
    is_coordinator: descriptor.coordinator === true,
    coordinator_id: typeof descriptor.coordinatorId === 'string' ? descriptor.coordinatorId : null,
    user_id: null,
    project_id: descriptor.projectId ?? null,
    working_dir: descriptor.projectRoot ?? null,
    display_order: link?.display_order ?? 0,
    mode,
    session_number: 1,
    is_alive: true,
    created_at: iso(descriptor.createdAt),
    last_accessed_at: link?.last_accessed_at ?? null,
    agent_state: state,
    claude_state: state,
    tmux_session_name: tmux.sessionName ?? null,
    tmux_session_id: tmux.sessionId ?? null,
    tmux_pane_id: tmux.paneId ?? null,
    tmux_socket: tmux.socket ?? null,
    tmux_source: 'tether',
    tmux_source_label: 'Tether',
    is_external: link === null,
    is_root: isRoot,
    is_legacy: false,
    source: 'tether',
    origin: descriptor.origin ?? null,
    status,
    generation: descriptor.generation ?? null,
    pane_id: link?.pane_id ?? null,
    activity: activity(descriptor.state),
    activity_previous: activity(descriptor.statePrevious),
    activity_at: typeof descriptor.stateAt === 'number' ? descriptor.stateAt : null,
    activity_detail: typeof descriptor.stateDetail === 'string' ? descriptor.stateDetail : null,
    can_rename: true,
    can_respawn: !isRoot,
    can_end: true,
  }
}

/** Code-point order, as the Python backend sorted (not the locale's). */
export const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** Numbers each project's sessions of one mode by age (1, 2, …), as the UI labels them. */
export function numberSessions(sessions: WebSession[]): void {
  const counters = new Map<string, number>()
  const byAge = [...sessions].sort((a, b) => byText(a.created_at ?? '', b.created_at ?? ''))
  for (const session of byAge) {
    const key = `${session.project_id ?? ''}\0${session.mode}`
    const next = (counters.get(key) ?? 0) + 1
    counters.set(key, next)
    session.session_number = next
  }
}

export function sortSessions(sessions: WebSession[]): WebSession[] {
  return sessions.sort(
    (a, b) => a.display_order - b.display_order || byText(a.created_at ?? '', b.created_at ?? ''),
  )
}

/** A root runs one launch: it is never respawned here (start a new root instead). */
export function requireRespawnable(session: WebSession): void {
  if (session.is_root)
    throw new HttpError(409, 'A root session runs one launch; start a new root instead')
}
