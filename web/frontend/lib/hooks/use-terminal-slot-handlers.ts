import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { TerminalMode } from '@/components/ModeToggle'
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
  switchToSession: (sessionId: string) => void
  activeSessionId: string | null
  reset: (sessionId: string) => Promise<TerminalSession>
  remove: (
    sessionId: string,
    options?: { keepCheckIns?: boolean },
  ) => Promise<DeleteSessionResult>
  sessions: TerminalSession[]
  slots: (TerminalSlot | PaneSlot)[]
  handleProjectModeChange: (
    projectId: string,
    newMode: string,
    projectSessions: TerminalSession[],
    paneId?: string,
  ) => Promise<void>
}

export function useTerminalSlotHandlers({
  switchToSession,
  activeSessionId,
  reset,
  remove,
  sessions,
  slots,
  handleProjectModeChange,
}: UseTerminalSlotHandlersParams) {
  const queryClient = useQueryClient()
  const [isModeSwitching, setIsModeSwitching] = useState(false)
  // Ref to avoid stale closure on sessions in handleSlotModeSwitch
  const sessionsRef = useRef(sessions)
  useEffect(() => {
    sessionsRef.current = sessions
  }, [sessions])

  // The next of the user's own sessions, to show once this one ends.
  const findNextOwnSessionId = useCallback(
    (currentSlot: TerminalSlot | PaneSlot) => {
      for (const slot of slots) {
        if (slot === currentSlot || !isPaneSlot(slot)) continue
        const sessionId = getSlotSessionId(slot)
        if (sessionId) return sessionId
      }
      return null
    },
    [slots],
  )

  const handleSlotSwitch = useCallback(
    (slot: TerminalSlot | PaneSlot) => {
      const sessionId = getSlotSessionId(slot)
      if (sessionId) {
        switchToSession(sessionId)
      }
    },
    [switchToSession],
  )

  // Resets ONLY the visible session (shell OR agent, not both)
  const handleSlotReset = useCallback(
    async (slot: TerminalSlot | PaneSlot) => {
      const sessionId = getSlotSessionId(slot)
      if (!sessionId || !slot.can.reset) return

      const newSession = await reset(sessionId)
      // Invalidate panes so the slot picks up the new session ID
      await queryClient.invalidateQueries({ queryKey: ['terminal-panes'] })
      await queryClient.invalidateQueries({
        queryKey: ['terminal-detached-panes'],
      })
      switchToSession(newSession.id)
    },
    [reset, switchToSession, queryClient],
  )

  const handleSlotCloseSession = useCallback(
    async (
      slot: TerminalSlot | PaneSlot,
      options: { keepCheckIns?: boolean } = {},
    ) => {
      const sessionId = getSlotSessionId(slot)
      if (!sessionId) return

      const nextSessionId =
        activeSessionId === sessionId ? findNextOwnSessionId(slot) : null
      const result = await remove(sessionId, options)
      const target = result.next_session_id ?? nextSessionId
      if (target) {
        switchToSession(target)
      }
    },
    [activeSessionId, findNextOwnSessionId, remove, switchToSession],
  )

  // Switch mode (shell <-> agent tool) on a project slot
  const handleSlotModeSwitch = useCallback(
    async (slot: TerminalSlot | PaneSlot, mode: TerminalMode) => {
      if (slot.type !== 'project') return

      setIsModeSwitching(true)
      try {
        const projectSessions = sessionsRef.current.filter(
          (s) => s.project_id === slot.projectId,
        )
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
    handleSlotCloseSession,
    handleSlotModeSwitch,
    isModeSwitching,
  }
}
