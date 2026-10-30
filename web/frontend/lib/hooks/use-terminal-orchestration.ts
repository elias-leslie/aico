import { useState } from 'react'
import { getAgentHubVoiceWsUrl } from '@/lib/api-config'
import { useTranscription } from '@/lib/voice/use-transcription'
import { useSessionShortcuts } from './use-session-shortcuts'
import { useTerminalActionHandlers } from './use-terminal-action-handlers'
import { useTerminalModals } from './use-terminal-modals'
import { useTerminalSlotHandlers } from './use-terminal-slot-handlers'
import { useTerminalTabsState } from './use-terminal-tabs-state'

interface UseTerminalOrchestrationProps {
  projectId?: string
  projectPath?: string
}

/**
 * Orchestrates all terminal state, handlers, and modals
 * This is the central hook that coordinates everything for TerminalTabs
 */
export function useTerminalOrchestration({
  projectId,
  projectPath,
}: UseTerminalOrchestrationProps) {
  const terminalState = useTerminalTabsState({ projectId, projectPath })
  const {
    activeSessionId,
    switchToSession,
    clearActiveSession,
    sessions,
    terminalSlots,
    terminalRefs,
    reset,
    remove,
    handleProjectModeChange,
    setShowTerminalManager,
  } = terminalState

  // Phone voice input
  const [showVoice, setShowVoice] = useState(false)
  const transcription = useTranscription({
    whisperWsUrl: getAgentHubVoiceWsUrl(),
  })

  const modalHandlers = useTerminalModals({ setShowTerminalManager })

  const slotHandlers = useTerminalSlotHandlers({
    switchToSession,
    clearActiveSession,
    activeSessionId,
    reset,
    remove,
    sessions,
    handleProjectModeChange,
  })

  useSessionShortcuts(
    terminalSlots,
    activeSessionId,
    slotHandlers.handleSlotSwitch,
  )

  // File upload and voice input
  const actionHandlers = useTerminalActionHandlers({
    terminalRefs,
    activeSessionId,
    setShowVoice,
    voiceStartListening: transcription.startListening,
    voiceStopListening: transcription.stopListening,
    voiceResetTranscript: transcription.resetTranscript,
    voiceStatus: transcription.status,
  })

  return {
    ...terminalState,
    ...modalHandlers,
    ...slotHandlers,
    ...actionHandlers,
    showVoice,
    voiceFinalTranscript: transcription.finalTranscript,
    voiceInterimTranscript: transcription.interimTranscript,
    voiceStatus: transcription.status,
    voiceError: transcription.error,
    isVoiceSupported: transcription.isSupported,
  }
}
