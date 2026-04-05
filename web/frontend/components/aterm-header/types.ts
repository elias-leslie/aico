import type { PaneSlot, ATermSlot } from '@/lib/utils/slot'
import type { ATermMode } from '../ModeToggle'
import type { LayoutMode } from '@/lib/constants/aterm'
import type {
  ConnectionStatus,
  ATermSearchOptions,
  ATermSearchResult,
} from '@/components/aterm.types'

export interface UnifiedATermHeaderProps {
  slot: ATermSlot | PaneSlot
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
  /** Opens aterm manager modal - appears in ALL pane headers */
  onOpenModal?: () => void
  /** Whether new panes can be added (at limit = false) */
  canAddPane?: boolean
  /** Callback for mode switch (shell <-> agent) - only for project slots */
  onModeSwitch?: (mode: ATermMode) => void | Promise<void>
  /** Whether mode switch is in progress */
  isModeSwitching?: boolean
  isMobile?: boolean
  /** All slots for swap dropdown (split/grid mode) - shows dropdown when provided */
  allSlots?: Array<ATermSlot | PaneSlot>
  /** Callback when user selects another slot to swap positions with */
  onSwapWith?: (otherSlotId: string) => void
  /** Callback to switch to another slot (mobile: navigate instead of swap) */
  onSwitchTo?: (slot: ATermSlot | PaneSlot) => void
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
    options?: ATermSearchOptions,
  ) => ATermSearchResult
  onClearSearch?: () => void
}

export interface IconButtonProps {
  icon: React.ReactNode
  onClick: () => void
  tooltip: string
  variant?: 'default' | 'danger'
  isMobile?: boolean
}
