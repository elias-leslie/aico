import { useQueryClient } from '@tanstack/react-query'
import {
  type MutableRefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import type { ATermHandle } from '@/components/ATerm'
import type { ATermMode } from '@/components/ModeToggle'
import type {
  ATermSession,
  DeleteSessionResult,
} from '@/lib/hooks/use-a-term-sessions'
import {
  type ATermSlot,
  getSlotSessionId,
  isPaneSlot,
  type PaneSlot,
} from '@/lib/utils/slot'
import {
  buildDetachedPaneWindowUrl,
  getDetachedPaneWindowFeatures,
  getDetachedPaneWindowName,
} from '@/lib/utils/detached-pane-window'

interface UseATermSlotHandlersParams {
  aTermRefs: MutableRefObject<Map<string, ATermHandle | null>>
  switchToSession: (sessionId: string) => void
  activeSessionId: string | null
  reset: (sessionId: string) => Promise<ATermSession>
  disableProject: (projectId: string) => Promise<void>
  remove: (sessionId: string) => Promise<DeleteSessionResult>
  detachExternalSession?: (sessionId: string) => void
  // Pane-based operations (new architecture)
  detachPane?: (paneId: string) => Promise<unknown>
  removePane?: (paneId: string) => Promise<void>
  setShowCleaner: (show: boolean) => void
  setCleanerRawPrompt: (prompt: string) => void
  // For mode switching
  sessions: ATermSession[]
  visibleSlots: (ATermSlot | PaneSlot)[]
  handleProjectModeChange: (
    projectId: string,
    newMode: string,
    projectSessions: ATermSession[],
    paneId?: string,
    pane?: import('./use-a-term-panes').ATermPane,
  ) => Promise<void>
  detachedPaneId?: string
  isDetachedPaneWindow?: boolean
  removeDetachedWindowPane?: (
    paneId: string,
    sessionId?: string | null,
  ) => void
}

export function useATermSlotHandlers({
  aTermRefs,
  switchToSession,
  activeSessionId,
  reset,
  disableProject,
  remove,
  detachExternalSession,
  detachPane,
  removePane,
  setShowCleaner,
  setCleanerRawPrompt,
  sessions,
  visibleSlots,
  handleProjectModeChange,
  detachedPaneId,
  isDetachedPaneWindow = false,
  removeDetachedWindowPane,
}: UseATermSlotHandlersParams) {
  const queryClient = useQueryClient()
  // Track mode switch loading state
  const [isModeSwitching, setIsModeSwitching] = useState(false)
  // Ref to avoid stale closure on sessions in handleSlotModeSwitch
  const sessionsRef = useRef(sessions)
  useEffect(() => {
    sessionsRef.current = sessions
  }, [sessions])

  const findSession = useCallback(
    (sessionId: string | null | undefined) =>
      sessionId
        ? (sessionsRef.current.find((session) => session.id === sessionId) ??
          null)
        : null,
    [],
  )
  const findNextVisibleSessionId = useCallback(
    (currentSlot: ATermSlot | PaneSlot) => {
      for (const slot of visibleSlots) {
        if (slot === currentSlot) continue
        const sessionId = getSlotSessionId(slot)
        if (sessionId) {
          return sessionId
        }
      }
      return null
    },
    [visibleSlots],
  )
  // Handler for switching to a slot's aTerm
  const handleSlotSwitch = useCallback(
    (slot: ATermSlot) => {
      const sessionId = getSlotSessionId(slot)
      if (sessionId) {
        switchToSession(sessionId)
      }
    },
    [switchToSession],
  )

  // Handler for resetting a slot's a-term
  // Resets ONLY the visible session (shell OR claude, not both)
  const handleSlotReset = useCallback(
    async (slot: ATermSlot) => {
      const sessionId =
        slot.type === 'project' ? slot.activeSessionId : slot.sessionId
      if (!sessionId) return
      if (findSession(sessionId)?.is_external) return

      const newSession = await reset(sessionId)
      // Invalidate panes so the slot picks up the new session ID
      await queryClient.invalidateQueries({ queryKey: ['a-term-panes'] })
      // Navigate to the new session so the aTerm re-renders with the fresh connection
      switchToSession(newSession.id)
    },
    [findSession, reset, switchToSession, queryClient],
  )

  // Handler for closing a slot's a-term
  // Uses pane-based deletion when available (new architecture), falls back to session-based
  const handleSlotClose = useCallback(
    async (slot: ATermSlot | PaneSlot) => {
      const sessionId = getSlotSessionId(slot)
      const session = findSession(sessionId)
      const nextVisibleSessionId =
        activeSessionId && sessionId === activeSessionId
          ? findNextVisibleSessionId(slot)
          : null

      if (session?.is_external) {
        detachExternalSession?.(session.id)
        if (nextVisibleSessionId) {
          switchToSession(nextVisibleSessionId)
        }
        return
      }

      if (isDetachedPaneWindow && isPaneSlot(slot)) {
        removeDetachedWindowPane?.(slot.paneId, nextVisibleSessionId ?? null)
        return
      }

      if (detachPane && isPaneSlot(slot)) {
        if (detachedPaneId === slot.paneId) {
          if (typeof window !== 'undefined' && window.opener) {
            window.close()
          }
          return
        }
        await detachPane(slot.paneId)
        if (nextVisibleSessionId) {
          switchToSession(nextVisibleSessionId)
        }
        return
      }

      if (removePane && isPaneSlot(slot)) {
        await removePane(slot.paneId)
        if (nextVisibleSessionId) {
          switchToSession(nextVisibleSessionId)
        }
        return
      }

      // Legacy: session-based deletion
      if (slot.type === 'project') {
        await disableProject(slot.projectId)
      } else {
        await remove(slot.sessionId)
      }
    },
    [
      removePane,
      disableProject,
      remove,
      findSession,
      activeSessionId,
      findNextVisibleSessionId,
      detachPane,
      detachExternalSession,
      isDetachedPaneWindow,
      removeDetachedWindowPane,
      switchToSession,
      detachedPaneId,
    ],
  )

  const handleSlotDetach = useCallback(
    async (slot: ATermSlot | PaneSlot) => {
      if (!detachPane || !isPaneSlot(slot)) {
        await handleSlotClose(slot)
        return
      }

      const sessionId = getSlotSessionId(slot)
      const nextVisibleSessionId =
        activeSessionId && sessionId === activeSessionId
          ? findNextVisibleSessionId(slot)
          : null
      const popup =
        typeof window === 'undefined'
          ? null
          : window.open(
              '',
              getDetachedPaneWindowName(slot.paneId),
              getDetachedPaneWindowFeatures(),
            )

      if (typeof window !== 'undefined' && popup === null) {
        return
      }

      if (isDetachedPaneWindow) {
        removeDetachedWindowPane?.(slot.paneId, nextVisibleSessionId ?? null)
      } else {
        try {
          await detachPane(slot.paneId)
        } catch (error) {
          popup?.close()
          throw error
        }
      }

      if (nextVisibleSessionId) {
        switchToSession(nextVisibleSessionId)
      }

      if (!popup || popup.closed || typeof window === 'undefined') {
        return
      }

      popup.location.href = buildDetachedPaneWindowUrl(
        window.location.href,
        slot.paneId,
        sessionId,
        { paneIds: [slot.paneId] },
      )
      popup.focus?.()
    },
    [
      activeSessionId,
      detachPane,
      findNextVisibleSessionId,
      handleSlotClose,
      isDetachedPaneWindow,
      removeDetachedWindowPane,
      switchToSession,
    ],
  )

  const handleSlotCloseSession = useCallback(
    async (slot: ATermSlot | PaneSlot) => {
      const sessionId = getSlotSessionId(slot)
      if (!sessionId) return

      const nextVisibleSessionId =
        activeSessionId === sessionId ? findNextVisibleSessionId(slot) : null
      const result = await remove(sessionId)

      if (result.is_external) {
        detachExternalSession?.(sessionId)
        if (nextVisibleSessionId) {
          switchToSession(nextVisibleSessionId)
        }
        return
      }

      if (result.pane_deleted && isDetachedPaneWindow && isPaneSlot(slot)) {
        removeDetachedWindowPane?.(
          slot.paneId,
          result.next_session_id ?? nextVisibleSessionId ?? null,
        )
        return
      }

      if (result.next_session_id) {
        switchToSession(result.next_session_id)
        return
      }

      if (nextVisibleSessionId) {
        switchToSession(nextVisibleSessionId)
      }
    },
    [
      activeSessionId,
      detachExternalSession,
      findNextVisibleSessionId,
      isDetachedPaneWindow,
      remove,
      removeDetachedWindowPane,
      switchToSession,
    ],
  )

  // Handler for opening prompt cleaner for a slot
  const handleSlotClean = useCallback(
    (slot: ATermSlot | PaneSlot) => {
      const sessionId = getSlotSessionId(slot)
      if (!sessionId) return

      const aTermRef = aTermRefs.current.get(sessionId)
      if (!aTermRef) return

      const input = aTermRef.getLastLine()
      setCleanerRawPrompt(input || '')
      setShowCleaner(true)
    },
    [aTermRefs, setCleanerRawPrompt, setShowCleaner],
  )

  // Handler for switching mode (shell <-> agent tool) on a slot
  const handleSlotModeSwitch = useCallback(
    async (slot: ATermSlot | PaneSlot, mode: ATermMode) => {
      if (slot.type !== 'project') return

      setIsModeSwitching(true)
      try {
        // Get all sessions for this project
        const projectSessions = sessionsRef.current.filter(
          (s) => s.project_id === slot.projectId,
        )
        // Pass paneId if available (for direct pane mode switching)
        const paneId = isPaneSlot(slot) ? slot.paneId : undefined
        await handleProjectModeChange(
          slot.projectId,
          mode,
          projectSessions,
          paneId,
        )
      } finally {
        setIsModeSwitching(false)
      }
    },
    [handleProjectModeChange],
  )

  return {
    handleSlotSwitch,
    handleSlotReset,
    handleSlotDetach,
    handleSlotClose,
    handleSlotCloseSession,
    handleSlotClean,
    handleSlotModeSwitch,
    isModeSwitching,
  }
}
