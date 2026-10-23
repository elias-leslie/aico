'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ConnectionStatus, TerminalHandle } from '@/components/Terminal'
import {
  findSessionByMode,
  generateProjectPaneName,
} from '@/lib/hooks/terminal-handler-utils'
import { useActiveSession } from '@/lib/hooks/use-active-session'
import { useMediaQuery } from '@/lib/hooks/use-media-query'
import { useProjectSettings } from '@/lib/hooks/use-project-settings'
import { useTerminalHandlers } from '@/lib/hooks/use-terminal-handlers'
import { useTerminalPanes } from '@/lib/hooks/use-terminal-panes'
import { useTerminalSettings } from '@/lib/hooks/use-terminal-settings'
import { getSlotSessionId, isPaneSlot } from '@/lib/utils/slot'
import {
  buildSessionSlots,
  getActiveSessionProjectId,
} from './terminal-tabs-state/utils'

interface UseTerminalTabsStateProps {
  projectId?: string
  projectPath?: string
}

/**
 * One session on screen at a time. The switcher lists every session; new
 * sessions are created detached, so no layout or pane limit applies.
 */
export function useTerminalTabsState({
  projectId,
  projectPath,
}: UseTerminalTabsStateProps) {
  const isMobile = useMediaQuery('(max-width: 767px)')
  const {
    activeSessionId,
    switchToSession,
    sessions,
    projectTerminals,
    externalSessions,
    isLoading: activeSessionLoading,
  } = useActiveSession({ includeDetached: true })
  const { projects } = useProjectSettings()
  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  )

  const {
    panes: attachedPanes,
    detachedPanes,
    isLoading: panesLoading,
    loadFailed: panesFailed,
    removePane,
    setActiveMode,
    createProjectPane,
    isCreating: isPaneCreating,
  } = useTerminalPanes()
  const panes = useMemo(
    () => [...attachedPanes, ...detachedPanes],
    [attachedPanes, detachedPanes],
  )
  const createDetachedProjectPane = useCallback(
    (
      paneName: string,
      targetProjectId: string,
      workingDir?: string,
      agentToolSlug?: string,
    ) =>
      createProjectPane(paneName, targetProjectId, workingDir, agentToolSlug, {
        detached: true,
      }),
    [createProjectPane],
  )
  const { fontSize, setFontSize } = useTerminalSettings(
    getActiveSessionProjectId(activeSessionId, sessions),
  )
  const [showTerminalManager, setShowTerminalManager] = useState(false)
  const terminalRefs = useRef<Map<string, TerminalHandle>>(new Map())
  const [terminalStatuses, setTerminalStatuses] = useState<
    Map<string, ConnectionStatus>
  >(new Map())
  const projectTabRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  const {
    handleStatusChange,
    handleKeyboardInput,
    handleComposeInput,
    handleReconnect,
    handleNewTerminalForProject,
    handleProjectModeChange,
    setTerminalRef,
    remove,
    reset,
    sessionsLoading,
    projectsLoading,
  } = useTerminalHandlers({
    projectTerminals,
    activeSessionId,
    terminalRefs,
    projectTabRefs,
    setTerminalStatuses,
    panes,
    createProjectPane: createDetachedProjectPane,
    setActiveMode,
  })

  const isLoading =
    activeSessionLoading || sessionsLoading || projectsLoading || panesLoading

  const terminalSlots = useMemo(
    () => buildSessionSlots(panes, sessions, projectNames),
    [panes, projectNames, sessions],
  )
  const resolvedActiveSessionId = useMemo(() => {
    if (
      activeSessionId &&
      terminalSlots.some((slot) => getSlotSessionId(slot) === activeSessionId)
    ) {
      return activeSessionId
    }
    // Picked without the user asking: one of their own panes, never another
    // app's or agent's session.
    const ownSlot = terminalSlots.find(isPaneSlot)
    return ownSlot ? getSlotSessionId(ownSlot) : null
  }, [activeSessionId, terminalSlots])
  useEffect(() => {
    if (
      !resolvedActiveSessionId ||
      resolvedActiveSessionId === activeSessionId
    ) {
      return
    }
    // Until every list has loaded, the chosen session may simply not be
    // listed yet.
    if (!isLoading) {
      switchToSession(resolvedActiveSessionId)
    }
  }, [activeSessionId, isLoading, resolvedActiveSessionId, switchToSession])

  const activeStatus = resolvedActiveSessionId
    ? terminalStatuses.get(resolvedActiveSessionId)
    : undefined
  // The active session's mode (for the key row's model picker)
  const activeMode = useMemo<string | undefined>(() => {
    if (!resolvedActiveSessionId) return undefined
    return sessions.find((s) => s.id === resolvedActiveSessionId)?.mode
  }, [resolvedActiveSessionId, sessions])

  const startupLaunchKeyRef = useRef<string | null>(null)
  useEffect(() => {
    if (!projectId) {
      startupLaunchKeyRef.current = null
      return
    }
    // A failed pane list can't show which sessions exist: start nothing.
    if (isLoading || isPaneCreating || panesFailed) return

    const startupKey = `${projectId}:${projectPath ?? ''}`
    if (startupLaunchKeyRef.current === startupKey) return
    startupLaunchKeyRef.current = startupKey

    // A project link opens one of the user's own sessions, never another
    // app's or agent's session; with none, it starts a new one.
    const projectTerminal = projectTerminals.find(
      (terminal) => terminal.projectId === projectId,
    )
    const ownSessions = (projectTerminal?.sessions ?? [])
      .map(({ session }) => session)
      .filter((session) => !session.is_external)
    const existingSessionId =
      ownSessions.find(
        (session) => session.mode === projectTerminal?.activeMode,
      )?.id ??
      ownSessions.find((session) => session.mode === 'shell')?.id ??
      ownSessions[0]?.id ??
      null

    if (existingSessionId) {
      if (existingSessionId !== activeSessionId) {
        switchToSession(existingSessionId)
      }
      return
    }

    createDetachedProjectPane(
      generateProjectPaneName(projectId, panes),
      projectId,
      projectPath ?? undefined,
    )
      .then((newPane) => {
        const targetSessionId =
          findSessionByMode(newPane, newPane.active_mode)?.id ??
          findSessionByMode(newPane, 'shell')?.id ??
          newPane.sessions[0]?.id
        if (targetSessionId) {
          switchToSession(targetSessionId)
        }
      })
      .catch(() => {
        startupLaunchKeyRef.current = null
      })
  }, [
    activeSessionId,
    createDetachedProjectPane,
    isLoading,
    isPaneCreating,
    panes,
    panesFailed,
    projectId,
    projectPath,
    projectTerminals,
    switchToSession,
  ])

  return {
    activeSessionId: resolvedActiveSessionId,
    switchToSession,
    sessions,
    projectTerminals,
    externalSessions,
    isLoading,
    terminalSlots,
    panes,
    removePane,
    isPaneCreating,
    terminalRefs,
    terminalStatuses,
    setTerminalRef,
    fontSize,
    setFontSize,
    isMobile,
    showTerminalManager,
    setShowTerminalManager,
    activeMode,
    activeStatus,
    handleStatusChange,
    handleKeyboardInput,
    handleComposeInput,
    handleReconnect,
    handleNewTerminalForProject,
    handleProjectModeChange,
    reset,
    remove,
  }
}
