import type { ConnectionStatus, ATermHandle } from '@/components/ATerm'
import type { ATermMode } from '@/components/ModeToggle'
import type { LayoutMode } from '@/lib/constants/a-term'
import type { PaneSlot, ATermSlot } from '@/lib/utils/slot'
import type { ATermComponent } from '@/components/ATerm'

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
  slots: (ATermSlot | PaneSlot)[]
  fontFamily: string
  fontSize: number
  scrollback?: number
  cursorStyle?: 'block' | 'underline' | 'bar'
  cursorBlink?: boolean
  theme?: Parameters<typeof ATermComponent>[0]['theme']
  onATermRef?: (sessionId: string, handle: ATermHandle | null) => void
  onStatusChange?: (sessionId: string, status: ConnectionStatus) => void
  aTermStatuses?: Map<string, ConnectionStatus>
  onSwitch?: (slot: ATermSlot | PaneSlot) => void
  onSettings?: () => void
  onReset?: (slot: ATermSlot | PaneSlot) => void
  onDetach?: (slot: ATermSlot | PaneSlot) => void
  onClose?: (slot: ATermSlot | PaneSlot) => void
  onCloseSession?: (slot: ATermSlot | PaneSlot) => void
  onUpload?: (sessionId?: string) => void
  onClean?: (slot: ATermSlot | PaneSlot) => void
  onOpenModal?: () => void
  canAddPane?: boolean
  onModeSwitch?: (
    slot: ATermSlot | PaneSlot,
    mode: ATermMode,
  ) => void | Promise<void>
  onProjectSwitch?: (
    slot: ATermSlot | PaneSlot,
    projectId: string,
    rootPath: string | null,
  ) => void | Promise<void>
  isModeSwitching?: boolean
  isMobile?: boolean
  activeSessionId?: string | null
  storageScopeId?: string | null
  layoutMode?: LayoutMode
  availableLayouts?: LayoutMode[]
  onLayoutModeChange?: (mode: LayoutMode) => void
  onLayoutChange?: (layouts: PaneLayout[]) => void
  onSwapPanes?: (slotIdA: string, slotIdB: string) => void
  onVoice?: (sessionId?: string) => void
}
