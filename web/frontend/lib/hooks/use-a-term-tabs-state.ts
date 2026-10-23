'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ATermHandle, ConnectionStatus } from '@/components/ATerm'
import {
  findSessionByMode,
  generateProjectPaneName,
} from '@/lib/hooks/a-term-handler-utils'
import { useATermHandlers } from '@/lib/hooks/use-a-term-handlers'
import { useATermPanes } from '@/lib/hooks/use-a-term-panes'
import { useATermSettings } from '@/lib/hooks/use-a-term-settings'
import { useActiveSession } from '@/lib/hooks/use-active-session'
import { useMediaQuery } from '@/lib/hooks/use-media-query'
import { useProjectSettings } from '@/lib/hooks/use-project-settings'
import { getSlotSessionId, isPaneSlot } from '@/lib/utils/slot'
import {
  buildSessionSlots,
  getActiveSessionProjectId,
} from './a-term-tabs-state/utils'

interface UseATermTabsStateProps {
  projectId?: string
  projectPath?: string
}

/**
 * One session on screen at a time. The switcher lists every session; new
 * sessions are created detached, so no layout or pane limit applies.
 */
export function useATermTabsState({
  projectId,
  projectPath,
}: UseATermTabsStateProps) {
  const isMobile = useMediaQuery('(max-width: 767px)')
  const {
    activeSessionId,
    switchToSession,
    sessions,
    projectATerms,
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
    removePane,
    setActiveMode,
    createAdHocPane,
    createProjectPane,
    isCreating: isPaneCreating,
  } = useATermPanes()
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
  const createDetachedAdHocPane = useCallback(
    (paneName: string, workingDir?: string) =>
      createAdHocPane(paneName, workingDir, { detached: true }),
    [createAdHocPane],
  )

  const { fontSize, setFontSize } = useATermSettings(
    getActiveSessionProjectId(activeSessionId, sessions),
  )
  const [showSettings, setShowSettings] = useState(false)
  const [showATermManager, setShowATermManager] = useState(false)
  const aTermRefs = useRef<Map<string, ATermHandle>>(new Map())
  const [aTermStatuses, setATermStatuses] = useState<
    Map<string, ConnectionStatus>
  >(new Map())
  const projectTabRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  const {
    handleStatusChange,
    handleKeyboardInput,
    handleComposeInput,
    handleReconnect,
    handleAddTab,
    handleNewATermForProject,
    handleProjectModeChange,
    setATermRef,
    remove,
    reset,
    sessionsLoading,
    projectsLoading,
  } = useATermHandlers({
    projectATerms,
    activeSessionId,
    aTermRefs,
    projectTabRefs,
    setATermStatuses,
    panes,
    createProjectPane: createDetachedProjectPane,
    createAdHocPane: createDetachedAdHocPane,
    setActiveMode,
  })

  const isLoading =
    activeSessionLoading || sessionsLoading || projectsLoading || panesLoading

  const aTermSlots = useMemo(
    () => buildSessionSlots(panes, sessions, projectNames),
    [panes, projectNames, sessions],
  )
  const resolvedActiveSessionId = useMemo(() => {
    if (
      activeSessionId &&
      aTermSlots.some((slot) => getSlotSessionId(slot) === activeSessionId)
    ) {
      return activeSessionId
    }
    // Picked without the user asking: one of their own panes, never another
    // app's or agent's session.
    const ownSlot = aTermSlots.find(isPaneSlot)
    return ownSlot ? getSlotSessionId(ownSlot) : null
  }, [activeSessionId, aTermSlots])
  useEffect(() => {
    if (
      !resolvedActiveSessionId ||
      resolvedActiveSessionId === activeSessionId
    ) {
      return
    }
    if (activeSessionId || !isLoading) {
      switchToSession(resolvedActiveSessionId)
    }
  }, [activeSessionId, isLoading, resolvedActiveSessionId, switchToSession])

  const activeStatus = resolvedActiveSessionId
    ? aTermStatuses.get(resolvedActiveSessionId)
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
    if (isLoading || isPaneCreating) return

    const startupKey = `${projectId}:${projectPath ?? ''}`
    if (startupLaunchKeyRef.current === startupKey) return
    startupLaunchKeyRef.current = startupKey

    // A project link opens one of the user's own sessions, never another
    // app's or agent's session; with none, it starts a new one.
    const projectATerm = projectATerms.find(
      (aTerm) => aTerm.projectId === projectId,
    )
    const ownSessions = (projectATerm?.sessions ?? [])
      .map(({ session }) => session)
      .filter((session) => !session.is_external)
    const existingSessionId =
      ownSessions.find((session) => session.mode === projectATerm?.activeMode)
        ?.id ??
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
    projectId,
    projectPath,
    projectATerms,
    switchToSession,
  ])

  return {
    activeSessionId: resolvedActiveSessionId,
    switchToSession,
    sessions,
    projectATerms,
    externalSessions,
    isLoading,
    aTermSlots,
    panes,
    removePane,
    isPaneCreating,
    aTermRefs,
    aTermStatuses,
    setATermRef,
    fontSize,
    setFontSize,
    showSettings,
    setShowSettings,
    isMobile,
    showATermManager,
    setShowATermManager,
    activeMode,
    activeStatus,
    handleStatusChange,
    handleKeyboardInput,
    handleComposeInput,
    handleReconnect,
    handleAddTab,
    handleNewATermForProject,
    handleProjectModeChange,
    reset,
    remove,
  }
}
