import { clsx } from 'clsx'
import { AgentShows } from './AgentShowToast'
import { ATermFileSection } from './a-term-content/ATermFileSection'
import { ATermMobileSection } from './a-term-content/ATermMobileSection'
import type { ATermContentProps } from './a-term-content/types'
import { NativeKeyboardInput } from './keyboard/NativeKeyboardInput'
import { SettingsDropdown } from './SettingsDropdown'

export type { ATermContentProps }

/**
 * Renders the a-term content area with all modals and overlays
 * Extracted from ATermTabs to reduce component size
 */
export function ATermContent({
  aTermSlots,
  fontSize,
  showSettings,
  setFontSize,
  setShowSettings,
  isMobile,
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
  handleReconnect,
  showVoice,
  isVoiceSupported,
  voiceFinalTranscript,
  voiceInterimTranscript,
  voiceStatus,
  voiceError,
  handleVoiceOpen,
  handleVoiceSend,
  handleVoiceInsert,
  handleVoiceCancel,
  handleVoiceToggle,
  handleVoiceReset,
  className,
}: ATermContentProps) {
  return (
    <div
      className={clsx(
        'flex h-full min-h-0 min-w-0 flex-col overflow-visible',
        className,
      )}
    >
      <AgentShows />
      {/* Settings dropdown - all settings controls */}
      <SettingsDropdown
        fontSize={fontSize}
        setFontSize={setFontSize}
        showSettings={showSettings}
        setShowSettings={setShowSettings}
        renderTrigger={false}
      />

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
        handleOpenSettings={handleOpenSettings}
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
      />

      {/* Mobile keyboard + voice panel */}
      <ATermMobileSection
        sessions={sessions}
        activeSessionId={activeSessionId}
        activeStatus={activeStatus}
        activeMode={activeMode}
        handleKeyboardInput={handleKeyboardInput}
        handleComposeInput={handleComposeInput}
        handleReconnect={handleReconnect}
        isVoiceSupported={isVoiceSupported}
        handleVoiceOpen={handleVoiceOpen}
        showVoice={showVoice}
        voiceFinalTranscript={voiceFinalTranscript}
        voiceInterimTranscript={voiceInterimTranscript}
        voiceStatus={voiceStatus}
        voiceError={voiceError}
        handleVoiceSend={handleVoiceSend}
        handleVoiceInsert={handleVoiceInsert}
        handleVoiceCancel={handleVoiceCancel}
        handleVoiceToggle={handleVoiceToggle}
        handleVoiceReset={handleVoiceReset}
        isMobile={isMobile}
      />

      {!isMobile && activeSessionId && sessions.length > 0 && (
        <NativeKeyboardInput
          key={activeSessionId}
          sessionId={activeSessionId}
          connected={activeStatus === 'connected'}
          onCommit={handleComposeInput}
        />
      )}
    </div>
  )
}
