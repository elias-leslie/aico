'use client'

import type { PaneSlot, ATermSlot } from '@/lib/utils/slot'
import type { ATermMode } from './ModeToggle'
import { type PaneLayout, ResizablePaneLayout } from './ResizablePaneLayout'
import type { ATermComponent, ATermHandle } from './ATerm'
import type { LayoutMode } from '@/lib/constants/aterm'
import type { ConnectionStatus } from './aterm.types'
import { getSlotPanelId } from '@/lib/utils/slot'

export function getLayoutRemountKey(
  layoutMode: LayoutMode,
  atermSlots: (ATermSlot | PaneSlot)[],
): string {
  const orderedSlotIds = atermSlots
    .map((slot) => getSlotPanelId(slot))
    .join('|')

  return `${layoutMode}:${orderedSlotIds}`
}

interface ATermLayoutRendererProps {
  // Slots (pane-based architecture)
  atermSlots: (ATermSlot | PaneSlot)[]

  // A-Term settings
  fontFamily: string
  fontSize: number
  scrollback: number
  cursorStyle: 'bar' | 'block' | 'underline'
  cursorBlink: boolean
  theme?: Parameters<typeof ATermComponent>[0]['theme']

  // A-Term ref and status handlers
  onATermRef: (sessionId: string, handle: ATermHandle | null) => void
  onStatusChange: (sessionId: string, status: ConnectionStatus) => void
  atermStatuses: Map<string, ConnectionStatus>

  // Slot action handlers
  onSlotSwitch: (slot: ATermSlot | PaneSlot) => void
  onSlotReset: (slot: ATermSlot | PaneSlot) => void
  onSlotClose: (slot: ATermSlot | PaneSlot) => void
  onSlotCloseSession: (slot: ATermSlot | PaneSlot) => void
  onSlotClean: (slot: ATermSlot | PaneSlot) => void

  // Pane limits
  canAddPane: boolean

  // UI callbacks
  onShowSettings: () => void
  onShowATermManager: () => void
  onUploadClick: (sessionId?: string) => void

  // Mode switch handler for project slots
  onModeSwitch?: (
    slot: ATermSlot | PaneSlot,
    mode: ATermMode,
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

export function ATermLayoutRenderer({
  atermSlots,
  fontFamily,
  fontSize,
  scrollback,
  cursorStyle,
  cursorBlink,
  theme,
  onATermRef,
  onStatusChange,
  atermStatuses,
  onSlotSwitch,
  onSlotReset,
  onSlotClose,
  onSlotCloseSession,
  onSlotClean,
  canAddPane,
  onShowSettings,
  onShowATermManager,
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
}: ATermLayoutRendererProps) {
  const layoutKey = getLayoutRemountKey(layoutMode, atermSlots)

  return (
    <ResizablePaneLayout
      key={layoutKey}
      slots={atermSlots}
      fontFamily={fontFamily}
      fontSize={fontSize}
      scrollback={scrollback}
      cursorStyle={cursorStyle}
      cursorBlink={cursorBlink}
      theme={theme}
      onATermRef={onATermRef}
      onStatusChange={onStatusChange}
      atermStatuses={atermStatuses}
      onSwitch={onSlotSwitch}
      onSettings={onShowSettings}
      onReset={onSlotReset}
      onClose={onSlotClose}
      onCloseSession={onSlotCloseSession}
      onUpload={onUploadClick}
      onClean={onSlotClean}
      onOpenModal={onShowATermManager}
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
