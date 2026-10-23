import type {
  ATermSearchOptions,
  ATermSearchResult,
  ConnectionStatus,
} from '@/components/a-term.types'
import type { ATermSlot, PaneSlot } from '@/lib/utils/slot'
import type { ATermMode } from '../ModeToggle'

export interface UnifiedATermHeaderProps {
  slot: ATermSlot | PaneSlot
  isActive?: boolean
  onSettings?: () => void
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
  /** Callback to reconnect the session */
  onReconnect?: () => void
  onSearch?: (query: string, options?: ATermSearchOptions) => ATermSearchResult
  onClearSearch?: () => void
}

export interface IconButtonProps {
  icon: React.ReactNode
  onClick: () => void
  tooltip: string
  variant?: 'default' | 'danger'
  isMobile?: boolean
}
