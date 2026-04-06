'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useCallback } from 'react'
import type { KeyboardSizePreset } from '@/components/keyboard/types'
import type { ConnectionStatus, ATermHandle } from '@/components/ATerm'
import { useAgentPolling } from '@/lib/hooks/use-agent-polling'
import { useAgentTools } from '@/lib/hooks/use-agent-tools'
import type { LayoutMode } from '@/lib/constants/a-term'
import { useProjectModeSwitch } from '@/lib/hooks/use-project-mode-switch'
import { useProjectATerms } from '@/lib/hooks/use-project-a-terms'
import type { ATermSession } from '@/lib/hooks/use-a-term-sessions'
import { useATermSessions } from '@/lib/hooks/use-a-term-sessions'
import {
  addAdHocPaneAction,
  addProjectPaneAction,
  closeAllPanesAction,
} from './a-term-handler-actions'
import type {
  UseATermHandlersProps,
  UseATermHandlersReturn,
} from './use-a-term-handlers.types'

export function useATermHandlers({
  projectATerms,
  activeSessionId,
  aTermRefs,
  projectTabRefs,
  setATermStatuses,
  setLayoutMode,
  setKeyboardSize,
  panes,
  panesAtLimit,
  createProjectPane,
  createAdHocPane,
  setActiveMode,
  removePane,
}: UseATermHandlersProps): UseATermHandlersReturn {
  const router = useRouter()
  const searchParams = useSearchParams()
  const {
    update,
    remove,
    reset,
    resetAll,
    isLoading: sessionsLoading,
  } = useATermSessions()
  const {
    switchMode,
    resetProject,
    disableProject,
    isLoading: projectsLoading,
  } = useProjectATerms()
  const { startAgent } = useAgentPolling()
  const { switchTool } = useAgentTools()
  const { switchProjectMode } = useProjectModeSwitch({
    switchMode,
    projectTabRefs,
    panes,
    setActiveMode,
    switchAgentTool: switchTool,
  })

  const navigateToSession = useCallback(
    (sessionId: string) => {
      const params = new URLSearchParams(searchParams.toString())
      params.set('session', sessionId)
      router.push(`?${params.toString()}`, { scroll: false })
    },
    [searchParams, router],
  )

  const handleKeyboardSizeChange = useCallback(
    (size: KeyboardSizePreset) => setKeyboardSize(size),
    [setKeyboardSize],
  )
  const handleStatusChange = useCallback(
    (sessionId: string, status: ConnectionStatus) =>
      setATermStatuses((prev) => new Map(prev).set(sessionId, status)),
    [setATermStatuses],
  )
  const handleKeyboardInput = useCallback(
    (data: string) => {
      // Try the active session first
      const handle = activeSessionId
        ? aTermRefs.current.get(activeSessionId)
        : undefined
      if (handle) {
        handle.sendInput(data)
        return
      }
      // Fallback: activeSessionId may not match any mounted pane (e.g. on
      // mobile where the pane falls back to displaySlots[0] but
      // activeSessionId points to a persisted session not in the layout).
      // Send to the first available aTerm ref instead of dropping input.
      aTermRefs.current.values().next().value?.sendInput(data)
    },
    [activeSessionId, aTermRefs],
  )
  const handleReconnect = useCallback(
    () => {
      const handle = activeSessionId
        ? aTermRefs.current.get(activeSessionId)
        : undefined
      if (handle) {
        handle.reconnect()
        return
      }
      aTermRefs.current.values().next().value?.reconnect()
    },
    [activeSessionId, aTermRefs],
  )
  const handleLayoutModeChange = useCallback(
    async (mode: LayoutMode) => setLayoutMode(mode),
    [setLayoutMode],
  )
  const handleAddTab = useCallback(
    () => addAdHocPaneAction(panes, panesAtLimit, createAdHocPane, navigateToSession),
    [panes, panesAtLimit, createAdHocPane, navigateToSession],
  )

  const handleNewATermForProject = useCallback(
    (
      targetProjectId: string,
      mode?: string,
      rootPath?: string | null,
    ) =>
      addProjectPaneAction(
        targetProjectId,
        mode,
        rootPath,
        projectATerms,
        panes,
        panesAtLimit,
        createProjectPane,
        navigateToSession,
        startAgent,
      ),
    [
      projectATerms,
      panes,
      panesAtLimit,
      createProjectPane,
      navigateToSession,
      startAgent,
    ],
  )

  const handleProjectModeChange = useCallback(
    async (
      projectIdArg: string,
      newMode: string,
      projectSessions: ATermSession[],
      paneId?: string,
    ) => switchProjectMode({ projectId: projectIdArg, mode: newMode, projectSessions, paneId }),
    [switchProjectMode],
  )
  const handleCloseAll = useCallback(
    () => closeAllPanesAction(panes, removePane, createAdHocPane, navigateToSession),
    [panes, removePane, createAdHocPane, navigateToSession],
  )
  const setATermRef = useCallback(
    (sessionId: string, handle: ATermHandle | null) =>
      handle ? aTermRefs.current.set(sessionId, handle) : aTermRefs.current.delete(sessionId),
    [aTermRefs],
  )

  return {
    handleKeyboardSizeChange,
    handleStatusChange,
    handleKeyboardInput,
    handleReconnect,
    handleLayoutModeChange,
    handleAddTab,
    handleNewATermForProject,
    handleProjectModeChange,
    handleCloseAll,
    setATermRef,
    navigateToSession,
    update,
    remove,
    reset,
    resetAll,
    resetProject,
    disableProject,
    sessionsLoading,
    projectsLoading,
  }
}
