import type {
  ATermSearchOptions,
  ATermSearchResult,
  ConnectionStatus,
} from '@/components/a-term.types'
import type { ATermFontSize } from '@/lib/hooks/use-a-term-settings'
import type { ATermSlot, PaneSlot } from '@/lib/utils/slot'
import type { ATermMode } from '../ModeToggle'

export interface UnifiedATermHeaderProps {
  slot: ATermSlot | PaneSlot
  isActive?: boolean
  /** Text size, stepped in the session menu */
  fontSize?: ATermFontSize
  onFontSizeChange?: (size: ATermFontSize) => void
  onReset?: () => void
  onCloseSession?: () => void
  onRefresh?: () => void
  onFiles?: () => void
  onUpload?: () => void
  /** Opens the new-session picker */
  onOpenModal?: () => void
  /** Callback for mode switch (shell <-> agent) - only for project slots */
  onModeSwitch?: (mode: ATermMode) => void | Promise<void>
  /** Whether mode switch is in progress */
  isModeSwitching?: boolean
  isMobile?: boolean
  /** Every session, for the switcher */
  allSlots?: Array<ATermSlot | PaneSlot>
  /** Open another session */
  onSwitchTo?: (slot: ATermSlot | PaneSlot) => void
  connectionStatus?: ConnectionStatus
  /** Desktop with the session list beside it: search stays open */
  searchAlwaysOpen?: boolean
  onSearch?: (query: string, options?: ATermSearchOptions) => ATermSearchResult
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
