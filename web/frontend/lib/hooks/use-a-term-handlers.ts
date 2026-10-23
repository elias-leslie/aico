'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useCallback } from 'react'
import type { ATermHandle, ConnectionStatus } from '@/components/ATerm'
import type { ATermSession } from '@/lib/hooks/use-a-term-sessions'
import { useATermSessions } from '@/lib/hooks/use-a-term-sessions'
import { useAgentPolling } from '@/lib/hooks/use-agent-polling'
import { useAgentTools } from '@/lib/hooks/use-agent-tools'
import { useProjectATerms } from '@/lib/hooks/use-project-a-terms'
import { useProjectModeSwitch } from '@/lib/hooks/use-project-mode-switch'
import { addProjectPaneAction } from './a-term-handler-actions'
import { commitComposeInput } from './compose-input'
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
  panes,
  createProjectPane,
  setActiveMode,
}: UseATermHandlersProps): UseATermHandlersReturn {
  const router = useRouter()
  const searchParams = useSearchParams()
  const {
    update,
    remove,
    reset,
    isLoading: sessionsLoading,
  } = useATermSessions()
  const { switchMode, isLoading: projectsLoading } = useProjectATerms()
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
      router.push(`?${params.toString()}`, { scroll: false })
    },
    [searchParams, router],
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
      // mobile, where nothing is chosen yet and the layout shows the first
      // pane). Send to the first available aTerm ref instead of dropping input.
      aTermRefs.current.values().next().value?.sendInput(data)
    },
    [activeSessionId, aTermRefs],
  )
  const handleComposeInput = useCallback(
    (sessionId: string, text: string, action: 'insert' | 'send') =>
      commitComposeInput(aTermRefs.current, sessionId, text, action),
    [aTermRefs],
  )
  const handleReconnect = useCallback(() => {
    const handle = activeSessionId
      ? aTermRefs.current.get(activeSessionId)
      : undefined
    if (handle) {
      handle.reconnect()
      return
    }
    aTermRefs.current.values().next().value?.reconnect()
  }, [activeSessionId, aTermRefs])
  const handleNewATermForProject = useCallback(
    (targetProjectId: string, mode?: string, rootPath?: string | null) =>
      addProjectPaneAction(
        targetProjectId,
        mode,
        rootPath,
        projectATerms,
        panes,
        createProjectPane,
        navigateToSession,
        startAgent,
      ),
    [projectATerms, panes, createProjectPane, navigateToSession, startAgent],
  )

  const handleProjectModeChange = useCallback(
    async (
      projectIdArg: string,
      newMode: string,
      projectSessions: ATermSession[],
      paneId?: string,
      pane?: import('./use-a-term-panes').ATermPane,
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
  const setATermRef = useCallback(
    (sessionId: string, handle: ATermHandle | null) =>
      handle
        ? aTermRefs.current.set(sessionId, handle)
        : aTermRefs.current.delete(sessionId),
    [aTermRefs],
  )

  return {
    handleStatusChange,
    handleKeyboardInput,
    handleComposeInput,
    handleReconnect,
    handleNewATermForProject,
    handleProjectModeChange,
    setATermRef,
    navigateToSession,
    update,
    remove,
    reset,
    sessionsLoading,
    projectsLoading,
  }
}
