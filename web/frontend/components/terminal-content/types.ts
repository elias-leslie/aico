import type { RefObject } from 'react'
import type {
  ConnectionStatus,
  TerminalHandle,
} from '@/components/terminal.types'
import type { UploadDone } from '@/lib/hooks/use-terminal-action-handlers'
import type { TerminalFontSize } from '@/lib/hooks/use-terminal-settings'
import type { PaneSlot, TerminalSlot } from '@/lib/utils/slot'
import type { TranscriptionError, TranscriptionStatus } from '@/lib/voice/types'

export interface TerminalContentProps {
  // Terminal state
  terminalSlots: (TerminalSlot | PaneSlot)[]
  fontSize: TerminalFontSize

  setFontSize: (size: TerminalFontSize) => void
  isMobile?: boolean

  // Handlers
  setTerminalRef: (sessionId: string, handle: TerminalHandle | null) => void
  handleStatusChange: (sessionId: string, status: ConnectionStatus) => void
  terminalStatuses: Map<string, ConnectionStatus>
  onSlotSwitch: (slot: TerminalSlot | PaneSlot) => void
  onSlotReset: (slot: TerminalSlot | PaneSlot) => void
  onSlotCloseSession: (slot: TerminalSlot | PaneSlot) => void
  handleOpenTerminalManager?: () => void
  handleUploadClick: (sessionId?: string) => void
  onModeSwitch: (slot: TerminalSlot | PaneSlot, mode: string) => void
  isModeSwitching: boolean

  // File upload
  fileInputRef: RefObject<HTMLInputElement | null>
  progress: number
  isUploading: boolean
  uploadError: { message: string } | null
  clearUploadError?: () => void
  uploadDone?: UploadDone | null
  clearUploadDone?: () => void
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
