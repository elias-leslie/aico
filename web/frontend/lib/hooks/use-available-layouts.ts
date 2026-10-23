'use client'

import { useLayoutEffect, useMemo, useState } from 'react'
import type { LayoutMode } from '@/lib/constants/a-term'
import {
  getAvailableLayoutModes,
  getPaneCapacityForViewport,
} from '@/lib/constants/a-term'

/**
 * SSR-safe hook that returns available layout modes based on pane count and viewport width.
 *
 * @returns Array of available layout modes
 */
function useViewportWidth(): number {
  // SSR-safe: default to 0 on server, will update after hydration
  const [viewportWidth, setViewportWidth] = useState(0)

  useLayoutEffect(() => {
    // Only run on client
    if (typeof window === 'undefined') return

    // Set initial value - sync with actual browser state after hydration
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Intentional: SSR-safe hydration sync
    setViewportWidth(window.innerWidth)

    // Listen for resize events
    const handleResize = () => {
      setViewportWidth(window.innerWidth)
    }

    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
    }
  }, [])

  return viewportWidth
}

export function useAvailableLayouts(paneCount: number): LayoutMode[] {
  const viewportWidth = useViewportWidth()

  return useMemo(
    () => getAvailableLayoutModes(paneCount, viewportWidth),
    [paneCount, viewportWidth],
  )
}

export function usePaneCapacity(): number {
  const viewportWidth = useViewportWidth()
  return useMemo(
    () => getPaneCapacityForViewport(viewportWidth),
    [viewportWidth],
  )
}

/**
 * Helper hook to check if any grid layout is available.
 *
 * @param paneCount - Number of panes to check grid availability for (defaults to 4)
 * @returns true if at least one grid layout mode is available
 */
export function useGridLayoutAvailable(paneCount = 4): boolean {
  const availableLayouts = useAvailableLayouts(paneCount)
  return availableLayouts.some((mode) => mode.startsWith('grid-'))
}
