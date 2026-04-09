import type { RefObject } from 'react'
import type { ATermLayoutRenderer } from '@/components/ATermLayoutRenderer'
import type { ATermHandle, ConnectionStatus } from '@/components/a-term.types'
import type { KeyboardSizePreset } from '@/components/keyboard/types'
import type { LayoutMode } from '@/lib/constants/a-term'
import type {
  ATermCursorStyle,
  ATermFontId,
  ATermFontSize,
  ATermScrollback,
  ATermThemeId,
} from '@/lib/hooks/use-a-term-settings'
import type { ATermSlot, PaneSlot } from '@/lib/utils/slot'
import type { TranscriptionError, TranscriptionStatus } from '@/lib/voice/types'
import type { PaneLayout } from '@/types/pane-layout'

export interface ATermContentProps {
  // A-Term state
  aTermSlots: (ATermSlot | PaneSlot)[]
  fontFamily: string
  fontSize: ATermFontSize
  scrollback: ATermScrollback
  cursorStyle: 'block' | 'underline' | 'bar'
  cursorBlink: boolean
  theme?: Parameters<typeof ATermLayoutRenderer>[0]['theme']

  // Settings
  fontId: ATermFontId
  themeId: ATermThemeId
  showSettings: boolean
  setFontId: (id: ATermFontId) => void
  setFontSize: (size: ATermFontSize) => void
  setScrollback: (lines: ATermScrollback) => void
  setCursorStyle: (style: ATermCursorStyle) => void
  setCursorBlink: (blink: boolean) => void
  setThemeId: (id: ATermThemeId) => void
  setShowSettings: (show: boolean) => void
  keyboardSize?: KeyboardSizePreset
  handleKeyboardSizeChange: (size: KeyboardSizePreset) => void
  isMobile?: boolean

  // Handlers
  setATermRef: (sessionId: string, handle: ATermHandle | null) => void
  handleStatusChange: (sessionId: string, status: ConnectionStatus) => void
  aTermStatuses: Map<string, ConnectionStatus>
  onSlotSwitch: (slot: ATermSlot | PaneSlot) => void
  onSlotReset: (slot: ATermSlot | PaneSlot) => void
  onSlotClose: (slot: ATermSlot | PaneSlot) => void
  onSlotCloseSession: (slot: ATermSlot | PaneSlot) => void
  onSlotClean: (slot: ATermSlot | PaneSlot) => void
  canAddPane: boolean
  handleOpenSettings: () => void
  handleOpenATermManager: () => void
  handleUploadClick: () => void
  onModeSwitch: (slot: ATermSlot | PaneSlot, mode: string) => void
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
