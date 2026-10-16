'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ATermHandle, ConnectionStatus } from '@/components/ATerm'
import type {
  KeyboardSizePreset,
  KeyboardSpacingPreset,
  MobileKeyboardMode,
} from '@/components/keyboard/types'
import { getDefaultLayoutMode, type LayoutMode } from '@/lib/constants/a-term'
import {
  findSessionByMode,
  generatePaneName,
  generateProjectPaneName,
} from '@/lib/hooks/a-term-handler-utils'
import { useATermHandlers } from '@/lib/hooks/use-a-term-handlers'
import {
  type AttachPaneRequest,
  type PanePlacementOptions,
  useATermPanes,
} from '@/lib/hooks/use-a-term-panes'
import { useATermSettings } from '@/lib/hooks/use-a-term-settings'
import { useActiveSession } from '@/lib/hooks/use-active-session'
import { useAutoCreatePane } from '@/lib/hooks/use-auto-create-pane'
import {
  useAvailableLayouts,
  usePaneCapacity,
} from '@/lib/hooks/use-available-layouts'
import { useLocalStorageState } from '@/lib/hooks/use-local-storage-state'
import { useMediaQuery } from '@/lib/hooks/use-media-query'
import { useProjectSettings } from '@/lib/hooks/use-project-settings'
import { useTabEditing } from '@/lib/hooks/use-tab-editing'
import { getScopedATermStorageKey } from '@/lib/utils/detached-pane-window'
import {
  getSlotPanelId,
  getSlotSessionId,
  isPaneSlot,
  paneSessionsAsSessions,
  sessionToSlot,
} from '@/lib/utils/slot'
import {
  useConnectionStatus,
  useLayoutAutoDowngrade,
} from './a-term-tabs-state/hooks'
import type { UseATermTabsStateProps } from './a-term-tabs-state/types'
import {
  getActiveSessionProjectId,
  getOrderedIds,
  getPanesToSlots,
  isGridLayoutMode,
  orderATermSlots,
  reconcileOrderedIds,
  swapOrderedIds,
} from './a-term-tabs-state/utils'
import {
  useBrowserWindowScopeId,
  useWindowPaneOwnership,
} from './use-window-pane-ownership'

export function useATermTabsState({
  projectId,
  projectPath,
  detachedPaneId,
  isDetachedPaneWindow = false,
  detachedWindowPaneIds = [],
  storageScopeId = null,
  addDetachedWindowPane,
  setDetachedWindowPaneIds,
}: UseATermTabsStateProps) {
  const isDetachedWindow = isDetachedPaneWindow || !!detachedPaneId
  const isMobile = useMediaQuery('(max-width: 767px)')
  const normalWindowScopeId = useBrowserWindowScopeId(
    !isDetachedWindow && !isMobile,
  )
  const effectiveStorageScopeId = storageScopeId ?? normalWindowScopeId
  const visibleDetachedPaneIds =
    detachedWindowPaneIds.length > 0
      ? detachedWindowPaneIds
      : detachedPaneId
        ? [detachedPaneId]
        : []
  const {
    activeSessionId,
    switchToSession,
    sessions,
    projectATerms,
    adHocSessions,
    externalSessions,
    isLoading: activeSessionLoading,
  } = useActiveSession({
    includeDetached: isDetachedWindow || isMobile,
    persistKey: getScopedATermStorageKey(
      'aTerm:last-active-session-id',
      effectiveStorageScopeId,
    ),
  })
  const { projects } = useProjectSettings()
  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  )

  const {
    panes,
    detachedPanes,
    atLimit: backendPanesAtLimit,
    isLoading: panesLoading,
    detachedLoadedOnce,
    hasLoadedOnce: panesLoadedOnce,
    swapPanePositions,
    removePane,
    detachPane,
    attachPane,
    setActiveMode,
    createAdHocPane,
    createProjectPane,
    isCreating: isPaneCreating,
    saveLayouts,
    maxPanes,
  } = useATermPanes()

  const viewportPaneCapacity = usePaneCapacity()
  const scopedDetachedPanes = useMemo(
    () =>
      visibleDetachedPaneIds.length === 0
        ? []
        : visibleDetachedPaneIds.flatMap((paneId) => {
            const pane = detachedPanes.find(
              (candidate) => candidate.id === paneId,
            )
            return pane ? [pane] : []
          }),
    [detachedPanes, visibleDetachedPaneIds],
  )
  const initialPaneCount = 1
  const initialViewportWidth = 0
  const [layoutMode, setLayoutMode] = useLocalStorageState<LayoutMode>(
    getScopedATermStorageKey('a-term-layout-mode', effectiveStorageScopeId),
    getDefaultLayoutMode(initialPaneCount, initialViewportWidth),
  )
  const activeSessionProjectId = useMemo(() => {
    const scopedProjectId =
      scopedDetachedPanes.find((pane) =>
        pane.sessions.some((session) => session.id === activeSessionId),
      )?.project_id ??
      scopedDetachedPanes[0]?.project_id ??
      undefined

    if (isDetachedWindow) {
      return (
        scopedProjectId ?? getActiveSessionProjectId(activeSessionId, sessions)
      )
    }

    return (
      getActiveSessionProjectId(activeSessionId, sessions) ?? scopedProjectId
    )
  }, [activeSessionId, isDetachedWindow, scopedDetachedPanes, sessions])
  const {
    fontId,
    fontSize,
    fontFamily,
    scrollback,
    cursorStyle,
    cursorBlink,
    themeId,
    theme,
    setFontId,
    setFontSize,
    setScrollback,
    setCursorStyle,
    setCursorBlink,
    setThemeId,
  } = useATermSettings(activeSessionProjectId)
  const [showSettings, setShowSettings] = useState(false)
  const [keyboardMode, setKeyboardMode] =
    useLocalStorageState<MobileKeyboardMode>('a-term-keyboard-mode', 'native')
  const [keyboardSize, setKeyboardSize] =
    useLocalStorageState<KeyboardSizePreset>('a-term-keyboard-size', 'medium')
  const [keyboardSpacing, setKeyboardSpacing] =
    useLocalStorageState<KeyboardSpacingPreset>(
      'a-term-keyboard-spacing',
      'normal',
    )
  const [storedSlotOrderIds, setStoredSlotOrderIds] = useLocalStorageState<
    string[]
  >(getScopedATermStorageKey('a-term-slot-order', effectiveStorageScopeId), [])
  const [attachedExternalSessionIds, setAttachedExternalSessionIds] =
    useLocalStorageState<string[]>(
      getScopedATermStorageKey(
        'a-term-attached-external-session-ids',
        effectiveStorageScopeId,
      ),
      [],
    )
  const [showATermManager, setShowATermManager] = useState(false)
  const aTermRefs = useRef<Map<string, ATermHandle>>(new Map())
  const [aTermStatuses, setATermStatuses] = useState<
    Map<string, ConnectionStatus>
  >(new Map())
  const projectTabRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const attachedExternalSessions = useMemo(() => {
    const sessionsById = new Map(
      externalSessions.map((session) => [session.id, session]),
    )
    return attachedExternalSessionIds.flatMap((sessionId) => {
      const session = sessionsById.get(sessionId)
      return session ? [session] : []
    })
  }, [attachedExternalSessionIds, externalSessions])
  const { visiblePanes: ownedWindowPanes, claimPane } = useWindowPaneOwnership(
    panes,
    {
      activeSessionId,
      enabled: !isDetachedWindow && !isMobile,
      windowId: normalWindowScopeId,
    },
  )
  const visiblePanes = useMemo(
    () => (isDetachedWindow ? scopedDetachedPanes : ownedWindowPanes),
    [isDetachedWindow, ownedWindowPanes, scopedDetachedPanes],
  )
  const createProjectPaneForWindow = useCallback(
    async (
      paneName: string,
      targetProjectId: string,
      workingDir?: string,
      agentToolSlug?: string,
      options?: PanePlacementOptions,
    ) => {
      const pane =
        agentToolSlug !== undefined || options !== undefined
          ? await createProjectPane(
              paneName,
              targetProjectId,
              workingDir,
              agentToolSlug,
              options,
            )
          : workingDir !== undefined
            ? await createProjectPane(paneName, targetProjectId, workingDir)
            : await createProjectPane(paneName, targetProjectId)
      if (!options?.detached) {
        claimPane(pane.id)
      }
      return pane
    },
    [claimPane, createProjectPane],
  )
  const createAdHocPaneForWindow = useCallback(
    async (
      paneName: string,
      workingDir?: string,
      options?: PanePlacementOptions,
    ) => {
      const pane =
        options !== undefined
          ? await createAdHocPane(paneName, workingDir, options)
          : workingDir !== undefined
            ? await createAdHocPane(paneName, workingDir)
            : await createAdHocPane(paneName)
      if (!options?.detached) {
        claimPane(pane.id)
      }
      return pane
    },
    [claimPane, createAdHocPane],
  )
  const attachPaneForWindow = useCallback(
    async (paneId: string, request?: AttachPaneRequest) => {
      const pane = await attachPane(paneId, request)
      if (!isDetachedWindow) {
        claimPane(pane.id)
      }
      return pane
    },
    [attachPane, claimPane, isDetachedWindow],
  )
  const mobileGlobalSlots = useMemo(() => {
    if (!isMobile || isDetachedWindow) {
      return []
    }

    const mobilePanes = [...panes, ...detachedPanes]
    const paneSlots = getPanesToSlots(mobilePanes)
    const paneSessionIds = new Set(
      mobilePanes.flatMap((pane) => pane.sessions.map((session) => session.id)),
    )
    const fallbackSessionSlots = sessions
      .filter((session) => !paneSessionIds.has(session.id))
      .map((session) =>
        sessionToSlot(session, {
          as: session.project_id ? 'project' : 'adhoc',
          place: session.is_external ? 'free' : 'unloaded',
          projectName: session.project_id
            ? projectNames.get(session.project_id)
            : undefined,
          slotId: `session-${session.id}`,
        }),
      )

    return [...paneSlots, ...fallbackSessionSlots]
  }, [detachedPanes, isDetachedWindow, isMobile, panes, projectNames, sessions])
  const visiblePaneCount = visiblePanes.length + attachedExternalSessions.length
  const visibleManagedPaneCount = visiblePanes.length
  const paneCountLimit = Math.min(maxPanes, viewportPaneCapacity)
  const visiblePanesAtLimit = visiblePaneCount >= paneCountLimit

  useEffect(() => {
    if (activeSessionLoading) return
    setAttachedExternalSessionIds((current) =>
      current.filter((sessionId) =>
        externalSessions.some((session) => session.id === sessionId),
      ),
    )
  }, [activeSessionLoading, externalSessions, setAttachedExternalSessionIds])

  const attachExternalSession = useCallback(
    (sessionId: string) => {
      setAttachedExternalSessionIds((current) =>
        current.includes(sessionId) ||
        current.length + visiblePanes.length >= paneCountLimit ||
        backendPanesAtLimit
          ? current
          : [...current, sessionId],
      )
    },
    [
      backendPanesAtLimit,
      paneCountLimit,
      visiblePanes.length,
      setAttachedExternalSessionIds,
    ],
  )

  const detachExternalSession = useCallback(
    (sessionId: string) => {
      setAttachedExternalSessionIds((current) =>
        current.filter((currentSessionId) => currentSessionId !== sessionId),
      )
    },
    [setAttachedExternalSessionIds],
  )

  const {
    handleKeyboardModeChange,
    handleKeyboardSizeChange,
    handleKeyboardSpacingChange,
    handleStatusChange,
    handleKeyboardInput,
    handleComposeInput,
    handleReconnect,
    handleLayoutModeChange,
    handleAddTab,
    handleNewATermForProject,
    handleProjectModeChange,
    handleCloseAll,
    setATermRef,
    update,
    remove,
    reset,
    resetAll,
    resetProject,
    disableProject,
    sessionsLoading,
    projectsLoading,
  } = useATermHandlers({
    projectATerms,
    activeSessionId,
    aTermRefs,
    projectTabRefs,
    setATermStatuses,
    setLayoutMode,
    setKeyboardMode,
    setKeyboardSize,
    setKeyboardSpacing,
    panes: visiblePanes,
    panesAtLimit: visiblePanesAtLimit,
    createProjectPane: createProjectPaneForWindow,
    createAdHocPane: createAdHocPaneForWindow,
    setActiveMode,
    removePane,
  })

  const isLoading =
    activeSessionLoading ||
    sessionsLoading ||
    projectsLoading ||
    panesLoading ||
    (isDetachedWindow && !detachedLoadedOnce)
  const availableLayouts = useAvailableLayouts(visiblePaneCount)
  const previousPaneCountRef = useRef<number | null>(null)

  const visibleSlots = useMemo(() => {
    const paneSlots = getPanesToSlots(visiblePanes)
    const externalSlots = attachedExternalSessions.map((session) =>
      sessionToSlot(session, {
        as: 'adhoc',
        place: 'free',
        projectName: session.project_id
          ? projectNames.get(session.project_id)
          : undefined,
      }),
    )
    return [...paneSlots, ...externalSlots]
  }, [attachedExternalSessions, projectNames, visiblePanes])
  const slotSource = useMemo(
    () => (isMobile && !isDetachedWindow ? mobileGlobalSlots : visibleSlots),
    [isDetachedWindow, isMobile, mobileGlobalSlots, visibleSlots],
  )
  const resolvedActiveSessionId = useMemo(() => {
    const visibleSessionIds = slotSource.flatMap((slot) => {
      const sessionId = getSlotSessionId(slot)
      return sessionId ? [sessionId] : []
    })

    if (
      activeSessionId &&
      visibleSessionIds.some((sessionId) => sessionId === activeSessionId)
    ) {
      return activeSessionId
    }

    // Picked without the user asking: one of their panes, or a View they
    // attached, never one of the phone's free-standing Views of other sessions.
    const pickableSessionIds = slotSource.flatMap((slot) => {
      const sessionId = getSlotSessionId(slot)
      return sessionId &&
        (isPaneSlot(slot) || attachedExternalSessionIds.includes(sessionId))
        ? [sessionId]
        : []
    })
    return (
      pickableSessionIds[0] ?? (panes.length === 0 ? activeSessionId : null)
    )
  }, [activeSessionId, attachedExternalSessionIds, panes.length, slotSource])
  const reconciledSlotOrderIds = useMemo(
    () => reconcileOrderedIds(slotSource, storedSlotOrderIds),
    [slotSource, storedSlotOrderIds],
  )
  useEffect(() => {
    if (
      !resolvedActiveSessionId ||
      resolvedActiveSessionId === activeSessionId
    ) {
      return
    }
    // Also once loaded with nothing active (only attached Views, say), so the
    // URL and remembered session follow what is on screen.
    if (activeSessionId || !isLoading) {
      switchToSession(resolvedActiveSessionId)
    }
  }, [activeSessionId, isLoading, resolvedActiveSessionId, switchToSession])
  useEffect(() => {
    if (activeSessionLoading) return
    if (
      JSON.stringify(reconciledSlotOrderIds) !==
      JSON.stringify(storedSlotOrderIds)
    ) {
      setStoredSlotOrderIds(reconciledSlotOrderIds)
    }
  }, [
    activeSessionLoading,
    reconciledSlotOrderIds,
    setStoredSlotOrderIds,
    storedSlotOrderIds,
  ])
  const aTermSlots = useMemo(
    () => orderATermSlots(slotSource, reconciledSlotOrderIds),
    [reconciledSlotOrderIds, slotSource],
  )
  const orderedIds = useMemo(() => getOrderedIds(aTermSlots), [aTermSlots])
  // On a phone every session is in the switcher, but only one the user opened
  // counts; other agents' sessions must not stop A-Term opening its own shell.
  const hasVisibleExternalSlot =
    attachedExternalSessions.length > 0 ||
    (isMobile && !isDetachedWindow && resolvedActiveSessionId !== null)
  const swapPanes = useCallback(
    async (slotIdA: string, slotIdB: string) => {
      const slotA = aTermSlots.find((slot) => getSlotPanelId(slot) === slotIdA)
      const slotB = aTermSlots.find((slot) => getSlotPanelId(slot) === slotIdB)
      if (!slotA || !slotB) return

      const currentOrderedIds = getOrderedIds(aTermSlots)
      const nextOrderedIds = swapOrderedIds(currentOrderedIds, slotIdA, slotIdB)
      if (nextOrderedIds === currentOrderedIds) return

      setStoredSlotOrderIds(nextOrderedIds)

      if (!isPaneSlot(slotA) || !isPaneSlot(slotB)) {
        return
      }

      try {
        await swapPanePositions(slotA.paneId, slotB.paneId)
      } catch (error) {
        setStoredSlotOrderIds(currentOrderedIds)
        throw error
      }
    },
    [setStoredSlotOrderIds, swapPanePositions, aTermSlots],
  )
  const canAddPane = useCallback(
    () =>
      isDetachedWindow
        ? visiblePaneCount < paneCountLimit
        : visiblePaneCount < paneCountLimit && !backendPanesAtLimit,
    [backendPanesAtLimit, isDetachedWindow, paneCountLimit, visiblePaneCount],
  )
  const isGridMode = isGridLayoutMode(layoutMode)
  const resolvedActiveStatus = useConnectionStatus(
    resolvedActiveSessionId,
    aTermStatuses,
  ).activeStatus

  // Derive active mode from the active session (for ControlBar model picker)
  const activeMode = useMemo<string | undefined>(() => {
    if (!resolvedActiveSessionId) return undefined
    const session = sessions.find((s) => s.id === resolvedActiveSessionId)
    return session?.mode
  }, [resolvedActiveSessionId, sessions])
  useLayoutAutoDowngrade(
    availableLayouts,
    layoutMode,
    setLayoutMode,
    panesLoadedOnce && !activeSessionLoading && visiblePaneCount > 0,
  )
  useEffect(() => {
    const previousPaneCount = previousPaneCountRef.current
    if (
      previousPaneCount !== null &&
      previousPaneCount !== visibleManagedPaneCount
    ) {
      if (visiblePaneCount === 2 && layoutMode !== 'split-horizontal') {
        setLayoutMode('split-horizontal')
      } else if (
        visiblePaneCount === 3 &&
        availableLayouts.includes('split-main-side') &&
        layoutMode !== 'split-main-side'
      ) {
        setLayoutMode('split-main-side')
      }
    }
    previousPaneCountRef.current = visibleManagedPaneCount
  }, [
    availableLayouts,
    layoutMode,
    setLayoutMode,
    visibleManagedPaneCount,
    visiblePaneCount,
  ])
  useAutoCreatePane({
    enabled: !isDetachedWindow && !projectId,
    panes: visiblePanes,
    hasVisibleExternalSlot,
    isLoading,
    hasLoadedOnce: panesLoadedOnce,
    isPaneCreating,
    createAdHocPane: createAdHocPaneForWindow,
    switchToSession,
  })
  const tabEditingProps = useTabEditing({
    onSave: async (sessionId: string, newName: string) => {
      await update(sessionId, { name: newName })
    },
  })
  const handleDetachedAddTab = useCallback(async () => {
    const newPane = await createAdHocPane(
      generatePaneName(
        'Ad-Hoc A-Term',
        detachedPanes.filter((pane) => pane.pane_type === 'adhoc').length,
      ),
      undefined,
      { detached: true },
    )
    const targetSessionId =
      findSessionByMode(newPane, 'shell')?.id ?? newPane.sessions[0]?.id ?? null
    if (!targetSessionId) return
    addDetachedWindowPane?.(newPane.id, targetSessionId)
  }, [addDetachedWindowPane, createAdHocPane, detachedPanes])
  const handleDetachedNewATermForProject = useCallback(
    async (
      targetProjectId: string,
      mode?: string,
      rootPath?: string | null,
    ) => {
      const requestedMode = mode ?? undefined
      const newPane = await createProjectPane(
        generateProjectPaneName(targetProjectId, [...panes, ...detachedPanes]),
        targetProjectId,
        rootPath ?? undefined,
        requestedMode && requestedMode !== 'shell' ? requestedMode : undefined,
        { detached: true },
      )
      const targetMode = requestedMode ?? newPane.active_mode
      const targetSessionId =
        findSessionByMode(newPane, targetMode)?.id ??
        findSessionByMode(newPane, 'shell')?.id ??
        newPane.sessions[0]?.id ??
        null
      if (!targetSessionId) return
      addDetachedWindowPane?.(newPane.id, targetSessionId)
      if (targetMode !== 'shell') {
        await handleProjectModeChange(
          targetProjectId,
          targetMode,
          paneSessionsAsSessions(newPane),
          newPane.id,
          newPane,
        )
        addDetachedWindowPane?.(newPane.id, targetSessionId)
        return
      }
    },
    [
      addDetachedWindowPane,
      createProjectPane,
      detachedPanes,
      handleProjectModeChange,
      panes,
    ],
  )
  const startupLaunchKeyRef = useRef<string | null>(null)
  const handleCloseAllWithDetachedExternal = useCallback(async () => {
    setAttachedExternalSessionIds([])
    setStoredSlotOrderIds([])
    if (isDetachedWindow) {
      setDetachedWindowPaneIds?.([], null)
      return
    }
    await handleCloseAll()
  }, [
    handleCloseAll,
    isDetachedWindow,
    setAttachedExternalSessionIds,
    setDetachedWindowPaneIds,
    setStoredSlotOrderIds,
  ])

  useEffect(() => {
    if (!projectId) {
      startupLaunchKeyRef.current = null
      return
    }
    if (
      isDetachedWindow ||
      isLoading ||
      isPaneCreating ||
      visiblePanesAtLimit
    ) {
      return
    }

    const startupKey = `${projectId}:${projectPath ?? ''}`
    if (startupLaunchKeyRef.current === startupKey) {
      return
    }

    // A project link opens one of the user's own sessions (or a View they
    // attached), never a free-standing View of another app's or agent's
    // session; with none of those it opens a new project pane.
    const projectATerm = projectATerms.find(
      (aTerm) => aTerm.projectId === projectId,
    )
    const ownSessions = (projectATerm?.sessions ?? [])
      .map(({ session }) => session)
      .filter(
        (session) =>
          !session.is_external ||
          attachedExternalSessionIds.includes(session.id),
      )
    const existingSessionId =
      ownSessions.find((session) => session.mode === projectATerm?.activeMode)
        ?.id ??
      ownSessions.find((session) => session.mode === 'shell')?.id ??
      ownSessions[0]?.id ??
      null

    if (existingSessionId) {
      startupLaunchKeyRef.current = startupKey
      const visibleSessionIds = new Set(
        visiblePanes.flatMap((pane) =>
          pane.sessions.map((session) => session.id),
        ),
      )
      if (
        existingSessionId !== activeSessionId &&
        (panes.length === 0 || visibleSessionIds.has(existingSessionId))
      ) {
        switchToSession(existingSessionId)
      }
      return
    }

    startupLaunchKeyRef.current = startupKey
    createProjectPaneForWindow(
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
    attachedExternalSessionIds,
    createProjectPaneForWindow,
    isLoading,
    isDetachedWindow,
    isPaneCreating,
    panes,
    visiblePanes,
    visiblePanesAtLimit,
    projectId,
    projectPath,
    projectATerms,
    switchToSession,
  ])
  const effectiveHandleAddTab = isDetachedWindow
    ? handleDetachedAddTab
    : handleAddTab
  const effectiveHandleNewATermForProject = isDetachedWindow
    ? handleDetachedNewATermForProject
    : handleNewATermForProject

  return {
    activeSessionId: resolvedActiveSessionId,
    switchToSession,
    sessions,
    projectATerms,
    adHocSessions,
    externalSessions,
    isLoading,
    storageScopeId: effectiveStorageScopeId,
    layoutMode,
    setLayoutMode,
    availableLayouts,
    isGridMode,
    aTermSlots,
    orderedIds,
    swapPanes,
    canAddPane,
    panes,
    detachedPanes,
    panesAtLimit: visiblePanesAtLimit,
    attachExternalSession,
    detachExternalSession,
    attachDetachedPane: attachPaneForWindow,
    detachPane,
    removePane,
    setActiveMode,
    createAdHocPane: createAdHocPaneForWindow,
    createProjectPane: createProjectPaneForWindow,
    isPaneCreating,
    saveLayouts,
    aTermRefs,
    aTermStatuses,
    projectTabRefs,
    setATermRef,
    fontId,
    fontSize,
    fontFamily,
    scrollback,
    cursorStyle,
    cursorBlink,
    themeId,
    theme,
    setFontId,
    setFontSize,
    setScrollback,
    setCursorStyle,
    setCursorBlink,
    setThemeId,
    showSettings,
    setShowSettings,
    keyboardMode,
    keyboardSize,
    keyboardSpacing,
    handleKeyboardModeChange,
    handleKeyboardSizeChange,
    handleKeyboardSpacingChange,
    isMobile,
    showATermManager,
    setShowATermManager,
    activeMode,
    activeStatus: resolvedActiveStatus,
    ...tabEditingProps,
    handleStatusChange,
    handleKeyboardInput,
    handleComposeInput,
    handleReconnect,
    handleLayoutModeChange,
    handleAddTab: effectiveHandleAddTab,
    handleNewATermForProject: effectiveHandleNewATermForProject,
    handleProjectModeChange,
    handleCloseAll: handleCloseAllWithDetachedExternal,
    resetProject,
    disableProject,
    reset,
    resetAll,
    remove,
  }
}
