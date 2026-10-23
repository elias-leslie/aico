import { clsx } from 'clsx'
import { useCallback, useEffect, useRef } from 'react'
import { useLocalStorageState } from '@/lib/hooks/use-local-storage-state'
import { AgentShows } from './AgentShowToast'
import { ATermFileSection } from './a-term-content/ATermFileSection'
import { ATermMobileSection } from './a-term-content/ATermMobileSection'
import type { ATermContentProps } from './a-term-content/types'
import { NativeKeyboardInput } from './keyboard/NativeKeyboardInput'

export type { ATermContentProps }

/** Desktop browsers hide the compose box until it is opened, then remember
 * it on this device. Phones always show it. */
const COMPOSE_OPEN_KEY = 'a-term-compose-open'

/**
 * Renders the a-term content area with all modals and overlays
 * Extracted from ATermTabs to reduce component size
 */
export function ATermContent({
  aTermSlots,
  fontSize,
  setFontSize,
  isMobile,
  setATermRef,
  handleStatusChange,
  aTermStatuses,
  onSlotSwitch,
  onSlotReset,
  onSlotCloseSession,
  handleOpenATermManager,
  handleUploadClick,
  onModeSwitch,
  isModeSwitching,
  fileInputRef,
  progress,
  isUploading,
  uploadError,
  clearUploadError,
  handleFileInputChange,
  handleFileSelect,
  sessions,
  activeSessionId,
  activeMode,
  activeStatus,
  handleKeyboardInput,
  handleComposeInput,
  showVoice,
  isVoiceSupported,
  voiceFinalTranscript,
  voiceInterimTranscript,
  voiceStatus,
  voiceError,
  handleVoiceOpen,
  handleVoiceSend,
  handleVoiceCancel,
  handleVoiceToggle,
  className,
}: ATermContentProps) {
  const [composeOpen, setComposeOpen] = useLocalStorageState(
    COMPOSE_OPEN_KEY,
    false,
  )
  const composeInputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null)
  const focusComposeRef = useRef(false)
  const toggleCompose = useCallback(() => {
    focusComposeRef.current = !composeOpen
    setComposeOpen(!composeOpen)
  }, [composeOpen, setComposeOpen])
  useEffect(() => {
    if (composeOpen && focusComposeRef.current) {
      focusComposeRef.current = false
      composeInputRef.current?.focus()
    }
  }, [composeOpen])

  return (
    <div
      className={clsx(
        'flex h-full min-h-0 min-w-0 flex-col overflow-visible',
        className,
      )}
    >
      <AgentShows />
      {/* A-Term panels, file upload input, and upload status toasts */}
      <ATermFileSection
        aTermSlots={aTermSlots}
        fontSize={fontSize}
        setATermRef={setATermRef}
        handleStatusChange={handleStatusChange}
        aTermStatuses={aTermStatuses}
        onSlotSwitch={onSlotSwitch}
        onSlotReset={onSlotReset}
        onSlotCloseSession={onSlotCloseSession}
        setFontSize={setFontSize}
        handleOpenATermManager={handleOpenATermManager}
        handleUploadClick={handleUploadClick}
        onModeSwitch={onModeSwitch}
        isModeSwitching={isModeSwitching}
        fileInputRef={fileInputRef}
        progress={progress}
        isUploading={isUploading}
        uploadError={uploadError}
        clearUploadError={clearUploadError}
        handleFileInputChange={handleFileInputChange}
        handleFileSelect={handleFileSelect}
        activeSessionId={activeSessionId}
        isMobile={isMobile}
        composeOpen={composeOpen}
        onToggleCompose={isMobile ? undefined : toggleCompose}
      />

      {/* Mobile keyboard + voice panel */}
      <ATermMobileSection
        sessions={sessions}
        activeSessionId={activeSessionId}
        activeStatus={activeStatus}
        activeMode={activeMode}
        handleKeyboardInput={handleKeyboardInput}
        handleComposeInput={handleComposeInput}
        isVoiceSupported={isVoiceSupported}
        handleVoiceOpen={handleVoiceOpen}
        showVoice={showVoice}
        voiceFinalTranscript={voiceFinalTranscript}
        voiceInterimTranscript={voiceInterimTranscript}
        voiceStatus={voiceStatus}
        voiceError={voiceError}
        handleVoiceSend={handleVoiceSend}
        handleVoiceCancel={handleVoiceCancel}
        handleVoiceToggle={handleVoiceToggle}
        isMobile={isMobile}
      />

      {!isMobile && composeOpen && activeSessionId && sessions.length > 0 && (
        <NativeKeyboardInput
          key={activeSessionId}
          inputRef={composeInputRef}
          sessionId={activeSessionId}
          connected={activeStatus === 'connected'}
          onCommit={handleComposeInput}
        />
      )}
    </div>
  )
}
