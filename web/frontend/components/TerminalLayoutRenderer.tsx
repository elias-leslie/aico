'use client'

import type { PaneSlot, TerminalSlot } from '@/lib/utils/slot'
import type { TerminalMode } from './ModeToggle'
import { type PaneLayout, ResizablePaneLayout } from './ResizablePaneLayout'
import type { TerminalComponent, TerminalHandle } from './Terminal'
import type { LayoutMode } from '@/lib/constants/terminal'
import type { ConnectionStatus } from './terminal.types'
import { getSlotPanelId } from '@/lib/utils/slot'

export function getLayoutRemountKey(
  layoutMode: LayoutMode,
  terminalSlots: (TerminalSlot | PaneSlot)[],
): string {
  const orderedSlotIds = terminalSlots
    .map((slot) => getSlotPanelId(slot))
    .join('|')

  return `${layoutMode}:${orderedSlotIds}`
}

interface TerminalLayoutRendererProps {
  // Slots (pane-based architecture)
  terminalSlots: (TerminalSlot | PaneSlot)[]

  // Terminal settings
  fontFamily: string
  fontSize: number
  scrollback: number
  cursorStyle: 'bar' | 'block' | 'underline'
  cursorBlink: boolean
  theme?: Parameters<typeof TerminalComponent>[0]['theme']

  // Terminal ref and status handlers
  onTerminalRef: (sessionId: string, handle: TerminalHandle | null) => void
  onStatusChange: (sessionId: string, status: ConnectionStatus) => void
  terminalStatuses: Map<string, ConnectionStatus>

  // Slot action handlers
  onSlotSwitch: (slot: TerminalSlot | PaneSlot) => void
  onSlotReset: (slot: TerminalSlot | PaneSlot) => void
  onSlotClose: (slot: TerminalSlot | PaneSlot) => void
  onSlotCloseSession: (slot: TerminalSlot | PaneSlot) => void
  onSlotClean: (slot: TerminalSlot | PaneSlot) => void

  // Pane limits
  canAddPane: boolean

  // UI callbacks
  onShowSettings: () => void
  onShowTerminalManager: () => void
  onUploadClick: (sessionId?: string) => void

  // Mode switch handler for project slots
  onModeSwitch?: (
    slot: TerminalSlot | PaneSlot,
    mode: TerminalMode,
  ) => void | Promise<void>
  isModeSwitching?: boolean

  // Device
  isMobile: boolean
  activeSessionId?: string | null

  // Pane swap (for dropdown swap)
  onSwapPanes?: (slotIdA: string, slotIdB: string) => void

  // Layout persistence
  layoutMode: LayoutMode
  availableLayouts: LayoutMode[]
  onLayoutModeChange: (mode: LayoutMode) => void
  onLayoutChange?: (layouts: PaneLayout[]) => void

  // Voice input
  onVoice?: (sessionId?: string) => void
}

export function TerminalLayoutRenderer({
  terminalSlots,
  fontFamily,
  fontSize,
  scrollback,
  cursorStyle,
  cursorBlink,
  theme,
  onTerminalRef,
  onStatusChange,
  terminalStatuses,
  onSlotSwitch,
  onSlotReset,
  onSlotClose,
  onSlotCloseSession,
  onSlotClean,
  canAddPane,
  onShowSettings,
  onShowTerminalManager,
  onUploadClick,
  onModeSwitch,
  isModeSwitching,
  isMobile,
  activeSessionId,
  onSwapPanes,
  layoutMode,
  availableLayouts,
  onLayoutModeChange,
  onLayoutChange,
  onVoice,
}: TerminalLayoutRendererProps) {
  const layoutKey = getLayoutRemountKey(layoutMode, terminalSlots)

  return (
    <ResizablePaneLayout
      key={layoutKey}
      slots={terminalSlots}
      fontFamily={fontFamily}
      fontSize={fontSize}
      scrollback={scrollback}
      cursorStyle={cursorStyle}
      cursorBlink={cursorBlink}
      theme={theme}
      onTerminalRef={onTerminalRef}
      onStatusChange={onStatusChange}
      terminalStatuses={terminalStatuses}
      onSwitch={onSlotSwitch}
      onSettings={onShowSettings}
      onReset={onSlotReset}
      onClose={onSlotClose}
      onCloseSession={onSlotCloseSession}
      onUpload={onUploadClick}
      onClean={onSlotClean}
      onOpenModal={onShowTerminalManager}
      canAddPane={canAddPane}
      onModeSwitch={onModeSwitch}
      isModeSwitching={isModeSwitching}
      isMobile={isMobile}
      activeSessionId={activeSessionId}
      layoutMode={layoutMode}
      availableLayouts={availableLayouts}
      onLayoutModeChange={onLayoutModeChange}
      onSwapPanes={onSwapPanes}
      onLayoutChange={onLayoutChange}
      onVoice={onVoice}
    />
  )
}
