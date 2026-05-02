import { useCallback, useMemo, useState } from 'react'
import { useATermKeyboardShortcuts } from '@/components/KeyboardShortcuts'
import { getAgentHubVoiceWsUrl } from '@/lib/api-config'
import {
  DETACHED_PANE_PARAM,
  DETACHED_WINDOW_PANES_PARAM,
  DETACHED_WINDOW_SCOPE_PARAM,
} from '@/lib/utils/detached-pane-window'
import { type ATermSlot, isPaneSlot, type PaneSlot } from '@/lib/utils/slot'
import { useTranscription } from '@/lib/voice/use-transcription'
import {
  findSessionByMode,
  generateProjectPaneName,
} from './a-term-handler-utils'
import { useATermActionHandlers } from './use-a-term-action-handlers'
import { useATermModals } from './use-a-term-modals'
import { useATermNavigation } from './use-a-term-navigation'
import type { ATermSession } from './use-a-term-sessions'
import { useATermSlotHandlers } from './use-a-term-slot-handlers'
import { useATermTabsState } from './use-a-term-tabs-state'
import { useDetachedPaneWindow } from './use-detached-pane-window'
import { useLayoutPersistence } from './use-layout-persistence'
import { usePromptCleaner } from './use-prompt-cleaner'

interface UseATermOrchestrationProps {
  projectId?: string
  projectPath?: string
  detachedPaneId?: string
}

/**
 * Orchestrates all a-term state, handlers, and modals
 * This is the central hook that coordinates everything for ATermTabs
 */
export function useATermOrchestration({
  projectId,
  projectPath,
  detachedPaneId,
}: UseATermOrchestrationProps) {
  const detachedWindow = useDetachedPaneWindow({
    fallbackDetachedPaneId: detachedPaneId,
  })

  // Core aTerm state
  const aTermState = useATermTabsState({
    projectId,
    projectPath,
    detachedPaneId,
    isDetachedPaneWindow: detachedWindow.isDetachedPaneWindow,
    detachedWindowPaneIds: detachedWindow.detachedWindowPaneIds,
    storageScopeId: detachedWindow.storageScopeId,
    addDetachedWindowPane: detachedWindow.addDetachedWindowPane,
    setDetachedWindowPaneIds: detachedWindow.setDetachedWindowPaneIds,
  })

  const {
    activeSessionId,
    switchToSession,
    sessions,
    projectATerms = [],
    aTermSlots,
    orderedIds,
    aTermRefs,
    panes,
    reset,
    disableProject,
    remove,
    removePane,
    detachPane,
    handleProjectModeChange,
    attachExternalSession,
    attachDetachedPane,
    detachExternalSession,
    createProjectPane,
    detachedPanes,
    showATermManager,
    setShowATermManager,
    saveLayouts,
  } = aTermState

  // Prompt cleaner state
  const [showCleaner, setShowCleaner] = useState(false)
  const [cleanerRawPrompt, setCleanerRawPrompt] = useState('')
  const [keyboardHelpState, setKeyboardHelpState] = useState(false)
  const visibleDetachedPaneIds = useMemo(
    () => new Set(aTermSlots.filter(isPaneSlot).map((slot) => slot.paneId)),
    [aTermSlots],
  )
  const availableDetachedPanes = detachedWindow.isDetachedPaneWindow
    ? detachedPanes.filter((pane) => !visibleDetachedPaneIds.has(pane.id))
    : detachedPanes

  // Voice input state
  const [showVoice, setShowVoice] = useState(false)
  const transcription = useTranscription({
    whisperWsUrl: getAgentHubVoiceWsUrl(),
  })

  // Modal management
  const modalHandlers = useATermModals({
    showATermManager,
    setShowATermManager,
    showKeyboardHelp: keyboardHelpState,
    setShowKeyboardHelp: setKeyboardHelpState,
    onAttachExternalSession: attachExternalSession,
    onAttachDetachedPane: async (paneId) => {
      if (detachedWindow.isDetachedPaneWindow) {
        const pane = detachedPanes.find((candidate) => candidate.id === paneId)
        const sessionId =
          pane &&
          (findSessionByMode(pane, pane.active_mode)?.id ??
            findSessionByMode(pane, 'shell')?.id ??
            pane.sessions[0]?.id ??
            null)
        if (!sessionId) {
          return { sessionId: null }
        }
        const nextPaneIds = Array.from(visibleDetachedPaneIds)
        if (!nextPaneIds.includes(paneId)) {
          nextPaneIds.push(paneId)
        }
        return {
          sessionId,
          urlUpdates: {
            [DETACHED_PANE_PARAM]: nextPaneIds[0] ?? paneId,
            [DETACHED_WINDOW_PANES_PARAM]: nextPaneIds.join(','),
            [DETACHED_WINDOW_SCOPE_PARAM]: detachedWindow.detachedWindowScopeId,
          },
        }
      }
      const pane = await attachDetachedPane(paneId)
      return {
        sessionId:
          findSessionByMode(pane, pane.active_mode)?.id ??
          findSessionByMode(pane, 'shell')?.id ??
          pane.sessions[0]?.id ??
          null,
      }
    },
  })

  // Slot handlers
  const slotHandlers = useATermSlotHandlers({
    aTermRefs,
    switchToSession,
    activeSessionId,
    reset,
    disableProject,
    remove,
    detachExternalSession,
    detachedPaneId,
    detachPane,
    removePane,
    setShowCleaner,
    setCleanerRawPrompt,
    sessions,
    visibleSlots: aTermSlots,
    handleProjectModeChange,
    isDetachedPaneWindow: detachedWindow.isDetachedPaneWindow,
    removeDetachedWindowPane: detachedWindow.removeDetachedWindowPane,
  })

  // Layout persistence
  const { handleLayoutChange } = useLayoutPersistence({
    saveLayouts,
    storageScopeId: detachedWindow.storageScopeId,
    debounceMs: 500,
  })

  // A-Term navigation
  const navigationHandlers = useATermNavigation({
    aTermSlots,
    orderedIds,
    activeSessionId,
    onSlotSwitch: slotHandlers.handleSlotSwitch,
    onSlotClose: slotHandlers.handleSlotClose,
  })

  // File upload, prompt cleaner, and voice input
  const {
    cleanPrompt,
    error: cleanerError,
    clearError: clearCleanerError,
    isLoading: isCleaningPrompt,
  } = usePromptCleaner()
  const actionHandlers = useATermActionHandlers({
    aTermRefs,
    activeSessionId,
    showCleaner,
    setShowCleaner,
    setCleanerRawPrompt,
    setShowVoice,
    voiceStartListening: transcription.startListening,
    voiceStopListening: transcription.stopListening,
    voiceResetTranscript: transcription.resetTranscript,
    voiceStatus: transcription.status,
  })
  const buildProjectSessionsFromPane = useCallback(
    (pane: (typeof panes)[number]): ATermSession[] =>
      pane.sessions.map((session, index) => ({
        id: session.id,
        name: session.name,
        user_id: null,
        project_id: pane.project_id,
        working_dir: session.working_dir,
        mode: session.mode,
        display_order: index,
        is_alive: session.is_alive,
        created_at: pane.created_at,
        last_accessed_at: pane.created_at,
        agent_state: session.agent_state,
        claude_state: session.claude_state,
      })),
    [],
  )
  const alignTargetPaneMode = useCallback(
    async (
      pane: (typeof panes)[number],
      targetProjectId: string,
      desiredMode: string,
    ) => {
      const initialSessionId =
        findSessionByMode(pane, desiredMode)?.id ??
        findSessionByMode(pane, pane.active_mode)?.id ??
        findSessionByMode(pane, 'shell')?.id ??
        pane.sessions[0]?.id ??
        null

      if (pane.active_mode === desiredMode) {
        if (desiredMode !== 'shell') {
          await handleProjectModeChange(
            targetProjectId,
            desiredMode,
            buildProjectSessionsFromPane(pane),
            pane.id,
            pane,
          )
          return {
            didNavigate: true,
            sessionId: initialSessionId,
          }
        }
        return {
          didNavigate: false,
          sessionId: initialSessionId,
        }
      }

      await handleProjectModeChange(
        targetProjectId,
        desiredMode,
        buildProjectSessionsFromPane(pane),
        pane.id,
        pane,
      )

      return {
        didNavigate: true,
        sessionId: initialSessionId,
      }
    },
    [buildProjectSessionsFromPane, handleProjectModeChange],
  )
  const handleSlotProjectSwitch = useCallback(
    async (
      slot: PaneSlot,
      targetProjectId: string,
      rootPath: string | null,
    ) => {
      if (slot.type !== 'project' || slot.projectId === targetProjectId) {
        return
      }
      const targetProjectATerm =
        projectATerms.find(
          (project) => project.projectId === targetProjectId,
        ) ?? null

      const currentPane =
        [...panes, ...detachedPanes].find((pane) => pane.id === slot.paneId) ??
        null
      if (!currentPane) {
        return
      }

      const targetDetachedPane =
        detachedPanes.find(
          (pane) =>
            pane.id !== slot.paneId &&
            pane.pane_type === 'project' &&
            pane.project_id === targetProjectId,
        ) ?? null
      const desiredMode = targetDetachedPane
        ? targetDetachedPane.active_mode
        : slot.activeMode === 'shell'
          ? (targetProjectATerm?.activeMode ?? 'shell')
          : slot.activeMode

      if (detachedWindow.isDetachedPaneWindow) {
        const targetPane =
          targetDetachedPane ??
          (await createProjectPane(
            generateProjectPaneName(targetProjectId, [
              ...panes,
              ...detachedPanes,
            ]),
            targetProjectId,
            rootPath ?? undefined,
            desiredMode !== 'shell' ? desiredMode : undefined,
            { detached: true },
          ))
        const modeResult = await alignTargetPaneMode(
          targetPane,
          targetProjectId,
          desiredMode,
        )
        detachedWindow.replaceDetachedWindowPane(
          slot.paneId,
          targetPane.id,
          modeResult.sessionId,
        )
        return
      }

      const placement = {
        pane_order: currentPane.pane_order,
        width_percent: currentPane.width_percent,
        height_percent: currentPane.height_percent,
        grid_row: currentPane.grid_row,
        grid_col: currentPane.grid_col,
      }

      await detachPane(slot.paneId)

      try {
        const targetPane = targetDetachedPane
          ? await attachDetachedPane(targetDetachedPane.id, placement)
          : await createProjectPane(
              generateProjectPaneName(targetProjectId, [
                ...panes,
                ...detachedPanes,
              ]),
              targetProjectId,
              rootPath ?? undefined,
              desiredMode !== 'shell' ? desiredMode : undefined,
              {
                paneOrder: placement.pane_order,
                widthPercent: placement.width_percent,
                heightPercent: placement.height_percent,
                gridRow: placement.grid_row,
                gridCol: placement.grid_col,
              },
            )
        const modeResult = await alignTargetPaneMode(
          targetPane,
          targetProjectId,
          desiredMode,
        )
        if (!modeResult.didNavigate && modeResult.sessionId) {
          switchToSession(modeResult.sessionId)
        }
      } catch (error) {
        await attachDetachedPane(slot.paneId, placement).catch(() => undefined)
        throw error
      }
    },
    [
      alignTargetPaneMode,
      attachDetachedPane,
      createProjectPane,
      detachPane,
      detachedPanes,
      detachedWindow,
      panes,
      projectATerms,
      switchToSession,
    ],
  )

  // Pause key: first press opens voice, second press sends transcript
  const handlePauseVoiceSend = useCallback(() => {
    const text = transcription.finalTranscript.trim()
    if (text) {
      actionHandlers.handleVoiceSend(text)
    } else {
      actionHandlers.handleVoiceCancel()
    }
  }, [transcription.finalTranscript, actionHandlers])

  // Keyboard shortcuts (after actionHandlers so voice toggle is available)
  const keyboardShortcuts = useATermKeyboardShortcuts({
    onNewATerm: modalHandlers.handleOpenATermManager,
    onCloseTab: navigationHandlers.handleCloseActive,
    onNextATerm: navigationHandlers.handleNextATerm,
    onPrevATerm: navigationHandlers.handlePrevATerm,
    onJumpToATerm: navigationHandlers.handleJumpToATerm,
    onVoiceToggle: showVoice
      ? handlePauseVoiceSend
      : actionHandlers.handleVoiceOpen,
  })

  return {
    // Core state
    ...aTermState,

    // Modal handlers
    ...modalHandlers,

    // Slot handlers
    ...slotHandlers,

    // Navigation handlers
    ...navigationHandlers,

    // Layout handlers
    handleLayoutChange,

    // Keyboard shortcuts
    showKeyboardHelp: keyboardShortcuts.showHelp,
    setShowKeyboardHelp: keyboardShortcuts.setShowHelp,

    // Action handlers
    ...actionHandlers,
    cleanPrompt,
    cleanerError,
    clearCleanerError,
    isCleaningPrompt,

    // Prompt cleaner state
    showCleaner,
    cleanerRawPrompt,

    // Voice input state
    showVoice,
    voiceFinalTranscript: transcription.finalTranscript,
    voiceInterimTranscript: transcription.interimTranscript,
    voiceStatus: transcription.status,
    voiceError: transcription.error,
    isVoiceSupported: transcription.isSupported,
    detachedPanes: availableDetachedPanes,
    isDetachedPaneWindow: detachedWindow.isDetachedPaneWindow,
    storageScopeId: detachedWindow.storageScopeId,
    handleSlotProjectSwitch: (
      slot: ATermSlot | PaneSlot,
      projectId: string,
      rootPath: string | null,
    ) =>
      isPaneSlot(slot)
        ? handleSlotProjectSwitch(slot, projectId, rootPath)
        : undefined,
  }
}
