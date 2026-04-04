import type { PaneSlot, TerminalSlot } from '@/lib/utils/slot'
import type { TerminalMode } from '../ModeToggle'
import type { LayoutMode } from '@/lib/constants/terminal'
import type {
  ConnectionStatus,
  TerminalSearchOptions,
  TerminalSearchResult,
} from '@/components/terminal.types'

export interface UnifiedTerminalHeaderProps {
  slot: TerminalSlot | PaneSlot
  isActive?: boolean
  showCleanButton?: boolean
  onSwitch?: () => void
  onSettings?: () => void
  onReset?: () => void
  onClose?: () => void
  onCloseSession?: () => void
  closeTooltip?: string
  onUpload?: () => void
  onVoice?: () => void
  onClean?: () => void
  /** Opens terminal manager modal - appears in ALL pane headers */
  onOpenModal?: () => void
  /** Whether new panes can be added (at limit = false) */
  canAddPane?: boolean
  /** Callback for mode switch (shell <-> agent) - only for project slots */
  onModeSwitch?: (mode: TerminalMode) => void | Promise<void>
  /** Whether mode switch is in progress */
  isModeSwitching?: boolean
  isMobile?: boolean
  /** All slots for swap dropdown (split/grid mode) - shows dropdown when provided */
  allSlots?: Array<TerminalSlot | PaneSlot>
  /** Callback when user selects another slot to swap positions with */
  onSwapWith?: (otherSlotId: string) => void
  /** Callback to switch to another slot (mobile: navigate instead of swap) */
  onSwitchTo?: (slot: TerminalSlot | PaneSlot) => void
  /** Callback to reset all panes (overflow menu) */
  onResetAll?: () => void
  /** Callback to close all panes (overflow menu) */
  onCloseAll?: () => void
  layoutMode?: LayoutMode
  availableLayouts?: LayoutMode[]
  onLayoutModeChange?: (mode: LayoutMode) => void
  connectionStatus?: ConnectionStatus
  /** Callback to reconnect the pane's session */
  onReconnect?: () => void
  onSearch?: (
    query: string,
    options?: TerminalSearchOptions,
  ) => TerminalSearchResult
  onClearSearch?: () => void
}

export interface IconButtonProps {
  icon: React.ReactNode
  onClick: () => void
  tooltip: string
  variant?: 'default' | 'danger'
  isMobile?: boolean
}
