import { useCallback, useEffect, useMemo } from 'react'
import type { ConnectionStatus } from '@/components/ATerm'
import type { LayoutMode } from '@/lib/constants/a-term'
import type { ATermSlot, PaneSlot } from '@/lib/utils/slot'
import { getSlotPanelId, isPaneSlot } from '@/lib/utils/slot'

/**
 * Hook to manage pane swap operations
 */
export function useSwapPanes(
  aTermSlots: Array<ATermSlot | PaneSlot>,
  swapPanePositions: (paneIdA: string, paneIdB: string) => Promise<void>,
) {
  return useCallback(
    async (slotIdA: string, slotIdB: string) => {
      // Find pane IDs from slot IDs
      const slotA = aTermSlots.find((s) => getSlotPanelId(s) === slotIdA)
      const slotB = aTermSlots.find((s) => getSlotPanelId(s) === slotIdB)

      if (!slotA || !slotB) return
      if (!isPaneSlot(slotA) || !isPaneSlot(slotB)) return

      await swapPanePositions(slotA.paneId, slotB.paneId)
    },
    [aTermSlots, swapPanePositions],
  )
}

/**
 * Hook to auto-downgrade layout if current mode is unavailable
 */
export function useLayoutAutoDowngrade(
  availableLayouts: LayoutMode[],
  layoutMode: LayoutMode,
  setLayoutMode: (mode: LayoutMode) => void,
  enabled = true,
) {
  useEffect(() => {
    if (!enabled || availableLayouts.length === 0) return
    if (!availableLayouts.includes(layoutMode)) {
      const highest =
        availableLayouts[availableLayouts.length - 1] || 'split-horizontal'
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Intentional: sync layout to viewport constraints
      setLayoutMode(highest)
    }
  }, [availableLayouts, enabled, layoutMode, setLayoutMode])
}

/**
 * Hook to check connection status
 */
export function useConnectionStatus(
  activeSessionId: string | null | undefined,
  aTermStatuses: Map<string, ConnectionStatus>,
) {
  return useMemo(() => {
    return {
      activeStatus: activeSessionId
        ? aTermStatuses.get(activeSessionId)
        : undefined,
    }
  }, [activeSessionId, aTermStatuses])
}
