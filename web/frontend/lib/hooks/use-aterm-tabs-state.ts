'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardSizePreset } from '@/components/keyboard/types'
import type { ConnectionStatus, ATermHandle } from '@/components/ATerm'
import { useActiveSession } from '@/lib/hooks/use-active-session'
import { useAutoCreatePane } from '@/lib/hooks/use-auto-create-pane'
import {
  useAvailableLayouts,
  usePaneCapacity,
} from '@/lib/hooks/use-available-layouts'
import {
  getDefaultLayoutMode,
  type LayoutMode,
} from '@/lib/constants/aterm'
import { useLocalStorageState } from '@/lib/hooks/use-local-storage-state'
import { useMediaQuery } from '@/lib/hooks/use-media-query'
import { useTabEditing } from '@/lib/hooks/use-tab-editing'
import { useATermHandlers } from '@/lib/hooks/use-aterm-handlers'
import { useATermPanes } from '@/lib/hooks/use-aterm-panes'
import { useATermSettings } from '@/lib/hooks/use-aterm-settings'
import {
  findSessionByMode,
  generateProjectPaneName,
} from '@/lib/hooks/aterm-handler-utils'
import { getSlotPanelId, isPaneSlot } from '@/lib/utils/slot'
import type { UseATermTabsStateProps } from './aterm-tabs-state/types'
import {
  getActiveSessionProjectId,
  getPanesToSlots,
  getOrderedIds,
  isGridLayoutMode,
  orderATermSlots,
  reconcileOrderedIds,
  swapOrderedIds,
} from './aterm-tabs-state/utils'
import {
  useLayoutAutoDowngrade,
  useConnectionStatus,
} from './aterm-tabs-state/hooks'

export function useATermTabsState({ projectId, projectPath }: UseATermTabsStateProps) {
  const {
    activeSessionId,
    switchToSession,
    sessions,
    projectATerms,
    adHocSessions,
    externalSessions,
    isLoading: activeSessionLoading,
  } = useActiveSession()

  const {
    panes,
    detachedPanes,
    atLimit: backendPanesAtLimit,
    isLoading: panesLoading,
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
  const initialPaneCount = 1
  const initialViewportWidth = 0
  const [layoutMode, setLayoutMode] = useLocalStorageState<LayoutMode>(
    'aterm-layout-mode',
    getDefaultLayoutMode(initialPaneCount, initialViewportWidth),
  )
  const activeSessionProjectId = useMemo(() => getActiveSessionProjectId(activeSessionId, sessions), [activeSessionId, sessions])
  const { fontId, fontSize, fontFamily, scrollback, cursorStyle, cursorBlink, themeId, theme, setFontId, setFontSize, setScrollback, setCursorStyle, setCursorBlink, setThemeId } = useATermSettings(activeSessionProjectId)
  const isMobile = useMediaQuery('(max-width: 767px)')
  const [showSettings, setShowSettings] = useState(false)
  const [keyboardSize, setKeyboardSize] = useLocalStorageState<KeyboardSizePreset>('aterm-keyboard-size', 'medium')
  const [storedSlotOrderIds, setStoredSlotOrderIds] = useLocalStorageState<string[]>('aterm-slot-order', [])
  const [attachedExternalSessionIds, setAttachedExternalSessionIds] = useLocalStorageState<string[]>(
    'aterm-attached-external-session-ids',
    [],
  )
  const [showATermManager, setShowATermManager] = useState(false)
  const atermRefs = useRef<Map<string, ATermHandle>>(new Map())
  const [atermStatuses, setATermStatuses] = useState<Map<string, ConnectionStatus>>(new Map())
  const projectTabRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const attachedExternalSessions = useMemo(() => {
    const sessionsById = new Map(externalSessions.map((session) => [session.id, session]))
    return attachedExternalSessionIds.flatMap((sessionId) => {
      const session = sessionsById.get(sessionId)
      return session ? [session] : []
    })
  }, [attachedExternalSessionIds, externalSessions])
  const visiblePaneCount = panes.length + attachedExternalSessions.length
  const paneCountLimit = Math.min(maxPanes, viewportPaneCapacity)
  const visiblePanesAtLimit = visiblePaneCount >= paneCountLimit

  useEffect(() => {
    if (activeSessionLoading) return
    setAttachedExternalSessionIds((current) =>
      current.filter((sessionId) => externalSessions.some((session) => session.id === sessionId)),
    )
  }, [activeSessionLoading, externalSessions, setAttachedExternalSessionIds])

  const attachExternalSession = useCallback((sessionId: string) => {
    setAttachedExternalSessionIds((current) =>
      current.includes(sessionId) || current.length + panes.length >= paneCountLimit || backendPanesAtLimit
        ? current
        : [...current, sessionId],
    )
  }, [
    backendPanesAtLimit,
    paneCountLimit,
    panes.length,
    setAttachedExternalSessionIds,
  ])

  const detachExternalSession = useCallback((sessionId: string) => {
    setAttachedExternalSessionIds((current) =>
      current.filter((currentSessionId) => currentSessionId !== sessionId),
    )
  }, [setAttachedExternalSessionIds])

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
    atermRefs,
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

  const isLoading = activeSessionLoading || sessionsLoading || projectsLoading || panesLoading
  const availableLayouts = useAvailableLayouts(visiblePaneCount)
  const visibleSlots = useMemo(() => {
    const paneSlots = getPanesToSlots(panes)
    const externalSlots = attachedExternalSessions.map((session) => ({
      type: 'adhoc' as const,
      sessionId: session.id,
      name: session.name,
      workingDir: session.working_dir,
      sessionMode: session.mode,
      isExternal: true,
    }))
    return [...paneSlots, ...externalSlots]
  }, [attachedExternalSessions, panes])
  const reconciledSlotOrderIds = useMemo(
    () => reconcileOrderedIds(visibleSlots, storedSlotOrderIds),
    [storedSlotOrderIds, visibleSlots],
  )
  useEffect(() => {
    if (activeSessionLoading) return
    if (JSON.stringify(reconciledSlotOrderIds) !== JSON.stringify(storedSlotOrderIds)) {
      setStoredSlotOrderIds(reconciledSlotOrderIds)
    }
  }, [
    activeSessionLoading,
    reconciledSlotOrderIds,
    setStoredSlotOrderIds,
    storedSlotOrderIds,
  ])
  const atermSlots = useMemo(
    () => orderATermSlots(visibleSlots, reconciledSlotOrderIds),
    [reconciledSlotOrderIds, visibleSlots],
  )
  const orderedIds = useMemo(() => getOrderedIds(atermSlots), [atermSlots])
  const hasVisibleExternalSlot = attachedExternalSessions.length > 0
  const swapPanes = useCallback(
    async (slotIdA: string, slotIdB: string) => {
      const slotA = atermSlots.find((slot) => getSlotPanelId(slot) === slotIdA)
      const slotB = atermSlots.find((slot) => getSlotPanelId(slot) === slotIdB)
      if (!slotA || !slotB) return

      const currentOrderedIds = getOrderedIds(atermSlots)
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
    [setStoredSlotOrderIds, swapPanePositions, atermSlots],
  )
  const canAddPane = useCallback(
    () => visiblePaneCount < paneCountLimit && !backendPanesAtLimit,
    [backendPanesAtLimit, paneCountLimit, visiblePaneCount],
  )
  const isGridMode = isGridLayoutMode(layoutMode)
  const { activeStatus } = useConnectionStatus(activeSessionId, atermStatuses)

  // Derive active mode from the active session (for ControlBar model picker)
  const activeMode = useMemo<string | undefined>(() => {
    if (!activeSessionId) return undefined
    const session = sessions.find((s) => s.id === activeSessionId)
    return session?.mode
  }, [activeSessionId, sessions])
  useLayoutAutoDowngrade(
    availableLayouts,
    layoutMode,
    setLayoutMode,
    panesLoadedOnce && !activeSessionLoading && visiblePaneCount > 0,
  )
  useAutoCreatePane({
    panes,
    hasVisibleExternalSlot,
    isLoading,
    hasLoadedOnce: panesLoadedOnce,
    isPaneCreating,
    createAdHocPane,
    switchToSession,
  })
  const tabEditingProps = useTabEditing({ onSave: async (sessionId: string, newName: string) => { await update(sessionId, { name: newName }) } })
  const startupLaunchKeyRef = useRef<string | null>(null)
  const handleCloseAllWithDetachedExternal = useCallback(async () => {
    setAttachedExternalSessionIds([])
    setStoredSlotOrderIds([])
    await handleCloseAll()
  }, [handleCloseAll, setAttachedExternalSessionIds, setStoredSlotOrderIds])

  useEffect(() => {
    if (!projectId) {
      startupLaunchKeyRef.current = null
      return
    }
    if (isLoading || isPaneCreating || visiblePanesAtLimit) {
      return
    }

    const startupKey = `${projectId}:${projectPath ?? ''}`
    if (startupLaunchKeyRef.current === startupKey) {
      return
    }

    const projectATerm = projectATerms.find(
      (aterm) => aterm.projectId === projectId,
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
    isPaneCreating,
    panes,
    visiblePanesAtLimit,
    projectId,
    projectPath,
    projectATerms,
    switchToSession,
  ])

  return {
    activeSessionId,
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
    atermSlots,
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
    atermRefs,
    atermStatuses,
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
    activeStatus,
    ...tabEditingProps,
    handleStatusChange,
    handleKeyboardInput,
    handleReconnect,
    handleLayoutModeChange,
    handleAddTab,
    handleNewATermForProject,
    handleProjectModeChange,
    handleCloseAll: handleCloseAllWithDetachedExternal,
    resetProject,
    disableProject,
    reset,
    resetAll,
    remove,
  }
}
