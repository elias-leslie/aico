'use client'

import type { LayoutMode } from '@/lib/constants/a-term'
import type { ATermSlot, PaneSlot } from '@/lib/utils/slot'
import { getSlotPanelId } from '@/lib/utils/slot'
import type { ATermComponent, ATermHandle } from './ATerm'
import type { ConnectionStatus } from './a-term.types'
import type { ATermMode } from './ModeToggle'
import { type PaneLayout, ResizablePaneLayout } from './ResizablePaneLayout'

export function getLayoutRemountKey(
  layoutMode: LayoutMode,
  aTermSlots: (ATermSlot | PaneSlot)[],
): string {
  const orderedSlotIds = aTermSlots
    .map((slot) => getSlotPanelId(slot))
    .join('|')

  return `${layoutMode}:${orderedSlotIds}`
}

interface ATermLayoutRendererProps {
  // Slots (pane-based architecture)
  aTermSlots: (ATermSlot | PaneSlot)[]

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
  aTermStatuses: Map<string, ConnectionStatus>

  // Slot action handlers
  onSlotSwitch: (slot: ATermSlot | PaneSlot) => void
  onSlotReset: (slot: ATermSlot | PaneSlot) => void
  onSlotDetach: (slot: ATermSlot | PaneSlot) => void
  onSlotClose: (slot: ATermSlot | PaneSlot) => void
  onSlotCloseSession: (slot: ATermSlot | PaneSlot) => void
  onSlotRefresh?: (slot: ATermSlot | PaneSlot) => void
  onSlotClean: (slot: ATermSlot | PaneSlot) => void

  // Pane limits
  canAddPane: boolean

  // UI callbacks
  onShowSettings: () => void
  onShowATermManager?: () => void
  onUploadClick: (sessionId?: string) => void

  // Mode switch handler for project slots
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

  // Device
  isMobile: boolean
  activeSessionId?: string | null
  storageScopeId?: string | null

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
  aTermSlots,
  fontFamily,
  fontSize,
  scrollback,
  cursorStyle,
  cursorBlink,
  theme,
  onATermRef,
  onStatusChange,
  aTermStatuses,
  onSlotSwitch,
  onSlotReset,
  onSlotDetach,
  onSlotClose,
  onSlotCloseSession,
  onSlotRefresh,
  onSlotClean,
  canAddPane,
  onShowSettings,
  onShowATermManager,
  onUploadClick,
  onModeSwitch,
  onProjectSwitch,
  isModeSwitching,
  isMobile,
  activeSessionId,
  storageScopeId,
  onSwapPanes,
  layoutMode,
  availableLayouts,
  onLayoutModeChange,
  onLayoutChange,
  onVoice,
}: ATermLayoutRendererProps) {
  const layoutKey = getLayoutRemountKey(layoutMode, aTermSlots)

  return (
    <ResizablePaneLayout
      key={layoutKey}
      slots={aTermSlots}
      fontFamily={fontFamily}
      fontSize={fontSize}
      scrollback={scrollback}
      cursorStyle={cursorStyle}
      cursorBlink={cursorBlink}
      theme={theme}
      onATermRef={onATermRef}
      onStatusChange={onStatusChange}
      aTermStatuses={aTermStatuses}
      onSwitch={onSlotSwitch}
      onSettings={onShowSettings}
      onReset={onSlotReset}
      onDetach={onSlotDetach}
      onClose={onSlotClose}
      onCloseSession={onSlotCloseSession}
      onRefresh={onSlotRefresh}
      onUpload={onUploadClick}
      onClean={onSlotClean}
      onOpenModal={onShowATermManager}
      canAddPane={canAddPane}
      onModeSwitch={onModeSwitch}
      onProjectSwitch={onProjectSwitch}
      isModeSwitching={isModeSwitching}
      isMobile={isMobile}
      activeSessionId={activeSessionId}
      storageScopeId={storageScopeId}
      layoutMode={layoutMode}
      availableLayouts={availableLayouts}
      onLayoutModeChange={onLayoutModeChange}
      onSwapPanes={onSwapPanes}
      onLayoutChange={onLayoutChange}
      onVoice={onVoice}
    />
  )
}
