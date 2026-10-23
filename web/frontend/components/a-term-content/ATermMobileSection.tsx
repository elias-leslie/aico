import type { ConnectionStatus } from '@/components/a-term.types'
import { MobileKeyboard } from '@/components/keyboard/MobileKeyboard'
import { VoiceTranscriptPanel } from '@/components/VoiceTranscriptPanel'
import type { TranscriptionError, TranscriptionStatus } from '@/lib/voice/types'

interface ATermMobileSectionProps {
  sessions: Array<{ id: string }>
  activeSessionId?: string | null
  activeStatus?: ConnectionStatus
  activeMode?: string
  handleKeyboardInput: (input: string) => void
  handleComposeInput: (
    sessionId: string,
    text: string,
    action: 'insert' | 'send',
  ) => Promise<boolean>
  handleReconnect: () => void
  isVoiceSupported: boolean
  handleVoiceOpen: () => void
  showVoice: boolean
  voiceFinalTranscript: string
  voiceInterimTranscript: string
  voiceStatus: TranscriptionStatus
  voiceError: TranscriptionError
  handleVoiceSend: (text: string) => void
  handleVoiceInsert: (text: string) => void
  handleVoiceCancel: () => void
  handleVoiceToggle: () => void
  handleVoiceReset: () => void
  isMobile?: boolean
}

export function ATermMobileSection({
  sessions,
  activeSessionId,
  activeStatus,
  activeMode,
  handleKeyboardInput,
  handleComposeInput,
  handleReconnect,
  isVoiceSupported,
  handleVoiceOpen,
  showVoice,
  voiceFinalTranscript,
  voiceInterimTranscript,
  voiceStatus,
  voiceError,
  handleVoiceSend,
  handleVoiceInsert,
  handleVoiceCancel,
  handleVoiceToggle,
  handleVoiceReset,
  isMobile,
}: ATermMobileSectionProps) {
  if (!isMobile || sessions.length === 0) return null

  return (
    <div className="order-3 shrink-0">
      <MobileKeyboard
        onSend={handleKeyboardInput}
        sessionId={activeSessionId}
        onCompose={handleComposeInput}
        connectionStatus={activeStatus}
        onReconnect={handleReconnect}
        onVoice={isVoiceSupported ? handleVoiceOpen : undefined}
        voiceActive={showVoice}
        activeMode={activeMode}
      />
      {/* Voice panel renders below the key row */}
      {showVoice && (
        <VoiceTranscriptPanel
          transcript={voiceFinalTranscript}
          interimTranscript={voiceInterimTranscript}
          status={voiceStatus}
          error={voiceError}
          onSend={handleVoiceSend}
          onInsert={handleVoiceInsert}
          onCancel={handleVoiceCancel}
          onToggleListening={handleVoiceToggle}
          onReset={handleVoiceReset}
          isMobile={isMobile}
        />
      )}
    </div>
  )
}
