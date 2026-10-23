import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
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

interface UseATermSlotHandlersParams {
  switchToSession: (sessionId: string) => void
  activeSessionId: string | null
  reset: (sessionId: string) => Promise<ATermSession>
  remove: (sessionId: string) => Promise<DeleteSessionResult>
  sessions: ATermSession[]
  slots: (ATermSlot | PaneSlot)[]
  handleProjectModeChange: (
    projectId: string,
    newMode: string,
    projectSessions: ATermSession[],
    paneId?: string,
  ) => Promise<void>
}

export function useATermSlotHandlers({
  switchToSession,
  activeSessionId,
  reset,
  remove,
  sessions,
  slots,
  handleProjectModeChange,
}: UseATermSlotHandlersParams) {
  const queryClient = useQueryClient()
  const [isModeSwitching, setIsModeSwitching] = useState(false)
  // Ref to avoid stale closure on sessions in handleSlotModeSwitch
  const sessionsRef = useRef(sessions)
  useEffect(() => {
    sessionsRef.current = sessions
  }, [sessions])

  // The next of the user's own sessions, to show once this one ends.
  const findNextOwnSessionId = useCallback(
    (currentSlot: ATermSlot | PaneSlot) => {
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
    (slot: ATermSlot | PaneSlot) => {
      const sessionId = getSlotSessionId(slot)
      if (sessionId) {
        switchToSession(sessionId)
      }
    },
    [switchToSession],
  )

  // Resets ONLY the visible session (shell OR agent, not both)
  const handleSlotReset = useCallback(
    async (slot: ATermSlot | PaneSlot) => {
      const sessionId = getSlotSessionId(slot)
      if (!sessionId || !slot.can.reset) return

      const newSession = await reset(sessionId)
      // Invalidate panes so the slot picks up the new session ID
      await queryClient.invalidateQueries({ queryKey: ['a-term-panes'] })
      await queryClient.invalidateQueries({
        queryKey: ['a-term-detached-panes'],
      })
      switchToSession(newSession.id)
    },
    [reset, switchToSession, queryClient],
  )

  const handleSlotCloseSession = useCallback(
    async (slot: ATermSlot | PaneSlot) => {
      const sessionId = getSlotSessionId(slot)
      if (!sessionId) return

      const nextSessionId =
        activeSessionId === sessionId ? findNextOwnSessionId(slot) : null
      const result = await remove(sessionId)
      const target = result.next_session_id ?? nextSessionId
      if (target) {
        switchToSession(target)
      }
    },
    [activeSessionId, findNextOwnSessionId, remove, switchToSession],
  )

  // Switch mode (shell <-> agent tool) on a project slot
  const handleSlotModeSwitch = useCallback(
    async (slot: ATermSlot | PaneSlot, mode: ATermMode) => {
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
