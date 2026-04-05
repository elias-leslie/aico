import type { ConnectionStatus } from '@/components/aterm.types'
import type { KeyboardSizePreset } from '@/components/keyboard/types'
import type {
  TranscriptionError,
  TranscriptionStatus,
} from '@/lib/voice/types'
import { MobileKeyboard } from '@/components/keyboard/MobileKeyboard'
import { VoiceTranscriptPanel } from '@/components/VoiceTranscriptPanel'

interface ATermMobileSectionProps {
  sessions: Array<{ id: string }>
  activeStatus?: ConnectionStatus
  activeMode?: string
  handleKeyboardInput: (input: string) => void
  handleReconnect: () => void
  keyboardSize?: KeyboardSizePreset
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
  activeStatus,
  activeMode,
  handleKeyboardInput,
  handleReconnect,
  keyboardSize,
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
    <div className="order-3">
      <MobileKeyboard
        onSend={handleKeyboardInput}
        connectionStatus={activeStatus}
        onReconnect={handleReconnect}
        keyboardSize={keyboardSize}
        onVoice={isVoiceSupported ? handleVoiceOpen : undefined}
        voiceActive={showVoice}
        activeMode={activeMode}
      />
      {/* Mobile voice panel renders below ControlBar, replacing FullKeyboard */}
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
