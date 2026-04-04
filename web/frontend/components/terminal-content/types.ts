import type { RefObject } from 'react'
import type { PaneSlot, TerminalSlot } from '@/lib/utils/slot'
import type { TerminalHandle, ConnectionStatus } from '@/components/terminal.types'
import type {
  TerminalFontId,
  TerminalFontSize,
  TerminalScrollback,
  TerminalCursorStyle,
  TerminalThemeId,
} from '@/lib/hooks/use-terminal-settings'
import type { LayoutMode } from '@/lib/constants/terminal'
import type { KeyboardSizePreset } from '@/components/keyboard/types'
import type { PaneLayout } from '@/types/pane-layout'
import type {
  TranscriptionError,
  TranscriptionStatus,
} from '@/lib/voice/types'
import type { TerminalLayoutRenderer } from '@/components/TerminalLayoutRenderer'

export interface TerminalContentProps {
  // Terminal state
  terminalSlots: (TerminalSlot | PaneSlot)[]
  fontFamily: string
  fontSize: TerminalFontSize
  scrollback: TerminalScrollback
  cursorStyle: 'block' | 'underline' | 'bar'
  cursorBlink: boolean
  theme?: Parameters<typeof TerminalLayoutRenderer>[0]['theme']

  // Settings
  fontId: TerminalFontId
  themeId: TerminalThemeId
  showSettings: boolean
  setFontId: (id: TerminalFontId) => void
  setFontSize: (size: TerminalFontSize) => void
  setScrollback: (lines: TerminalScrollback) => void
  setCursorStyle: (style: TerminalCursorStyle) => void
  setCursorBlink: (blink: boolean) => void
  setThemeId: (id: TerminalThemeId) => void
  setShowSettings: (show: boolean) => void
  keyboardSize?: KeyboardSizePreset
  handleKeyboardSizeChange: (size: KeyboardSizePreset) => void
  isMobile?: boolean

  // Handlers
  setTerminalRef: (sessionId: string, handle: TerminalHandle | null) => void
  handleStatusChange: (sessionId: string, status: ConnectionStatus) => void
  terminalStatuses: Map<string, ConnectionStatus>
  onSlotSwitch: (slot: TerminalSlot | PaneSlot) => void
  onSlotReset: (slot: TerminalSlot | PaneSlot) => void
  onSlotClose: (slot: TerminalSlot | PaneSlot) => void
  onSlotCloseSession: (slot: TerminalSlot | PaneSlot) => void
  onSlotClean: (slot: TerminalSlot | PaneSlot) => void
  canAddPane: boolean
  handleOpenSettings: () => void
  handleOpenTerminalManager: () => void
  handleUploadClick: () => void
  onModeSwitch: (slot: TerminalSlot | PaneSlot, mode: string) => void
  isModeSwitching: boolean
  onSwapPanes: (slotIdA: string, slotIdB: string) => void
  onLayoutChange?: (layouts: PaneLayout[]) => void
  layoutMode: LayoutMode
  availableLayouts: LayoutMode[]
  onLayoutModeChange: (mode: LayoutMode) => void

  // File upload
  fileInputRef: RefObject<HTMLInputElement | null>
  progress: number
  isUploading: boolean
  uploadError: { message: string } | null
  clearUploadError?: () => void
  handleFileInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  handleFileSelect: (file: File) => void

  // Prompt cleaner
  showCleaner: boolean
  cleanerRawPrompt: string
  handleCleanerSend: (cleaned: string) => void
  handleCleanerCancel: () => void
  cleanPrompt: (prompt: string, refinement?: string) => Promise<string>
  cleanerError: string | null
  clearCleanerError: () => void
  isCleaningPrompt: boolean

  // Mobile keyboard
  sessions: Array<{ id: string }>
  activeSessionId?: string | null
  activeMode?: string
  activeStatus?: ConnectionStatus
  handleKeyboardInput: (input: string) => void
  handleReconnect: () => void

  // Voice input
  showVoice: boolean
  isVoiceSupported: boolean
  voiceFinalTranscript: string
  voiceInterimTranscript: string
  voiceStatus: TranscriptionStatus
  voiceError: TranscriptionError
  handleVoiceOpen: () => void
  handleVoiceSend: (text: string) => void
  handleVoiceInsert: (text: string) => void
  handleVoiceCancel: () => void
  handleVoiceToggle: () => void
  handleVoiceReset: () => void

  // Class name
  className?: string
}
