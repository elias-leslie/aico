'use client'

import { useCallback, useEffect, useRef } from 'react'
import { generatePaneName } from './a-term-handler-utils'
import { fetchPaneCount } from './a-term-panes-api'

interface UseAutoCreatePaneProps {
  enabled?: boolean
  panes: Array<{ pane_type: string }>
  hasVisibleExternalSlot: boolean
  isLoading: boolean
  hasLoadedOnce: boolean
  isPaneCreating: boolean
  createAdHocPane: (name: string) => Promise<{
    sessions: Array<{ id: string; mode: string }>
  }>
  switchToSession: (id: string) => void
}

/**
 * Auto-creates a default pane when:
 * 1. Initial load with no panes (verified via API count)
 * 2. Last pane is closed (N→0 transition)
 *
 * Prevents race conditions with refs to track creation state.
 */
export function useAutoCreatePane({
  enabled = true,
  panes,
  hasVisibleExternalSlot,
  isLoading,
  hasLoadedOnce,
  isPaneCreating,
  createAdHocPane,
  switchToSession,
}: UseAutoCreatePaneProps): void {
  const isAutoCreatingRef = useRef(false)
  const initialLoadProcessed = useRef(false)
  const prevPanesLengthRef = useRef<number | null>(null)

  const shouldAutoCreate = useCallback(async () => {
    const paneCount = await fetchPaneCount()
    return paneCount.count === 0
  }, [])

  const createAndFocusPane = useCallback(
    async (paneName: string) => {
      const newPane = await createAdHocPane(paneName)
      const shellSession = newPane.sessions.find((s) => s.mode === 'shell')
      if (shellSession) {
        switchToSession(shellSession.id)
      }
    },
    [createAdHocPane, switchToSession],
  )

  useEffect(() => {
    let cancelled = false

    // Skip if still loading or already creating
    if (
      !enabled ||
      isLoading ||
      !hasLoadedOnce ||
      isPaneCreating ||
      isAutoCreatingRef.current
    ) {
      return
    }

    const prevLength = prevPanesLengthRef.current
    const currLength = panes.length

    // Update prev length for next render
    prevPanesLengthRef.current = currLength

    // Case 1: Initial load (first time we see panes data)
    if (prevLength === null && !initialLoadProcessed.current) {
      initialLoadProcessed.current = true

      if (currLength === 0 && !hasVisibleExternalSlot) {
        isAutoCreatingRef.current = true
        void (async () => {
          try {
            if (!cancelled && (await shouldAutoCreate())) {
              await createAndFocusPane(generatePaneName('Ad-Hoc A-Term', 0))
            }
          } catch (error) {
            if (!cancelled) {
              console.error(
                'Failed to auto-create pane on initial load:',
                error,
              )
            }
          } finally {
            if (!cancelled) {
              isAutoCreatingRef.current = false
            }
          }
        })()
      }
      return () => {
        cancelled = true
      }
    }

    // Case 2: Last pane closed (N→0 transition, where N > 0)
    if (
      prevLength !== null &&
      prevLength > 0 &&
      currLength === 0 &&
      !hasVisibleExternalSlot
    ) {
      isAutoCreatingRef.current = true
      const adHocCount = panes.filter((p) => p.pane_type === 'adhoc').length
      void (async () => {
        try {
          if (!cancelled && (await shouldAutoCreate())) {
            await createAndFocusPane(
              generatePaneName('Ad-Hoc A-Term', adHocCount),
            )
          }
        } catch (error) {
          if (!cancelled) {
            console.error(
              'Failed to auto-create pane after closing last:',
              error,
            )
          }
        } finally {
          if (!cancelled) {
            isAutoCreatingRef.current = false
          }
        }
      })()
    }

    return () => {
      cancelled = true
    }
  }, [
    isLoading,
    enabled,
    hasLoadedOnce,
    panes,
    hasVisibleExternalSlot,
    isPaneCreating,
    createAndFocusPane,
    shouldAutoCreate,
  ])
}
