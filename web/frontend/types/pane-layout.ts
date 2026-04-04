import type { ConnectionStatus, TerminalHandle } from '@/components/Terminal'
import type { TerminalMode } from '@/components/ModeToggle'
import type { LayoutMode } from '@/lib/constants/terminal'
import type { PaneSlot, TerminalSlot } from '@/lib/utils/slot'
import type { TerminalComponent } from '@/components/Terminal'

// Preferred pane size targets in pixels. These are capped per group so splitters
// still have movement room on smaller viewport/pane combinations.
export const MIN_PANE_WIDTH_PX = 400
export const MIN_PANE_HEIGHT_PX = 300
export const MIN_RESIZE_HEADROOM_PERCENT = 5

// Fallback used before the container has been measured.
export const DEFAULT_MIN_SIZE_PERCENT = 20

export interface PaneLayout {
  slotId: string
  widthPercent: number
  heightPercent: number
  row: number
  col: number
}

export interface ResizablePaneLayoutProps {
  slots: (TerminalSlot | PaneSlot)[]
  fontFamily: string
  fontSize: number
  scrollback?: number
  cursorStyle?: 'block' | 'underline' | 'bar'
  cursorBlink?: boolean
  theme?: Parameters<typeof TerminalComponent>[0]['theme']
  onTerminalRef?: (sessionId: string, handle: TerminalHandle | null) => void
  onStatusChange?: (sessionId: string, status: ConnectionStatus) => void
  terminalStatuses?: Map<string, ConnectionStatus>
  onSwitch?: (slot: TerminalSlot | PaneSlot) => void
  onSettings?: () => void
  onReset?: (slot: TerminalSlot | PaneSlot) => void
  onClose?: (slot: TerminalSlot | PaneSlot) => void
  onCloseSession?: (slot: TerminalSlot | PaneSlot) => void
  onUpload?: (sessionId?: string) => void
  onClean?: (slot: TerminalSlot | PaneSlot) => void
  onOpenModal?: () => void
  canAddPane?: boolean
  onModeSwitch?: (
    slot: TerminalSlot | PaneSlot,
    mode: TerminalMode,
  ) => void | Promise<void>
  isModeSwitching?: boolean
  isMobile?: boolean
  activeSessionId?: string | null
  layoutMode?: LayoutMode
  availableLayouts?: LayoutMode[]
  onLayoutModeChange?: (mode: LayoutMode) => void
  onLayoutChange?: (layouts: PaneLayout[]) => void
  onSwapPanes?: (slotIdA: string, slotIdB: string) => void
  onVoice?: (sessionId?: string) => void
}
