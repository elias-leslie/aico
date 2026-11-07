import type {
  ConnectionStatus,
  TerminalSearchOptions,
  TerminalSearchResult,
} from '@/components/terminal.types'
import type { TerminalFontSize } from '@/lib/hooks/use-terminal-settings'
import type { PaneSlot, TerminalSlot } from '@/lib/utils/slot'
import type { TerminalMode } from '../ModeToggle'

export interface UnifiedTerminalHeaderProps {
  slot: TerminalSlot | PaneSlot
  isActive?: boolean
  /** Text size, stepped in the session menu */
  fontSize?: TerminalFontSize
  onFontSizeChange?: (size: TerminalFontSize) => void
  onReset?: () => void
  onCloseSession?: () => void
  onRefresh?: () => void
  onFiles?: () => void
  onUpload?: () => void
  /** Callback for mode switch (shell <-> agent) - only for project slots */
  onModeSwitch?: (mode: TerminalMode) => void | Promise<void>
  /** Whether mode switch is in progress */
  isModeSwitching?: boolean
  isMobile?: boolean
  connectionStatus?: ConnectionStatus
  /** Desktop with the session list beside it: search stays open */
  searchAlwaysOpen?: boolean
  onSearch?: (
    query: string,
    options?: TerminalSearchOptions,
  ) => TerminalSearchResult
  onClearSearch?: () => void
  /** Desktop: whether the compose box is shown */
  composeOpen?: boolean
  /** Desktop: show or hide the compose box */
  onToggleCompose?: () => void
}

export interface IconButtonProps {
  icon: React.ReactNode
  onClick: () => void
  tooltip: string
  isMobile?: boolean
}
