'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useCallback } from 'react'
import type { ConnectionStatus, TerminalHandle } from '@/components/Terminal'
import { useAgentPolling } from '@/lib/hooks/use-agent-polling'
import { useAgentTools } from '@/lib/hooks/use-agent-tools'
import { useProjectModeSwitch } from '@/lib/hooks/use-project-mode-switch'
import { useProjectTerminals } from '@/lib/hooks/use-project-terminals'
import type { TerminalSession } from '@/lib/hooks/use-terminal-sessions'
import { useTerminalSessions } from '@/lib/hooks/use-terminal-sessions'
import { commitComposeInput } from './compose-input'
import { addProjectPaneAction } from './terminal-handler-actions'
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
  panes,
  createProjectPane,
  setActiveMode,
}: UseTerminalHandlersProps): UseTerminalHandlersReturn {
  const router = useRouter()
  const searchParams = useSearchParams()
  const {
    update,
    remove,
    reset,
    isLoading: sessionsLoading,
  } = useTerminalSessions()
  const { switchMode, isLoading: projectsLoading } = useProjectTerminals()
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
      const params =
        typeof window !== 'undefined'
          ? new URLSearchParams(window.location.search)
          : new URLSearchParams(searchParams.toString())
      params.set('session', sessionId)
      // The History API, not router.push: it updates the URL at once (Next
      // syncs it into useSearchParams), so the New session dialog closing
      // right after, which rewrites the URL from window.location, keeps it.
      if (typeof window !== 'undefined')
        window.history.pushState(null, '', `?${params.toString()}`)
      else router.push(`?${params.toString()}`, { scroll: false })
    },
    [searchParams, router],
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
      // mobile, where nothing is chosen yet and the layout shows the first
      // pane). Send to the first available terminal ref instead of dropping input.
      terminalRefs.current.values().next().value?.sendInput(data)
    },
    [activeSessionId, terminalRefs],
  )
  const handleKeyboardPaste = useCallback(
    (text: string) => {
      const handle =
        (activeSessionId
          ? terminalRefs.current.get(activeSessionId)
          : undefined) ?? terminalRefs.current.values().next().value
      void handle?.pasteInput(text)
    },
    [activeSessionId, terminalRefs],
  )
  const handleComposeInput = useCallback(
    (sessionId: string, text: string, action: 'insert' | 'send') =>
      commitComposeInput(terminalRefs.current, sessionId, text, action),
    [terminalRefs],
  )
  const handleReconnect = useCallback(() => {
    const handle = activeSessionId
      ? terminalRefs.current.get(activeSessionId)
      : undefined
    if (handle) {
      handle.reconnect()
      return
    }
    terminalRefs.current.values().next().value?.reconnect()
  }, [activeSessionId, terminalRefs])
  const handleNewTerminalForProject = useCallback(
    (
      targetProjectId: string,
      mode?: string,
      rootPath?: string | null,
      host?: string,
    ) =>
      addProjectPaneAction(
        targetProjectId,
        mode,
        rootPath,
        projectTerminals,
        panes,
        createProjectPane,
        navigateToSession,
        startAgent,
        host,
      ),
    [projectTerminals, panes, createProjectPane, navigateToSession, startAgent],
  )

  const handleProjectModeChange = useCallback(
    async (
      projectIdArg: string,
      newMode: string,
      projectSessions: TerminalSession[],
      paneId?: string,
      pane?: import('./use-terminal-panes').TerminalPane,
    ) =>
      switchProjectMode({
        projectId: projectIdArg,
        mode: newMode,
        projectSessions,
        paneId,
        pane,
      }),
    [switchProjectMode],
  )
  const setTerminalRef = useCallback(
    (sessionId: string, handle: TerminalHandle | null) =>
      handle
        ? terminalRefs.current.set(sessionId, handle)
        : terminalRefs.current.delete(sessionId),
    [terminalRefs],
  )

  return {
    handleStatusChange,
    handleKeyboardInput,
    handleKeyboardPaste,
    handleComposeInput,
    handleReconnect,
    handleNewTerminalForProject,
    handleProjectModeChange,
    setTerminalRef,
    navigateToSession,
    update,
    remove,
    reset,
    sessionsLoading,
    projectsLoading,
  }
}
