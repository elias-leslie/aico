import { useState } from 'react'
import { getAgentHubVoiceWsUrl } from '@/lib/api-config'
import { useTranscription } from '@/lib/voice/use-transcription'
import { useATermActionHandlers } from './use-a-term-action-handlers'
import { useATermModals } from './use-a-term-modals'
import { useATermSlotHandlers } from './use-a-term-slot-handlers'
import { useATermTabsState } from './use-a-term-tabs-state'
import { useSessionShortcuts } from './use-session-shortcuts'

interface UseATermOrchestrationProps {
  projectId?: string
  projectPath?: string
}

/**
 * Orchestrates all a-term state, handlers, and modals
 * This is the central hook that coordinates everything for ATermTabs
 */
export function useATermOrchestration({
  projectId,
  projectPath,
}: UseATermOrchestrationProps) {
  const aTermState = useATermTabsState({ projectId, projectPath })
  const {
    activeSessionId,
    switchToSession,
    sessions,
    aTermSlots,
    aTermRefs,
    reset,
    remove,
    handleProjectModeChange,
    setShowATermManager,
  } = aTermState

  // Phone voice input
  const [showVoice, setShowVoice] = useState(false)
  const transcription = useTranscription({
    whisperWsUrl: getAgentHubVoiceWsUrl(),
  })

  const modalHandlers = useATermModals({ setShowATermManager })

  const slotHandlers = useATermSlotHandlers({
    switchToSession,
    activeSessionId,
    reset,
    remove,
    sessions,
    slots: aTermSlots,
    handleProjectModeChange,
  })

  useSessionShortcuts(
    aTermSlots,
    activeSessionId,
    slotHandlers.handleSlotSwitch,
  )

  // File upload and voice input
  const actionHandlers = useATermActionHandlers({
    aTermRefs,
    activeSessionId,
    setShowVoice,
    voiceStartListening: transcription.startListening,
    voiceStopListening: transcription.stopListening,
    voiceResetTranscript: transcription.resetTranscript,
    voiceStatus: transcription.status,
  })

  return {
    ...aTermState,
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
