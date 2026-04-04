import type { RefObject } from 'react'
import { clsx } from 'clsx'
import type { PaneSlot, TerminalSlot } from '@/lib/utils/slot'
import type { TerminalHandle, ConnectionStatus } from '@/components/terminal.types'
import type { LayoutMode } from '@/lib/constants/terminal'
import type { TerminalFontSize, TerminalScrollback } from '@/lib/hooks/use-terminal-settings'
import type { PaneLayout } from '@/types/pane-layout'
import { FileUploadDropzone } from '@/components/FileUploadDropzone'
import { TerminalLayoutRenderer } from '@/components/TerminalLayoutRenderer'
import { UploadErrorToast, UploadProgressToast } from '@/components/UploadStatusToast'

interface TerminalFileSectionProps {
  terminalSlots: (TerminalSlot | PaneSlot)[]
  fontFamily: string
  fontSize: TerminalFontSize
  scrollback: TerminalScrollback
  cursorStyle: 'block' | 'underline' | 'bar'
  cursorBlink: boolean
  theme?: Parameters<typeof TerminalLayoutRenderer>[0]['theme']
  setTerminalRef: (sessionId: string, handle: TerminalHandle | null) => void
  handleStatusChange: (sessionId: string, status: ConnectionStatus) => void
  terminalStatuses: Map<string, ConnectionStatus>
  onSlotSwitch: (slot: TerminalSlot | PaneSlot) => void
  onSlotReset: (slot: TerminalSlot | PaneSlot) => void
  onSlotClose: (slot: TerminalSlot | PaneSlot) => void
  onSlotCloseSession: (slot: TerminalSlot | PaneSlot) => void
  onSlotClean: (slot: TerminalSlot | PaneSlot) => void
  canAddPane: boolean
  handleOpenSettings: () => void
  handleOpenTerminalManager: () => void
  handleUploadClick: () => void
  onModeSwitch: (slot: TerminalSlot | PaneSlot, mode: string) => void
  isModeSwitching: boolean
  onSwapPanes: (slotIdA: string, slotIdB: string) => void
  layoutMode: LayoutMode
  availableLayouts: LayoutMode[]
  onLayoutModeChange: (mode: LayoutMode) => void
  onLayoutChange?: (layouts: PaneLayout[]) => void
  fileInputRef: RefObject<HTMLInputElement | null>
  progress: number
  isUploading: boolean
  uploadError: { message: string } | null
  clearUploadError?: () => void
  handleFileInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  handleFileSelect: (file: File) => void
  activeSessionId?: string | null
  isVoiceSupported: boolean
  handleVoiceOpen: () => void
  isMobile?: boolean
}

export function TerminalFileSection({
  terminalSlots,
  fontFamily,
  fontSize,
  scrollback,
  cursorStyle,
  cursorBlink,
  theme,
  setTerminalRef,
  handleStatusChange,
  terminalStatuses,
  onSlotSwitch,
  onSlotReset,
  onSlotClose,
  onSlotCloseSession,
  onSlotClean,
  canAddPane,
  handleOpenSettings,
  handleOpenTerminalManager,
  handleUploadClick,
  onModeSwitch,
  isModeSwitching,
  onSwapPanes,
  layoutMode,
  availableLayouts,
  onLayoutModeChange,
  onLayoutChange,
  fileInputRef,
  progress,
  isUploading,
  uploadError,
  clearUploadError,
  handleFileInputChange,
  handleFileSelect,
  activeSessionId,
  isVoiceSupported,
  handleVoiceOpen,
  isMobile,
}: TerminalFileSectionProps) {
  return (
    <>
      {/* Hidden file input for upload button */}
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={handleFileInputChange}
        accept="image/*,.md,.txt,.json,.pdf"
      />

      {/* Upload status indicators */}
      {isUploading && <UploadProgressToast progress={progress} />}
      {uploadError && <UploadErrorToast message={uploadError.message} onDismiss={clearUploadError} />}

      {/* Terminal panels with drag-drop upload */}
      <FileUploadDropzone
        onFileSelect={handleFileSelect}
        disabled={isUploading}
        className={clsx(
          'relative flex-1 min-h-0 min-w-0 overflow-hidden',
          isMobile ? 'order-1' : 'order-2',
        )}
      >
        <TerminalLayoutRenderer
          terminalSlots={terminalSlots}
          fontFamily={fontFamily}
          fontSize={fontSize}
          scrollback={scrollback}
          cursorStyle={cursorStyle}
          cursorBlink={cursorBlink}
          theme={theme}
          onTerminalRef={setTerminalRef}
          onStatusChange={handleStatusChange}
          terminalStatuses={terminalStatuses}
          onSlotSwitch={onSlotSwitch}
          onSlotReset={onSlotReset}
          onSlotClose={onSlotClose}
          onSlotCloseSession={onSlotCloseSession}
          onSlotClean={onSlotClean}
          canAddPane={canAddPane}
          onShowSettings={handleOpenSettings}
          onShowTerminalManager={handleOpenTerminalManager}
          onUploadClick={handleUploadClick}
          onModeSwitch={onModeSwitch}
          isModeSwitching={isModeSwitching}
          isMobile={isMobile ?? false}
          activeSessionId={activeSessionId}
          layoutMode={layoutMode}
          availableLayouts={availableLayouts}
          onLayoutModeChange={onLayoutModeChange}
          onSwapPanes={onSwapPanes}
          onLayoutChange={onLayoutChange}
          onVoice={isVoiceSupported ? handleVoiceOpen : undefined}
        />
      </FileUploadDropzone>
    </>
  )
}
