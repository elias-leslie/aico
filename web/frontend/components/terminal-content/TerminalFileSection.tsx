import { clsx } from 'clsx'
import type { RefObject } from 'react'
import { FileUploadDropzone } from '@/components/FileUploadDropzone'
import { SessionView } from '@/components/SessionView'
import type {
  ConnectionStatus,
  TerminalHandle,
} from '@/components/terminal.types'
import {
  UploadErrorToast,
  UploadProgressToast,
} from '@/components/UploadStatusToast'
import type { TerminalFontSize } from '@/lib/hooks/use-terminal-settings'
import type { PaneSlot, TerminalSlot } from '@/lib/utils/slot'

interface TerminalFileSectionProps {
  terminalSlots: (TerminalSlot | PaneSlot)[]
  fontSize: TerminalFontSize
  setTerminalRef: (sessionId: string, handle: TerminalHandle | null) => void
  handleStatusChange: (sessionId: string, status: ConnectionStatus) => void
  terminalStatuses: Map<string, ConnectionStatus>
  onSlotSwitch: (slot: TerminalSlot | PaneSlot) => void
  onSlotReset: (slot: TerminalSlot | PaneSlot) => void
  onSlotCloseSession: (slot: TerminalSlot | PaneSlot) => void
  setFontSize: (size: TerminalFontSize) => void
  handleOpenTerminalManager?: () => void
  handleUploadClick: (sessionId?: string) => void
  onModeSwitch: (slot: TerminalSlot | PaneSlot, mode: string) => void
  isModeSwitching: boolean
  composeOpen?: boolean
  onToggleCompose?: () => void
  /** The session list sits beside the session (desktop) */
  sideList?: boolean
  fileInputRef: RefObject<HTMLInputElement | null>
  progress: number
  isUploading: boolean
  uploadError: { message: string } | null
  clearUploadError?: () => void
  handleFileInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  handleFileSelect: (file: File, targetSessionId?: string) => void
  activeSessionId?: string | null
  isMobile?: boolean
}

export function TerminalFileSection({
  terminalSlots,
  fontSize,
  setTerminalRef,
  handleStatusChange,
  terminalStatuses,
  onSlotSwitch,
  onSlotReset,
  onSlotCloseSession,
  setFontSize,
  handleOpenTerminalManager,
  handleUploadClick,
  onModeSwitch,
  isModeSwitching,
  composeOpen,
  onToggleCompose,
  sideList,
  fileInputRef,
  progress,
  isUploading,
  uploadError,
  clearUploadError,
  handleFileInputChange,
  handleFileSelect,
  activeSessionId,
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
      {uploadError && (
        <UploadErrorToast
          message={uploadError.message}
          onDismiss={clearUploadError}
        />
      )}

      {/* The session, with drag-drop upload */}
      <FileUploadDropzone
        onFileSelect={handleFileSelect}
        disabled={isUploading}
        className={clsx(
          'relative flex-1 min-h-0 min-w-0 overflow-hidden',
          isMobile ? 'order-1' : 'order-2',
        )}
      >
        <SessionView
          slots={terminalSlots}
          activeSessionId={activeSessionId}
          fontSize={fontSize}
          isMobile={isMobile ?? false}
          onTerminalRef={setTerminalRef}
          onStatusChange={handleStatusChange}
          terminalStatuses={terminalStatuses}
          onSwitch={onSlotSwitch}
          onFontSizeChange={setFontSize}
          onReset={onSlotReset}
          onCloseSession={onSlotCloseSession}
          onUpload={handleUploadClick}
          onFilePaste={handleFileSelect}
          onNewSession={handleOpenTerminalManager}
          onModeSwitch={onModeSwitch}
          isModeSwitching={isModeSwitching}
          composeOpen={composeOpen}
          onToggleCompose={onToggleCompose}
          sideList={sideList}
        />
      </FileUploadDropzone>
    </>
  )
}
