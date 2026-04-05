import { useCallback, useState } from 'react'
import { getAgentHubVoiceWsUrl } from '@/lib/api-config'
import { useTranscription } from '@/lib/voice/use-transcription'
import { useLayoutPersistence } from './use-layout-persistence'
import { usePromptCleaner } from './use-prompt-cleaner'
import { useATermActionHandlers } from './use-aterm-action-handlers'
import { useATermModals } from './use-aterm-modals'
import { useATermNavigation } from './use-aterm-navigation'
import { useATermSlotHandlers } from './use-aterm-slot-handlers'
import { useATermTabsState } from './use-aterm-tabs-state'
import { findSessionByMode } from './aterm-handler-utils'
import { useATermKeyboardShortcuts } from '@/components/KeyboardShortcuts'

interface UseATermOrchestrationProps {
  projectId?: string
  projectPath?: string
}

/**
 * Orchestrates all aterm state, handlers, and modals
 * This is the central hook that coordinates everything for ATermTabs
 */
export function useATermOrchestration({
  projectId,
  projectPath,
}: UseATermOrchestrationProps) {
  // Core aterm state
  const atermState = useATermTabsState({ projectId, projectPath })

  const {
    activeSessionId,
    switchToSession,
    sessions,
    atermSlots,
    orderedIds,
    atermRefs,
    reset,
    disableProject,
    remove,
    removePane,
    detachPane,
    handleProjectModeChange,
    attachExternalSession,
    attachDetachedPane,
    detachExternalSession,
    detachedPanes,
    showATermManager,
    setShowATermManager,
    saveLayouts,
  } = atermState

  // Prompt cleaner state
  const [showCleaner, setShowCleaner] = useState(false)
  const [cleanerRawPrompt, setCleanerRawPrompt] = useState('')
  const [keyboardHelpState, setKeyboardHelpState] = useState(false)

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
      const pane = await attachDetachedPane(paneId)
      return (
        findSessionByMode(pane, pane.active_mode)?.id ??
        findSessionByMode(pane, 'shell')?.id ??
        pane.sessions[0]?.id ??
        null
      )
    },
  })

  // Slot handlers
  const slotHandlers = useATermSlotHandlers({
    atermRefs,
    switchToSession,
    activeSessionId,
    reset,
    disableProject,
    remove,
    detachExternalSession,
    detachPane,
    removePane,
    setShowCleaner,
    setCleanerRawPrompt,
    sessions,
    visibleSlots: atermSlots,
    handleProjectModeChange,
  })

  // Layout persistence
  const { handleLayoutChange } = useLayoutPersistence({
    saveLayouts,
    debounceMs: 500,
  })

  // A-Term navigation
  const navigationHandlers = useATermNavigation({
    atermSlots,
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
    atermRefs,
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
    ...atermState,

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
    detachedPanes,
  }
}
