/**
 * Slot helper utilities for discriminated union access.
 *
 * PaneSlot (pane-based) is the primary type. ATermSlot (session-based)
 * exists only for external sessions that lack a database pane record.
 */

import type { ATermPane } from '@/lib/hooks/use-a-term-panes'
import { getAgentState } from './agent-state'

// Slot types for split-pane A-Term sessions
export interface ProjectSlot {
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

export interface AdHocSlot {
  slotId?: string
  type: 'adhoc'
  sessionId: string
  name: string
  workingDir: string | null
  sessionMode?: string
  isExternal?: boolean
}

export type ATermSlot = ProjectSlot | AdHocSlot

/**
 * Get the active session ID for a slot.
 * For project slots, returns the active session ID.
 * Works with both ATermSlot and PaneSlot.
 */
export function getSlotSessionId(slot: ATermSlot | PaneSlot): string | null {
  if (slot.type === 'project') {
    return slot.activeSessionId
  }
  return slot.sessionId
}

/**
 * Get a unique panel ID for a slot.
 */
export function getSlotPanelId(slot: ATermSlot | PaneSlot): string {
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
export function getSlotName(slot: ATermSlot | PaneSlot): string {
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
export function getSlotBaseName(slot: ATermSlot | PaneSlot): string {
  if (slot.type === 'project') {
    return slot.projectName
  }
  return slot.name
}

/**
 * Get working directory for a slot.
 */
export function getSlotWorkingDir(slot: ATermSlot | PaneSlot): string | null {
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
 * This type wraps the base ATermSlot with additional pane metadata.
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

/**
 * Convert a ATermPane to a ATermSlot for UI rendering.
 * This bridges the new pane API with existing slot-based components.
 */
export function paneToSlot(pane: ATermPane): PaneSlot {
  if (pane.pane_type === 'project') {
    const activeSession = pane.sessions.find((s) => s.mode === pane.active_mode)
    const agentSession = pane.sessions.find((s) => s.mode !== 'shell')
    return {
      type: 'project',
      paneId: pane.id,
      projectId: pane.project_id!,
      projectName: pane.pane_name,
      rootPath: activeSession?.working_dir ?? null,
      activeMode: pane.active_mode,
      activeSessionId: activeSession?.id ?? null,
      sessionBadge: null, // Badge is now part of pane_name
      claudeState: getAgentState(agentSession),
    }
  }

  // Ad-hoc pane
  const session = pane.sessions[0]
  return {
    type: 'adhoc',
    paneId: pane.id,
    sessionId: session?.id ?? '',
    name: pane.pane_name,
    workingDir: session?.working_dir ?? null,
    sessionMode: session?.mode,
  }
}

/**
 * Convert array of ATermPanes to PaneSlots.
 * Panes are already ordered by pane_order from the API.
 */
export function panesToSlots(panes: ATermPane[]): PaneSlot[] {
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
export function isPaneSlot(slot: ATermSlot | PaneSlot): slot is PaneSlot {
  return 'paneId' in slot
}
