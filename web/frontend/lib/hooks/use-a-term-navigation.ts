import { useCallback } from 'react'
import {
  getSlotPanelId,
  getSlotSessionId,
  type PaneSlot,
  type ATermSlot,
} from '@/lib/utils/slot'

interface UseATermNavigationProps {
  aTermSlots: Array<ATermSlot | PaneSlot>
  orderedIds: string[]
  activeSessionId: string | null
  onSlotSwitch: (slot: ATermSlot | PaneSlot) => void
  onSlotClose: (slot: ATermSlot | PaneSlot) => void
}

interface UseATermNavigationReturn {
  handleCloseActive: () => void
  handleNextATerm: () => void
  handlePrevATerm: () => void
  handleJumpToATerm: (index: number) => void
}

/**
 * Custom hook for aTerm navigation logic
 * Handles cycling through A-Term sessions and closing active A-Term sessions
 */
export function useATermNavigation({
  aTermSlots,
  orderedIds,
  activeSessionId,
  onSlotSwitch,
  onSlotClose,
}: UseATermNavigationProps): UseATermNavigationReturn {
  // Find the active slot
  const findActiveSlot = useCallback(() => {
    return aTermSlots.find((slot) => getSlotSessionId(slot) === activeSessionId)
  }, [aTermSlots, activeSessionId])

  // Find the current index in orderedIds
  const findCurrentIndex = useCallback(() => {
    const activeSlot = findActiveSlot()
    return activeSlot ? orderedIds.indexOf(getSlotPanelId(activeSlot)) : -1
  }, [findActiveSlot, orderedIds])

  // Find slot by orderedId
  const findSlotByOrderedId = useCallback(
    (orderedId: string) => {
      return aTermSlots.find((slot) => getSlotPanelId(slot) === orderedId)
    },
    [aTermSlots],
  )

  // Close the current active slot
  const handleCloseActive = useCallback(() => {
    const activeSlot = findActiveSlot()
    if (activeSlot) {
      onSlotClose(activeSlot)
    }
  }, [findActiveSlot, onSlotClose])

  // Cycle to next aTerm
  const handleNextATerm = useCallback(() => {
    if (orderedIds.length <= 1) return

    const currentIndex = findCurrentIndex()
    const nextIndex = (currentIndex + 1) % orderedIds.length
    const nextSlot = findSlotByOrderedId(orderedIds[nextIndex])

    if (nextSlot) onSlotSwitch(nextSlot)
  }, [orderedIds, findCurrentIndex, findSlotByOrderedId, onSlotSwitch])

  // Cycle to previous aTerm
  const handlePrevATerm = useCallback(() => {
    if (orderedIds.length <= 1) return

    const currentIndex = findCurrentIndex()
    const prevIndex = (currentIndex - 1 + orderedIds.length) % orderedIds.length
    const prevSlot = findSlotByOrderedId(orderedIds[prevIndex])

    if (prevSlot) onSlotSwitch(prevSlot)
  }, [orderedIds, findCurrentIndex, findSlotByOrderedId, onSlotSwitch])

  // Jump to aTerm at position (0-indexed)
  const handleJumpToATerm = useCallback(
    (index: number) => {
      if (index >= orderedIds.length) return

      const targetSlot = findSlotByOrderedId(orderedIds[index])
      if (targetSlot) onSlotSwitch(targetSlot)
    },
    [orderedIds, findSlotByOrderedId, onSlotSwitch],
  )

  return {
    handleCloseActive,
    handleNextATerm,
    handlePrevATerm,
    handleJumpToATerm,
  }
}
