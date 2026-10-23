import { clsx } from 'clsx'
import type { RefObject } from 'react'
import type { ATermHandle, ConnectionStatus } from '@/components/a-term.types'
import { FileUploadDropzone } from '@/components/FileUploadDropzone'
import { SessionView } from '@/components/SessionView'
import {
  UploadErrorToast,
  UploadProgressToast,
} from '@/components/UploadStatusToast'
import type { ATermFontSize } from '@/lib/hooks/use-a-term-settings'
import type { ATermSlot, PaneSlot } from '@/lib/utils/slot'

interface ATermFileSectionProps {
  aTermSlots: (ATermSlot | PaneSlot)[]
  fontSize: ATermFontSize
  setATermRef: (sessionId: string, handle: ATermHandle | null) => void
  handleStatusChange: (sessionId: string, status: ConnectionStatus) => void
  aTermStatuses: Map<string, ConnectionStatus>
  onSlotSwitch: (slot: ATermSlot | PaneSlot) => void
  onSlotReset: (slot: ATermSlot | PaneSlot) => void
  onSlotCloseSession: (slot: ATermSlot | PaneSlot) => void
  handleOpenSettings: () => void
  handleOpenATermManager?: () => void
  handleUploadClick: (sessionId?: string) => void
  onModeSwitch: (slot: ATermSlot | PaneSlot, mode: string) => void
  isModeSwitching: boolean
  composeOpen?: boolean
  onToggleCompose?: () => void
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

export function ATermFileSection({
  aTermSlots,
  fontSize,
  setATermRef,
  handleStatusChange,
  aTermStatuses,
  onSlotSwitch,
  onSlotReset,
  onSlotCloseSession,
  handleOpenSettings,
  handleOpenATermManager,
  handleUploadClick,
  onModeSwitch,
  isModeSwitching,
  composeOpen,
  onToggleCompose,
  fileInputRef,
  progress,
  isUploading,
  uploadError,
  clearUploadError,
  handleFileInputChange,
  handleFileSelect,
  activeSessionId,
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
          slots={aTermSlots}
          activeSessionId={activeSessionId}
          fontSize={fontSize}
          isMobile={isMobile ?? false}
          onATermRef={setATermRef}
          onStatusChange={handleStatusChange}
          aTermStatuses={aTermStatuses}
          onSwitch={onSlotSwitch}
          onSettings={handleOpenSettings}
          onReset={onSlotReset}
          onCloseSession={onSlotCloseSession}
          onUpload={handleUploadClick}
          onFilePaste={handleFileSelect}
          onNewSession={handleOpenATermManager}
          onModeSwitch={onModeSwitch}
          isModeSwitching={isModeSwitching}
          composeOpen={composeOpen}
          onToggleCompose={onToggleCompose}
        />
      </FileUploadDropzone>
    </>
  )
}
