'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useCallback } from 'react'
import type { KeyboardSizePreset } from '@/components/keyboard/types'
import type { ConnectionStatus, TerminalHandle } from '@/components/Terminal'
import { useAgentPolling } from '@/lib/hooks/use-agent-polling'
import { useAgentTools } from '@/lib/hooks/use-agent-tools'
import type { LayoutMode } from '@/lib/constants/terminal'
import { useProjectModeSwitch } from '@/lib/hooks/use-project-mode-switch'
import { useProjectTerminals } from '@/lib/hooks/use-project-terminals'
import type { TerminalSession } from '@/lib/hooks/use-terminal-sessions'
import { useTerminalSessions } from '@/lib/hooks/use-terminal-sessions'
import {
  addAdHocPaneAction,
  addProjectPaneAction,
  closeAllPanesAction,
} from './terminal-handler-actions'
import type {
  UseTerminalHandlersProps,
  UseTerminalHandlersReturn,
} from './use-terminal-handlers.types'

export function useTerminalHandlers({
  projectTerminals,
  activeSessionId,
  terminalRefs,
  projectTabRefs,
  setTerminalStatuses,
  setLayoutMode,
  setKeyboardSize,
  panes,
  panesAtLimit,
  createProjectPane,
  createAdHocPane,
  setActiveMode,
  removePane,
}: UseTerminalHandlersProps): UseTerminalHandlersReturn {
  const router = useRouter()
  const searchParams = useSearchParams()
  const {
    update,
    remove,
    reset,
    resetAll,
    isLoading: sessionsLoading,
  } = useTerminalSessions()
  const {
    switchMode,
    resetProject,
    disableProject,
    isLoading: projectsLoading,
  } = useProjectTerminals()
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
      setTerminalStatuses((prev) => new Map(prev).set(sessionId, status)),
    [setTerminalStatuses],
  )
  const handleKeyboardInput = useCallback(
    (data: string) => {
      // Try the active session first
      const handle = activeSessionId
        ? terminalRefs.current.get(activeSessionId)
        : undefined
      if (handle) {
        handle.sendInput(data)
        return
      }
      // Fallback: activeSessionId may not match any mounted pane (e.g. on
      // mobile where the pane falls back to displaySlots[0] but
      // activeSessionId points to a persisted session not in the layout).
      // Send to the first available terminal ref instead of dropping input.
      terminalRefs.current.values().next().value?.sendInput(data)
    },
    [activeSessionId, terminalRefs],
  )
  const handleReconnect = useCallback(
    () => {
      const handle = activeSessionId
        ? terminalRefs.current.get(activeSessionId)
        : undefined
      if (handle) {
        handle.reconnect()
        return
      }
      terminalRefs.current.values().next().value?.reconnect()
    },
    [activeSessionId, terminalRefs],
  )
  const handleLayoutModeChange = useCallback(
    async (mode: LayoutMode) => setLayoutMode(mode),
    [setLayoutMode],
  )
  const handleAddTab = useCallback(
    () => addAdHocPaneAction(panes, panesAtLimit, createAdHocPane, navigateToSession),
    [panes, panesAtLimit, createAdHocPane, navigateToSession],
  )

  const handleNewTerminalForProject = useCallback(
    (
      targetProjectId: string,
      mode?: string,
      rootPath?: string | null,
    ) =>
      addProjectPaneAction(
        targetProjectId,
        mode,
        rootPath,
        projectTerminals,
        panes,
        panesAtLimit,
        createProjectPane,
        navigateToSession,
        startAgent,
      ),
    [
      projectTerminals,
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
      projectSessions: TerminalSession[],
      paneId?: string,
    ) => switchProjectMode({ projectId: projectIdArg, mode: newMode, projectSessions, paneId }),
    [switchProjectMode],
  )
  const handleCloseAll = useCallback(
    () => closeAllPanesAction(panes, removePane, createAdHocPane, navigateToSession),
    [panes, removePane, createAdHocPane, navigateToSession],
  )
  const setTerminalRef = useCallback(
    (sessionId: string, handle: TerminalHandle | null) =>
      handle ? terminalRefs.current.set(sessionId, handle) : terminalRefs.current.delete(sessionId),
    [terminalRefs],
  )

  return {
    handleKeyboardSizeChange,
    handleStatusChange,
    handleKeyboardInput,
    handleReconnect,
    handleLayoutModeChange,
    handleAddTab,
    handleNewTerminalForProject,
    handleProjectModeChange,
    handleCloseAll,
    setTerminalRef,
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
