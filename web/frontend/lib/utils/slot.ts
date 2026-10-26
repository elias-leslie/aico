/**
 * Slot helper utilities for discriminated union access, and the one mapper
 * from a session to the Slot the UI renders.
 *
 * PaneSlot (pane-based) is the primary type. TerminalSlot (session-based)
 * exists only for sessions shown without a web app pane here: a free-standing
 * View, or a session whose pane is not loaded in this window.
 *
 * Every Slot is built by `paneToSlot` or `sessionToSlot`. What a Slot may do
 * (`can`) comes from the backend's capability flags; the UI never derives a
 * permission from `source` or `is_root`.
 */

import type { TerminalPane } from '@/lib/hooks/use-terminal-panes'
import type {
  SessionCheckIn,
  TerminalSession,
} from '@/lib/hooks/use-terminal-sessions'
import { getAgentState } from './agent-state'
import {
  type CoordinatorBadgeInfo,
  getCoordinatorBadge,
} from './coordinator-badge'

/** What the UI offers on a Slot, from the backend's `can_*` flags. */
export interface SlotCapabilities {
  /** Rename the session in Tether (otherwise a rename names the pane). */
  rename: boolean
  /** Reset (respawn) the session. Never offered on a free-standing View. */
  reset: boolean
  /** End the session. */
  end: boolean
}

interface SlotSessionFields {
  /** Tether's name alone (the rename input), without the project. */
  task?: string | null
  /** Coordinator or lane chip, as Aico shows it. */
  badge?: CoordinatorBadgeInfo | null
  /** The session's pending check-ins, oldest first. */
  checkIns?: SessionCheckIn[]
  /** Coordinator lineage: the session coordinates lanes, or names the
   * coordinator that launched it (the session list folds teams). */
  coordinator?: boolean
  coordinatorId?: string | null
  can: SlotCapabilities
  /** The header shows the session title (`Project — Task`) in place of the
   * project switcher. */
  showsSessionTitle: boolean
}

// Slot types for split-pane terminal sessions
export interface ProjectSlot extends SlotSessionFields {
  slotId?: string
  type: 'project'
  projectId: string
  projectName: string
  rootPath: string | null
  activeMode: string
  // Current active session (based on mode)
  activeSessionId: string | null
  // Session badge (1-indexed position among project sessions)
  sessionBadge: number | null
  // Claude state for the active session
  claudeState?: 'not_started' | 'starting' | 'running' | 'stopped' | 'error'
}

export interface AdHocSlot extends SlotSessionFields {
  slotId?: string
  type: 'adhoc'
  sessionId: string
  name: string
  workingDir: string | null
  sessionMode?: string
  /** A free-standing View: no web app pane shows this session. */
  isExternal?: boolean
}

export type TerminalSlot = ProjectSlot | AdHocSlot

/**
 * Get the active session ID for a slot.
 * For project slots, returns the active session ID.
 * Works with both TerminalSlot and PaneSlot.
 */
export function getSlotSessionId(slot: TerminalSlot | PaneSlot): string | null {
  if (slot.type === 'project') {
    return slot.activeSessionId
  }
  return slot.sessionId
}

/**
 * Get a unique panel ID for a slot.
 */
export function getSlotPanelId(slot: TerminalSlot | PaneSlot): string {
  if (slot.slotId) {
    return slot.slotId
  }
  if (isPaneSlot(slot)) {
    return `pane-${slot.paneId}`
  }
  if (slot.type === 'project') {
    return `project-${slot.projectId}`
  }
  return `adhoc-${slot.sessionId}`
}

/**
 * Get display name for a slot (includes badge if applicable).
 */
export function getSlotName(slot: TerminalSlot | PaneSlot): string {
  if (slot.type === 'project') {
    const badge = slot.sessionBadge
    if (badge !== null && badge > 1) {
      return `${slot.projectName} [${badge}]`
    }
    return slot.projectName
  }
  return slot.name
}

/**
 * Get base project name without badge.
 */
export function getSlotBaseName(slot: TerminalSlot | PaneSlot): string {
  if (slot.type === 'project') {
    return slot.projectName
  }
  return slot.name
}

/**
 * Get working directory for a slot.
 */
export function getSlotWorkingDir(
  slot: TerminalSlot | PaneSlot,
): string | null {
  if (slot.type === 'project') {
    return slot.rootPath
  }
  return slot.workingDir
}

// ============================================================================
// Pane-based Slot Derivation
// ============================================================================

/**
 * Extended slot type that includes the pane ID for direct DB operations.
 * This type wraps the base TerminalSlot with additional pane metadata.
 */
export interface PaneBasedSlot extends ProjectSlot {
  /** Pane ID for DB operations (swap, delete, etc.) */
  paneId: string
}

export interface AdHocPaneSlot extends AdHocSlot {
  /** Pane ID for DB operations */
  paneId: string
}

export type PaneSlot = PaneBasedSlot | AdHocPaneSlot

// ============================================================================
// Session-to-Slot mapper
// ============================================================================

/** Where a session is shown: in a web app pane, as a free-standing View, or
 * linked to a pane that is not loaded in this window. */
export type SessionPlace = 'pane' | 'free' | 'unloaded'

export type SessionTitleOptions =
  | { place: 'pane'; paneName: string }
  | { place: 'free' | 'unloaded'; projectName?: string }

/** A Tether session's name is Tether's (Aico shows the same one). The only
 * place the UI reads `source`, and only for titles, never for permissions. */
function ownerTitled(session: Pick<TerminalSession, 'source'>): boolean {
  return session.source === 'tether'
}

/** The project-prefix rule for a free-standing session: prefix the project
 * name unless the session's own name already carries it. */
function freeSessionTitle(
  session: Pick<TerminalSession, 'name' | 'project_id'>,
  projectName?: string,
): string {
  if (!session.project_id) return session.name
  if (session.name === session.project_id) {
    return projectName ?? session.project_id
  }
  return projectName &&
    session.name !== projectName &&
    !session.name.startsWith(`${projectName} · `) &&
    !session.name.startsWith(`${projectName} - `)
    ? `${projectName} · ${session.name}`
    : session.name
}

/**
 * The title a session shows. A Tether session keeps Tether's name everywhere
 * (the backend fills in the workspace name when it has none). Otherwise: in a
 * pane, the pane's name; free-standing, the project-prefix rule; linked to a
 * pane not loaded here, the project's name.
 */
export function sessionTitle(
  session: Pick<TerminalSession, 'name' | 'project_id' | 'source'>,
  options: SessionTitleOptions,
): string {
  if (ownerTitled(session)) return session.name
  switch (options.place) {
    case 'pane':
      return options.paneName
    case 'free':
      return freeSessionTitle(session, options.projectName)
    case 'unloaded':
      return options.projectName ?? session.name
  }
}

const NO_CAPABILITIES: SlotCapabilities = {
  rename: false,
  reset: false,
  end: false,
}

function slotFields(
  session: TerminalSession | undefined,
  type: TerminalSlot['type'],
): SlotSessionFields {
  if (!session) {
    return { can: NO_CAPABILITIES, showsSessionTitle: false }
  }
  const badge = getCoordinatorBadge(session)
  return {
    task: session.task,
    badge,
    checkIns: session.check_ins ?? [],
    coordinator: session.is_coordinator === true,
    coordinatorId: session.coordinator_id ?? null,
    can: {
      rename: session.can_rename,
      // A free-standing View never offers Reset: closing it only detaches.
      reset: session.can_respawn && !session.is_external,
      end: session.can_end,
    },
    showsSessionTitle:
      (type === 'project' && !!session.is_root) ||
      (ownerTitled(session) && (!!session.task || !!badge)),
  }
}

export interface SessionToSlotOptions {
  /** `project` needs the session's `project_id`. */
  as: 'project' | 'adhoc'
  place: 'free' | 'unloaded'
  projectName?: string
  slotId?: string
}

/** The Slot for a session shown without a pane here. */
export function sessionToSlot(
  session: TerminalSession,
  options: SessionToSlotOptions,
): TerminalSlot {
  const title = sessionTitle(session, {
    place: options.place,
    projectName: options.projectName,
  })
  const slotId = options.slotId ? { slotId: options.slotId } : {}
  if (options.as === 'project' && session.project_id) {
    return {
      ...slotId,
      type: 'project',
      projectId: session.project_id,
      projectName: title,
      rootPath: session.working_dir,
      activeMode: session.mode,
      activeSessionId: session.id,
      sessionBadge: null,
      claudeState: getAgentState(session),
      ...slotFields(session, 'project'),
    }
  }
  return {
    ...slotId,
    type: 'adhoc',
    sessionId: session.id,
    name: title,
    workingDir: session.working_dir,
    sessionMode: session.mode,
    isExternal: options.place === 'free',
    ...slotFields(session, 'adhoc'),
  }
}

/** A pane's sessions as full sessions, placed in the pane's project and
 * ordered as the pane lists them. */
export function paneSessionsAsSessions(pane: TerminalPane): TerminalSession[] {
  return pane.sessions.map((session, index) => ({
    ...session,
    user_id: null,
    project_id: pane.project_id,
    display_order: index,
    created_at: pane.created_at,
    last_accessed_at: pane.created_at,
  }))
}

/**
 * Convert a TerminalPane to a TerminalSlot for UI rendering. A pane's title is its
 * session's Tether name or else the pane's own name, so it never needs the
 * project's display name.
 */
export function paneToSlot(pane: TerminalPane): PaneSlot {
  if (pane.pane_type === 'project') {
    const activeSession =
      pane.sessions.find((s) => s.mode === pane.active_mode) ??
      pane.sessions.find((s) => s.mode === 'shell') ??
      pane.sessions[0]
    const agentSession = pane.sessions.find((s) => s.mode !== 'shell')
    return {
      type: 'project',
      paneId: pane.id,
      projectId: pane.project_id!,
      projectName: activeSession
        ? sessionTitle(activeSession, {
            place: 'pane',
            paneName: pane.pane_name,
          })
        : pane.pane_name,
      rootPath: activeSession?.working_dir ?? null,
      activeMode: activeSession?.mode ?? pane.active_mode,
      activeSessionId: activeSession?.id ?? null,
      sessionBadge: null, // Badge is now part of pane_name
      claudeState: getAgentState(agentSession),
      ...slotFields(activeSession, 'project'),
    }
  }

  // Ad-hoc pane
  const session = pane.sessions[0]
  return {
    type: 'adhoc',
    paneId: pane.id,
    sessionId: session?.id ?? '',
    name: session
      ? sessionTitle(session, { place: 'pane', paneName: pane.pane_name })
      : pane.pane_name,
    workingDir: session?.working_dir ?? null,
    sessionMode: session?.mode,
    ...slotFields(session, 'adhoc'),
  }
}

/**
 * Convert array of TerminalPanes to PaneSlots.
 * Panes are already ordered by pane_order from the API.
 */
export function panesToSlots(panes: TerminalPane[]): PaneSlot[] {
  return panes.map(paneToSlot)
}

/**
 * Get the pane ID from a PaneSlot.
 */
export function getPaneId(slot: PaneSlot): string {
  return slot.paneId
}

/**
 * Check if a slot is a PaneSlot (has paneId).
 */
export function isPaneSlot(slot: TerminalSlot | PaneSlot): slot is PaneSlot {
  return 'paneId' in slot
}
