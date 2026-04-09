'use client'

import { useCallback, useEffect, useRef } from 'react'
import type { PaneLayout } from '@/components/ResizablePaneLayout'
import type { ATermPane } from './use-a-term-panes'

interface UseLayoutPersistenceOptions {
  saveLayouts: (
    layouts: Array<{
      paneId: string
      widthPercent?: number
      heightPercent?: number
    }>,
  ) => Promise<ATermPane[]>
  debounceMs?: number
}

/**
 * Hook for persisting pane layouts with debouncing.
 *
 * @example
 * ```tsx
 * const { handleLayoutChange } = useLayoutPersistence({
 *   saveLayouts,
 *   debounceMs: 500,
 * });
 *
 * <ResizablePaneLayout onLayoutChange={handleLayoutChange} />
 * ```
 */
export function useLayoutPersistence({
  saveLayouts,
  debounceMs = 500,
}: UseLayoutPersistenceOptions) {
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingLayoutsRef = useRef<PaneLayout[] | null>(null)

  const handleLayoutChange = useCallback(
    (layouts: PaneLayout[]) => {
      pendingLayoutsRef.current = layouts

      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }

      debounceTimerRef.current = setTimeout(async () => {
        const layoutsToSave = pendingLayoutsRef.current
        if (!layoutsToSave || layoutsToSave.length === 0) return

        pendingLayoutsRef.current = null

        const payload = layoutsToSave.map((l) => ({
          paneId: l.slotId,
          widthPercent: l.widthPercent,
          heightPercent: l.heightPercent,
        }))

        try {
          await saveLayouts(payload)
        } catch {
          // Layout will re-sync on next user interaction.
        }
      }, debounceMs)
    },
    [debounceMs, saveLayouts],
  )

  // Clear debounce timer on unmount to prevent state updates after unmount
  useEffect(
    () => () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
    },
    [],
  )

  return {
    handleLayoutChange,
  }
}
