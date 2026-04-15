import { clsx } from 'clsx'
import type { RefObject } from 'react'
import { ATermLayoutRenderer } from '@/components/ATermLayoutRenderer'
import type { ATermHandle, ConnectionStatus } from '@/components/a-term.types'
import { FileUploadDropzone } from '@/components/FileUploadDropzone'
import {
  UploadErrorToast,
  UploadProgressToast,
} from '@/components/UploadStatusToast'
import type { LayoutMode } from '@/lib/constants/a-term'
import type {
  ATermFontSize,
  ATermScrollback,
} from '@/lib/hooks/use-a-term-settings'
import type { ATermSlot, PaneSlot } from '@/lib/utils/slot'
import type { PaneLayout } from '@/types/pane-layout'

interface ATermFileSectionProps {
  aTermSlots: (ATermSlot | PaneSlot)[]
  fontFamily: string
  fontSize: ATermFontSize
  scrollback: ATermScrollback
  cursorStyle: 'block' | 'underline' | 'bar'
  cursorBlink: boolean
  theme?: Parameters<typeof ATermLayoutRenderer>[0]['theme']
  setATermRef: (sessionId: string, handle: ATermHandle | null) => void
  handleStatusChange: (sessionId: string, status: ConnectionStatus) => void
  aTermStatuses: Map<string, ConnectionStatus>
  onSlotSwitch: (slot: ATermSlot | PaneSlot) => void
  onSlotReset: (slot: ATermSlot | PaneSlot) => void
  onSlotDetach: (slot: ATermSlot | PaneSlot) => void
  onSlotClose: (slot: ATermSlot | PaneSlot) => void
  onSlotCloseSession: (slot: ATermSlot | PaneSlot) => void
  onSlotClean: (slot: ATermSlot | PaneSlot) => void
  canAddPane: boolean
  handleOpenSettings: () => void
  handleOpenATermManager?: () => void
  handleUploadClick: () => void
  onModeSwitch: (slot: ATermSlot | PaneSlot, mode: string) => void
  onProjectSwitch?: (
    slot: ATermSlot | PaneSlot,
    projectId: string,
    rootPath: string | null,
  ) => Promise<void> | void
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
  storageScopeId?: string | null
  isVoiceSupported: boolean
  handleVoiceOpen: () => void
  isMobile?: boolean
}

export function ATermFileSection({
  aTermSlots,
  fontFamily,
  fontSize,
  scrollback,
  cursorStyle,
  cursorBlink,
  theme,
  setATermRef,
  handleStatusChange,
  aTermStatuses,
  onSlotSwitch,
  onSlotReset,
  onSlotDetach,
  onSlotClose,
  onSlotCloseSession,
  onSlotClean,
  canAddPane,
  handleOpenSettings,
  handleOpenATermManager,
  handleUploadClick,
  onModeSwitch,
  onProjectSwitch,
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
  storageScopeId,
  isVoiceSupported,
  handleVoiceOpen,
  isMobile,
}: ATermFileSectionProps) {
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
      {uploadError && (
        <UploadErrorToast
          message={uploadError.message}
          onDismiss={clearUploadError}
        />
      )}

      {/* A-Term panels with drag-drop upload */}
      <FileUploadDropzone
        onFileSelect={handleFileSelect}
        disabled={isUploading}
        className={clsx(
          'relative flex-1 min-h-0 min-w-0 overflow-hidden',
          isMobile ? 'order-1' : 'order-2',
        )}
      >
        <ATermLayoutRenderer
          aTermSlots={aTermSlots}
          fontFamily={fontFamily}
          fontSize={fontSize}
          scrollback={scrollback}
          cursorStyle={cursorStyle}
          cursorBlink={cursorBlink}
          theme={theme}
          onATermRef={setATermRef}
          onStatusChange={handleStatusChange}
          aTermStatuses={aTermStatuses}
          onSlotSwitch={onSlotSwitch}
          onSlotReset={onSlotReset}
          onSlotDetach={onSlotDetach}
          onSlotClose={onSlotClose}
          onSlotCloseSession={onSlotCloseSession}
          onSlotClean={onSlotClean}
          canAddPane={canAddPane}
          onShowSettings={handleOpenSettings}
          onShowATermManager={handleOpenATermManager}
          onUploadClick={handleUploadClick}
          onModeSwitch={onModeSwitch}
          onProjectSwitch={onProjectSwitch}
          isModeSwitching={isModeSwitching}
          isMobile={isMobile ?? false}
          activeSessionId={activeSessionId}
          storageScopeId={storageScopeId}
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
