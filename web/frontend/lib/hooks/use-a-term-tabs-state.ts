'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ATermHandle, ConnectionStatus } from '@/components/ATerm'
import type { KeyboardSizePreset } from '@/components/keyboard/types'
import { getDefaultLayoutMode, type LayoutMode } from '@/lib/constants/a-term'
import {
  findSessionByMode,
  generatePaneName,
  generateProjectPaneName,
} from '@/lib/hooks/a-term-handler-utils'
import { useATermHandlers } from '@/lib/hooks/use-a-term-handlers'
import { useATermPanes } from '@/lib/hooks/use-a-term-panes'
import { useATermSettings } from '@/lib/hooks/use-a-term-settings'
import { useActiveSession } from '@/lib/hooks/use-active-session'
import { useAutoCreatePane } from '@/lib/hooks/use-auto-create-pane'
import {
  useAvailableLayouts,
  usePaneCapacity,
} from '@/lib/hooks/use-available-layouts'
import { useLocalStorageState } from '@/lib/hooks/use-local-storage-state'
import { useMediaQuery } from '@/lib/hooks/use-media-query'
import { useTabEditing } from '@/lib/hooks/use-tab-editing'
import { getScopedATermStorageKey } from '@/lib/utils/detached-pane-window'
import { getSlotPanelId, getSlotSessionId, isPaneSlot } from '@/lib/utils/slot'
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
      storageScopeId,
    ),
  })

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
    getScopedATermStorageKey('a-term-layout-mode', storageScopeId),
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
  const [keyboardSize, setKeyboardSize] =
    useLocalStorageState<KeyboardSizePreset>('a-term-keyboard-size', 'medium')
  const [storedSlotOrderIds, setStoredSlotOrderIds] = useLocalStorageState<
    string[]
  >(getScopedATermStorageKey('a-term-slot-order', storageScopeId), [])
  const [attachedExternalSessionIds, setAttachedExternalSessionIds] =
    useLocalStorageState<string[]>(
      getScopedATermStorageKey(
        'a-term-attached-external-session-ids',
        storageScopeId,
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
  const visiblePanes = useMemo(
    () => (isDetachedWindow ? scopedDetachedPanes : panes),
    [isDetachedWindow, panes, scopedDetachedPanes],
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
    const projectNames = new Map(
      projectATerms.map((project) => [project.projectId, project.projectName]),
    )

    const fallbackSessionSlots = sessions
      .filter((session) => !paneSessionIds.has(session.id))
      .map((session) => {
        const slotId = `session-${session.id}`

        if (session.project_id) {
          return {
            slotId,
            type: 'project' as const,
            projectId: session.project_id,
            projectName: projectNames.get(session.project_id) ?? session.name,
            rootPath: session.working_dir,
            activeMode: session.mode,
            activeSessionId: session.id,
            sessionBadge: null,
            claudeState: session.claude_state,
          }
        }

        return {
          slotId,
          type: 'adhoc' as const,
          sessionId: session.id,
          name: session.name,
          workingDir: session.working_dir,
          sessionMode: session.mode,
          isExternal: session.is_external,
        }
      })

    return [...paneSlots, ...fallbackSessionSlots]
  }, [
    detachedPanes,
    isDetachedWindow,
    isMobile,
    panes,
    projectATerms,
    sessions,
  ])
  const visiblePaneCount = visiblePanes.length + attachedExternalSessions.length
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
        current.length + panes.length >= paneCountLimit ||
        backendPanesAtLimit
          ? current
          : [...current, sessionId],
      )
    },
    [
      backendPanesAtLimit,
      paneCountLimit,
      panes.length,
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
    setKeyboardSize,
    panes,
    panesAtLimit: visiblePanesAtLimit,
    createProjectPane,
    createAdHocPane,
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
  const previousVisiblePaneCountRef = useRef<number | null>(null)

  useEffect(() => {
    const previousVisiblePaneCount = previousVisiblePaneCountRef.current
    if (
      previousVisiblePaneCount !== null &&
      previousVisiblePaneCount !== visiblePaneCount &&
      visiblePaneCount === 3 &&
      availableLayouts.includes('split-main-side') &&
      layoutMode !== 'split-main-side'
    ) {
      setLayoutMode('split-main-side')
    }
    previousVisiblePaneCountRef.current = visiblePaneCount
  }, [availableLayouts, layoutMode, setLayoutMode, visiblePaneCount])

  const visibleSlots = useMemo(() => {
    const paneSlots = getPanesToSlots(visiblePanes)
    const externalSlots = attachedExternalSessions.map((session) => ({
      type: 'adhoc' as const,
      sessionId: session.id,
      name: session.name,
      workingDir: session.working_dir,
      sessionMode: session.mode,
      isExternal: true,
    }))
    return [...paneSlots, ...externalSlots]
  }, [attachedExternalSessions, visiblePanes])
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

    return visibleSessionIds[0] ?? activeSessionId
  }, [activeSessionId, slotSource])
  const reconciledSlotOrderIds = useMemo(
    () => reconcileOrderedIds(slotSource, storedSlotOrderIds),
    [slotSource, storedSlotOrderIds],
  )
  useEffect(() => {
    if (
      resolvedActiveSessionId &&
      activeSessionId &&
      resolvedActiveSessionId !== activeSessionId
    ) {
      switchToSession(resolvedActiveSessionId)
    }
  }, [activeSessionId, resolvedActiveSessionId, switchToSession])
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
  const hasVisibleExternalSlot =
    attachedExternalSessions.length > 0 ||
    (isMobile && !isDetachedWindow && mobileGlobalSlots.length > 0)
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
  useAutoCreatePane({
    enabled: !isDetachedWindow,
    panes: visiblePanes,
    hasVisibleExternalSlot,
    isLoading,
    hasLoadedOnce: panesLoadedOnce,
    isPaneCreating,
    createAdHocPane,
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
    switchToSession(targetSessionId)
  }, [addDetachedWindowPane, createAdHocPane, detachedPanes, switchToSession])
  const handleDetachedNewATermForProject = useCallback(
    async (
      targetProjectId: string,
      _mode?: string,
      rootPath?: string | null,
    ) => {
      const newPane = await createProjectPane(
        generateProjectPaneName(targetProjectId, [...panes, ...detachedPanes]),
        targetProjectId,
        rootPath ?? undefined,
        undefined,
        { detached: true },
      )
      const targetSessionId =
        findSessionByMode(newPane, newPane.active_mode)?.id ??
        findSessionByMode(newPane, 'shell')?.id ??
        newPane.sessions[0]?.id ??
        null
      if (!targetSessionId) return
      addDetachedWindowPane?.(newPane.id, targetSessionId)
      switchToSession(targetSessionId)
    },
    [
      addDetachedWindowPane,
      createProjectPane,
      detachedPanes,
      panes,
      switchToSession,
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

    const projectATerm = projectATerms.find(
      (aTerm) => aTerm.projectId === projectId,
    )
    const existingSessionId =
      projectATerm?.activeSessionId ??
      projectATerm?.sessions.find((session) => session.session.mode === 'shell')
        ?.session.id ??
      projectATerm?.sessions[0]?.session.id ??
      null

    if (existingSessionId) {
      startupLaunchKeyRef.current = startupKey
      if (existingSessionId !== activeSessionId) {
        switchToSession(existingSessionId)
      }
      return
    }

    startupLaunchKeyRef.current = startupKey
    createProjectPane(
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
    createProjectPane,
    isLoading,
    isDetachedWindow,
    isPaneCreating,
    panes,
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
    attachDetachedPane: attachPane,
    detachPane,
    removePane,
    setActiveMode,
    createAdHocPane,
    createProjectPane,
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
    keyboardSize,
    handleKeyboardSizeChange,
    isMobile,
    showATermManager,
    setShowATermManager,
    activeMode,
    activeStatus: resolvedActiveStatus,
    ...tabEditingProps,
    handleStatusChange,
    handleKeyboardInput,
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
