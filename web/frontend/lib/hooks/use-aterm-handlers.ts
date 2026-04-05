'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useCallback } from 'react'
import type { KeyboardSizePreset } from '@/components/keyboard/types'
import type { ConnectionStatus, ATermHandle } from '@/components/ATerm'
import { useAgentPolling } from '@/lib/hooks/use-agent-polling'
import { useAgentTools } from '@/lib/hooks/use-agent-tools'
import type { LayoutMode } from '@/lib/constants/aterm'
import { useProjectModeSwitch } from '@/lib/hooks/use-project-mode-switch'
import { useProjectATerms } from '@/lib/hooks/use-project-aterms'
import type { ATermSession } from '@/lib/hooks/use-aterm-sessions'
import { useATermSessions } from '@/lib/hooks/use-aterm-sessions'
import {
  addAdHocPaneAction,
  addProjectPaneAction,
  closeAllPanesAction,
} from './aterm-handler-actions'
import type {
  UseATermHandlersProps,
  UseATermHandlersReturn,
} from './use-aterm-handlers.types'

export function useATermHandlers({
  projectATerms,
  activeSessionId,
  atermRefs,
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
        ? atermRefs.current.get(activeSessionId)
        : undefined
      if (handle) {
        handle.sendInput(data)
        return
      }
      // Fallback: activeSessionId may not match any mounted pane (e.g. on
      // mobile where the pane falls back to displaySlots[0] but
      // activeSessionId points to a persisted session not in the layout).
      // Send to the first available aterm ref instead of dropping input.
      atermRefs.current.values().next().value?.sendInput(data)
    },
    [activeSessionId, atermRefs],
  )
  const handleReconnect = useCallback(
    () => {
      const handle = activeSessionId
        ? atermRefs.current.get(activeSessionId)
        : undefined
      if (handle) {
        handle.reconnect()
        return
      }
      atermRefs.current.values().next().value?.reconnect()
    },
    [activeSessionId, atermRefs],
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
      handle ? atermRefs.current.set(sessionId, handle) : atermRefs.current.delete(sessionId),
    [atermRefs],
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
