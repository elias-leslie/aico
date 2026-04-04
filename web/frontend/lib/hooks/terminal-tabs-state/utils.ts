import type { TerminalSession } from '@/lib/hooks/use-terminal-sessions'
import { getSlotPanelId, type PaneSlot, panesToSlots, type TerminalSlot } from '@/lib/utils/slot'
import type { TerminalPane } from '@/lib/hooks/terminal-panes-types'

/**
 * Get active session's project_id for per-project settings
 */
export function getActiveSessionProjectId(
  activeSessionId: string | null | undefined,
  sessions: TerminalSession[],
): string | undefined {
  if (!activeSessionId) return undefined
  const activeSession = sessions.find((s) => s.id === activeSessionId)
  return activeSession?.project_id ?? undefined
}

/**
 * Convert panes to terminal slots
 */
export function getPanesToSlots(panes: TerminalPane[]): PaneSlot[] {
  return panesToSlots(panes)
}

/**
 * Get ordered slot IDs from terminal slots
 */
export function getOrderedIds(terminalSlots: Array<TerminalSlot | PaneSlot>): string[] {
  return terminalSlots.map((slot) => getSlotPanelId(slot))
}

export function reconcileOrderedIds(
  terminalSlots: Array<TerminalSlot | PaneSlot>,
  storedOrderedIds: string[],
): string[] {
  const visibleIds = getOrderedIds(terminalSlots)
  const visibleIdSet = new Set(visibleIds)
  const retainedIds = storedOrderedIds.filter((id) => visibleIdSet.has(id))
  const retainedIdSet = new Set(retainedIds)
  const appendedIds = visibleIds.filter((id) => !retainedIdSet.has(id))
  return [...retainedIds, ...appendedIds]
}

export function orderTerminalSlots(
  terminalSlots: Array<TerminalSlot | PaneSlot>,
  orderedIds: string[],
): Array<TerminalSlot | PaneSlot> {
  const orderIndex = new Map(orderedIds.map((id, index) => [id, index]))

  return [...terminalSlots].sort((slotA, slotB) => {
    const indexA = orderIndex.get(getSlotPanelId(slotA)) ?? Number.MAX_SAFE_INTEGER
    const indexB = orderIndex.get(getSlotPanelId(slotB)) ?? Number.MAX_SAFE_INTEGER
    return indexA - indexB
  })
}

export function swapOrderedIds(
  orderedIds: string[],
  slotIdA: string,
  slotIdB: string,
): string[] {
  const indexA = orderedIds.indexOf(slotIdA)
  const indexB = orderedIds.indexOf(slotIdB)

  if (indexA === -1 || indexB === -1 || indexA === indexB) {
    return orderedIds
  }

  const swapped = [...orderedIds]
  swapped[indexA] = slotIdB
  swapped[indexB] = slotIdA
  return swapped
}

/**
 * Check if layout mode is a grid mode
 */
export function isGridLayoutMode(layoutMode: string): boolean {
  return layoutMode.startsWith('grid-')
}
