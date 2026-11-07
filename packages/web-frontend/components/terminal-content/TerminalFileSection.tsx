import { clsx } from 'clsx'
import { FileUploadDropzone } from '@/components/FileUploadDropzone'
import { getShownSlot, SessionView } from '@/components/SessionView'
import {
  UploadDoneToast,
  UploadErrorToast,
  UploadProgressToast,
} from '@/components/UploadStatusToast'
import type { TerminalContentProps } from './types'

/** The slice of the content's props the session slots and upload surface use, plus the compose and layout switches. */
type TerminalFileSectionProps = Pick<
  TerminalContentProps,
  | 'terminalSlots'
  | 'fontSize'
  | 'setTerminalRef'
  | 'handleStatusChange'
  | 'terminalStatuses'
  | 'onSlotSwitch'
  | 'onSlotReset'
  | 'onSlotCloseSession'
  | 'setFontSize'
  | 'handleOpenTerminalManager'
  | 'handleUploadClick'
  | 'onModeSwitch'
  | 'isModeSwitching'
  | 'fileInputRef'
  | 'progress'
  | 'isUploading'
  | 'uploadError'
  | 'clearUploadError'
  | 'uploadDone'
  | 'clearUploadDone'
  | 'handleFileInputChange'
  | 'handleFileSelect'
  | 'activeSessionId'
  | 'isMobile'
> & {
  composeOpen?: boolean
  onToggleCompose?: () => void
  onChatBack?: () => void
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
  onChatBack,
  fileInputRef,
  progress,
  isUploading,
  uploadError,
  clearUploadError,
  uploadDone,
  clearUploadDone,
  handleFileInputChange,
  handleFileSelect,
  activeSessionId,
  isMobile,
}: TerminalFileSectionProps) {
  // A chat takes typed messages, not dropped files.
  const chatShown = getShownSlot(terminalSlots, activeSessionId)?.chat === true
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
      {uploadDone && !isUploading && !uploadError && clearUploadDone && (
        <UploadDoneToast upload={uploadDone} onDismiss={clearUploadDone} />
      )}

      {/* The session, with drag-drop upload */}
      <FileUploadDropzone
        onFileSelect={handleFileSelect}
        disabled={isUploading || chatShown}
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
          onChatBack={onChatBack}
        />
      </FileUploadDropzone>
    </>
  )
}
