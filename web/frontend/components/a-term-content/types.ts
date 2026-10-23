import type { RefObject } from 'react'
import type { ATermHandle, ConnectionStatus } from '@/components/a-term.types'
import type { ATermFontSize } from '@/lib/hooks/use-a-term-settings'
import type { ATermSlot, PaneSlot } from '@/lib/utils/slot'
import type { TranscriptionError, TranscriptionStatus } from '@/lib/voice/types'

export interface ATermContentProps {
  // A-Term state
  aTermSlots: (ATermSlot | PaneSlot)[]
  fontSize: ATermFontSize

  setFontSize: (size: ATermFontSize) => void
  isMobile?: boolean

  // Handlers
  setATermRef: (sessionId: string, handle: ATermHandle | null) => void
  handleStatusChange: (sessionId: string, status: ConnectionStatus) => void
  aTermStatuses: Map<string, ConnectionStatus>
  onSlotSwitch: (slot: ATermSlot | PaneSlot) => void
  onSlotReset: (slot: ATermSlot | PaneSlot) => void
  onSlotCloseSession: (slot: ATermSlot | PaneSlot) => void
  handleOpenATermManager?: () => void
  handleUploadClick: (sessionId?: string) => void
  onModeSwitch: (slot: ATermSlot | PaneSlot, mode: string) => void
  isModeSwitching: boolean

  // File upload
  fileInputRef: RefObject<HTMLInputElement | null>
  progress: number
  isUploading: boolean
  uploadError: { message: string } | null
  clearUploadError?: () => void
  handleFileInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  handleFileSelect: (file: File, targetSessionId?: string) => void

  // Mobile keyboard
  sessions: Array<{ id: string }>
  activeSessionId?: string | null
  activeMode?: string
  activeStatus?: ConnectionStatus
  handleKeyboardInput: (input: string) => void
  handleComposeInput: (
    sessionId: string,
    text: string,
    action: 'insert' | 'send',
  ) => Promise<boolean>

  // Voice input
  showVoice: boolean
  isVoiceSupported: boolean
  voiceFinalTranscript: string
  voiceInterimTranscript: string
  voiceStatus: TranscriptionStatus
  voiceError: TranscriptionError
  handleVoiceOpen: () => void
  handleVoiceSend: (text: string) => void
  handleVoiceCancel: () => void
  handleVoiceToggle: () => void

  // Class name
  className?: string
}
