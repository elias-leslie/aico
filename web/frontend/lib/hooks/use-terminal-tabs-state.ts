'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardSizePreset } from '@/components/keyboard/types'
import type { ConnectionStatus, TerminalHandle } from '@/components/Terminal'
import { useActiveSession } from '@/lib/hooks/use-active-session'
import { useAutoCreatePane } from '@/lib/hooks/use-auto-create-pane'
import {
  useAvailableLayouts,
  usePaneCapacity,
} from '@/lib/hooks/use-available-layouts'
import {
  getDefaultLayoutMode,
  type LayoutMode,
} from '@/lib/constants/terminal'
import { useLocalStorageState } from '@/lib/hooks/use-local-storage-state'
import { useMediaQuery } from '@/lib/hooks/use-media-query'
import { useTabEditing } from '@/lib/hooks/use-tab-editing'
import { useTerminalHandlers } from '@/lib/hooks/use-terminal-handlers'
import { useTerminalPanes } from '@/lib/hooks/use-terminal-panes'
import { useTerminalSettings } from '@/lib/hooks/use-terminal-settings'
import {
  findSessionByMode,
  generateProjectPaneName,
} from '@/lib/hooks/terminal-handler-utils'
import { getSlotPanelId, isPaneSlot } from '@/lib/utils/slot'
import type { UseTerminalTabsStateProps } from './terminal-tabs-state/types'
import {
  getActiveSessionProjectId,
  getPanesToSlots,
  getOrderedIds,
  isGridLayoutMode,
  orderTerminalSlots,
  reconcileOrderedIds,
  swapOrderedIds,
} from './terminal-tabs-state/utils'
import {
  useLayoutAutoDowngrade,
  useConnectionStatus,
} from './terminal-tabs-state/hooks'

export function useTerminalTabsState({ projectId, projectPath }: UseTerminalTabsStateProps) {
  const {
    activeSessionId,
    switchToSession,
    sessions,
    projectTerminals,
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
  } = useTerminalPanes()

  const viewportPaneCapacity = usePaneCapacity()
  const initialPaneCount = 1
  const initialViewportWidth = 0
  const [layoutMode, setLayoutMode] = useLocalStorageState<LayoutMode>(
    'terminal-layout-mode',
    getDefaultLayoutMode(initialPaneCount, initialViewportWidth),
  )
  const activeSessionProjectId = useMemo(() => getActiveSessionProjectId(activeSessionId, sessions), [activeSessionId, sessions])
  const { fontId, fontSize, fontFamily, scrollback, cursorStyle, cursorBlink, themeId, theme, setFontId, setFontSize, setScrollback, setCursorStyle, setCursorBlink, setThemeId } = useTerminalSettings(activeSessionProjectId)
  const isMobile = useMediaQuery('(max-width: 767px)')
  const [showSettings, setShowSettings] = useState(false)
  const [keyboardSize, setKeyboardSize] = useLocalStorageState<KeyboardSizePreset>('terminal-keyboard-size', 'medium')
  const [storedSlotOrderIds, setStoredSlotOrderIds] = useLocalStorageState<string[]>('terminal-slot-order', [])
  const [attachedExternalSessionIds, setAttachedExternalSessionIds] = useLocalStorageState<string[]>(
    'terminal-attached-external-session-ids',
    [],
  )
  const [showTerminalManager, setShowTerminalManager] = useState(false)
  const terminalRefs = useRef<Map<string, TerminalHandle>>(new Map())
  const [terminalStatuses, setTerminalStatuses] = useState<Map<string, ConnectionStatus>>(new Map())
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
    handleNewTerminalForProject,
    handleProjectModeChange,
    handleCloseAll,
    setTerminalRef,
    update,
    remove,
    reset,
    resetAll,
    resetProject,
    disableProject,
    sessionsLoading,
    projectsLoading,
  } = useTerminalHandlers({
    projectTerminals,
    activeSessionId,
    terminalRefs,
    projectTabRefs,
    setTerminalStatuses,
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
  const terminalSlots = useMemo(
    () => orderTerminalSlots(visibleSlots, reconciledSlotOrderIds),
    [reconciledSlotOrderIds, visibleSlots],
  )
  const orderedIds = useMemo(() => getOrderedIds(terminalSlots), [terminalSlots])
  const hasVisibleExternalSlot = attachedExternalSessions.length > 0
  const swapPanes = useCallback(
    async (slotIdA: string, slotIdB: string) => {
      const slotA = terminalSlots.find((slot) => getSlotPanelId(slot) === slotIdA)
      const slotB = terminalSlots.find((slot) => getSlotPanelId(slot) === slotIdB)
      if (!slotA || !slotB) return

      const currentOrderedIds = getOrderedIds(terminalSlots)
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
    [setStoredSlotOrderIds, swapPanePositions, terminalSlots],
  )
  const canAddPane = useCallback(
    () => visiblePaneCount < paneCountLimit && !backendPanesAtLimit,
    [backendPanesAtLimit, paneCountLimit, visiblePaneCount],
  )
  const isGridMode = isGridLayoutMode(layoutMode)
  const { activeStatus } = useConnectionStatus(activeSessionId, terminalStatuses)

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

    const projectTerminal = projectTerminals.find(
      (terminal) => terminal.projectId === projectId,
    )
    const existingSessionId =
      projectTerminal?.activeSessionId ??
      projectTerminal?.sessions.find((session) => session.session.mode === 'shell')
        ?.session.id ??
      projectTerminal?.sessions[0]?.session.id ??
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
    projectTerminals,
    switchToSession,
  ])

  return {
    activeSessionId,
    switchToSession,
    sessions,
    projectTerminals,
    adHocSessions,
    externalSessions,
    isLoading,
    layoutMode,
    setLayoutMode,
    availableLayouts,
    isGridMode,
    terminalSlots,
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
    terminalRefs,
    terminalStatuses,
    projectTabRefs,
    setTerminalRef,
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
    showTerminalManager,
    setShowTerminalManager,
    activeMode,
    activeStatus,
    ...tabEditingProps,
    handleStatusChange,
    handleKeyboardInput,
    handleReconnect,
    handleLayoutModeChange,
    handleAddTab,
    handleNewTerminalForProject,
    handleProjectModeChange,
    handleCloseAll: handleCloseAllWithDetachedExternal,
    resetProject,
    disableProject,
    reset,
    resetAll,
    remove,
  }
}
