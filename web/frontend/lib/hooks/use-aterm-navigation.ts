import { useCallback } from 'react'
import {
  getSlotPanelId,
  getSlotSessionId,
  type PaneSlot,
  type ATermSlot,
} from '@/lib/utils/slot'

interface UseATermNavigationProps {
  atermSlots: Array<ATermSlot | PaneSlot>
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
 * Custom hook for aterm navigation logic
 * Handles cycling through aterms and closing active aterms
 */
export function useATermNavigation({
  atermSlots,
  orderedIds,
  activeSessionId,
  onSlotSwitch,
  onSlotClose,
}: UseATermNavigationProps): UseATermNavigationReturn {
  // Find the active slot
  const findActiveSlot = useCallback(() => {
    return atermSlots.find((slot) => getSlotSessionId(slot) === activeSessionId)
  }, [atermSlots, activeSessionId])

  // Find the current index in orderedIds
  const findCurrentIndex = useCallback(() => {
    const activeSlot = findActiveSlot()
    return activeSlot ? orderedIds.indexOf(getSlotPanelId(activeSlot)) : -1
  }, [findActiveSlot, orderedIds])

  // Find slot by orderedId
  const findSlotByOrderedId = useCallback(
    (orderedId: string) => {
      return atermSlots.find((slot) => getSlotPanelId(slot) === orderedId)
    },
    [atermSlots],
  )

  // Close the current active slot
  const handleCloseActive = useCallback(() => {
    const activeSlot = findActiveSlot()
    if (activeSlot) {
      onSlotClose(activeSlot)
    }
  }, [findActiveSlot, onSlotClose])

  // Cycle to next aterm
  const handleNextATerm = useCallback(() => {
    if (orderedIds.length <= 1) return

    const currentIndex = findCurrentIndex()
    const nextIndex = (currentIndex + 1) % orderedIds.length
    const nextSlot = findSlotByOrderedId(orderedIds[nextIndex])

    if (nextSlot) onSlotSwitch(nextSlot)
  }, [orderedIds, findCurrentIndex, findSlotByOrderedId, onSlotSwitch])

  // Cycle to previous aterm
  const handlePrevATerm = useCallback(() => {
    if (orderedIds.length <= 1) return

    const currentIndex = findCurrentIndex()
    const prevIndex = (currentIndex - 1 + orderedIds.length) % orderedIds.length
    const prevSlot = findSlotByOrderedId(orderedIds[prevIndex])

    if (prevSlot) onSlotSwitch(prevSlot)
  }, [orderedIds, findCurrentIndex, findSlotByOrderedId, onSlotSwitch])

  // Jump to aterm at position (0-indexed)
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
