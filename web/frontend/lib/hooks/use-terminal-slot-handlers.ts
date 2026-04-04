import { type MutableRefObject, useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { TerminalMode } from '@/components/ModeToggle'
import type { TerminalHandle } from '@/components/Terminal'
import type {
  DeleteSessionResult,
  TerminalSession,
} from '@/lib/hooks/use-terminal-sessions'
import {
  getSlotSessionId,
  isPaneSlot,
  type PaneSlot,
  type TerminalSlot,
} from '@/lib/utils/slot'

interface UseTerminalSlotHandlersParams {
  terminalRefs: MutableRefObject<Map<string, TerminalHandle | null>>
  switchToSession: (sessionId: string) => void
  activeSessionId: string | null
  reset: (sessionId: string) => Promise<TerminalSession>
  disableProject: (projectId: string) => Promise<void>
  remove: (sessionId: string) => Promise<DeleteSessionResult>
  detachExternalSession?: (sessionId: string) => void
  // Pane-based operations (new architecture)
  detachPane?: (paneId: string) => Promise<unknown>
  removePane?: (paneId: string) => Promise<void>
  setShowCleaner: (show: boolean) => void
  setCleanerRawPrompt: (prompt: string) => void
  // For mode switching
  sessions: TerminalSession[]
  visibleSlots: (TerminalSlot | PaneSlot)[]
  handleProjectModeChange: (
    projectId: string,
    newMode: string,
    projectSessions: TerminalSession[],
    paneId?: string,
  ) => Promise<void>
}

export function useTerminalSlotHandlers({
  terminalRefs,
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
}: UseTerminalSlotHandlersParams) {
  const queryClient = useQueryClient()
  // Track mode switch loading state
  const [isModeSwitching, setIsModeSwitching] = useState(false)
  // Ref to avoid stale closure on sessions in handleSlotModeSwitch
  const sessionsRef = useRef(sessions)
  useEffect(() => { sessionsRef.current = sessions }, [sessions])

  const findSession = useCallback(
    (sessionId: string | null | undefined) =>
      sessionId ? sessionsRef.current.find((session) => session.id === sessionId) ?? null : null,
    [],
  )
  const findNextVisibleSessionId = useCallback((currentSlot: TerminalSlot | PaneSlot) => {
    for (const slot of visibleSlots) {
      if (slot === currentSlot) continue
      const sessionId = getSlotSessionId(slot)
      if (sessionId) {
        return sessionId
      }
    }
    return null
  }, [visibleSlots])
  // Handler for switching to a slot's terminal
  const handleSlotSwitch = useCallback(
    (slot: TerminalSlot) => {
      const sessionId = getSlotSessionId(slot)
      if (sessionId) {
        switchToSession(sessionId)
      }
    },
    [switchToSession],
  )

  // Handler for resetting a slot's terminal
  // Resets ONLY the visible session (shell OR claude, not both)
  const handleSlotReset = useCallback(
    async (slot: TerminalSlot) => {
      const sessionId = slot.type === 'project' ? slot.activeSessionId : slot.sessionId
      if (!sessionId) return
      if (findSession(sessionId)?.is_external) return

      const newSession = await reset(sessionId)
      // Invalidate panes so the slot picks up the new session ID
      await queryClient.invalidateQueries({ queryKey: ['terminal-panes'] })
      // Navigate to the new session so the terminal re-renders with the fresh connection
      switchToSession(newSession.id)
    },
    [findSession, reset, switchToSession, queryClient],
  )

  // Handler for closing a slot's terminal
  // Uses pane-based deletion when available (new architecture), falls back to session-based
  const handleSlotClose = useCallback(
    async (slot: TerminalSlot | PaneSlot) => {
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

      if (detachPane && isPaneSlot(slot)) {
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
      switchToSession,
    ],
  )

  const handleSlotCloseSession = useCallback(
    async (slot: TerminalSlot | PaneSlot) => {
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
      remove,
      switchToSession,
    ],
  )

  // Handler for opening prompt cleaner for a slot
  const handleSlotClean = useCallback(
    (slot: TerminalSlot | PaneSlot) => {
      const sessionId = getSlotSessionId(slot)
      if (!sessionId) return

      const terminalRef = terminalRefs.current.get(sessionId)
      if (!terminalRef) return

      const input = terminalRef.getLastLine()
      setCleanerRawPrompt(input || '')
      setShowCleaner(true)
    },
    [terminalRefs, setCleanerRawPrompt, setShowCleaner],
  )

  // Handler for switching mode (shell <-> agent tool) on a slot
  const handleSlotModeSwitch = useCallback(
    async (slot: TerminalSlot | PaneSlot, mode: TerminalMode) => {
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
    handleSlotClose,
    handleSlotCloseSession,
    handleSlotClean,
    handleSlotModeSwitch,
    isModeSwitching,
  }
}
