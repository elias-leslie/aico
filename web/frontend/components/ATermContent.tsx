import { clsx } from 'clsx'
import { AgentShows } from './AgentShowToast'
import { ATermFileSection } from './a-term-content/ATermFileSection'
import { ATermMobileSection } from './a-term-content/ATermMobileSection'
import type { ATermContentProps } from './a-term-content/types'
import { NativeKeyboardInput } from './keyboard/NativeKeyboardInput'
import { SettingsDropdown } from './SettingsDropdown'
import { VoiceTranscriptPanel } from './VoiceTranscriptPanel'

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
  keyboardMode,
  keyboardSize,
  keyboardSpacing,
  handleKeyboardModeChange,
  handleKeyboardSizeChange,
  handleKeyboardSpacingChange,
  isMobile,
  setATermRef,
  handleStatusChange,
  aTermStatuses,
  onSlotSwitch,
  onSlotReset,
  onSlotDetach,
  onSlotClose,
  onSlotCloseSession,
  onSlotRefresh,
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
  sessions,
  activeSessionId,
  storageScopeId,
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
        keyboardMode={keyboardMode}
        keyboardSize={keyboardSize}
        keyboardSpacing={keyboardSpacing}
        setKeyboardMode={handleKeyboardModeChange}
        setKeyboardSize={handleKeyboardSizeChange}
        setKeyboardSpacing={handleKeyboardSpacingChange}
        isMobile={isMobile}
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
        onSlotDetach={onSlotDetach}
        onSlotClose={onSlotClose}
        onSlotCloseSession={onSlotCloseSession}
        onSlotRefresh={onSlotRefresh}
        canAddPane={canAddPane}
        handleOpenSettings={handleOpenSettings}
        handleOpenATermManager={handleOpenATermManager}
        handleUploadClick={handleUploadClick}
        onModeSwitch={onModeSwitch}
        onProjectSwitch={onProjectSwitch}
        isModeSwitching={isModeSwitching}
        onSwapPanes={onSwapPanes}
        layoutMode={layoutMode}
        availableLayouts={availableLayouts}
        onLayoutModeChange={onLayoutModeChange}
        onLayoutChange={onLayoutChange}
        fileInputRef={fileInputRef}
        progress={progress}
        isUploading={isUploading}
        uploadError={uploadError}
        clearUploadError={clearUploadError}
        handleFileInputChange={handleFileInputChange}
        handleFileSelect={handleFileSelect}
        activeSessionId={activeSessionId}
        storageScopeId={storageScopeId}
        isVoiceSupported={isVoiceSupported}
        handleVoiceOpen={handleVoiceOpen}
        isMobile={isMobile}
      />

      {/* Mobile keyboard + voice panel */}
      <ATermMobileSection
        sessions={sessions}
        activeSessionId={activeSessionId}
        storageScopeId={storageScopeId}
        activeStatus={activeStatus}
        activeMode={activeMode}
        handleKeyboardInput={handleKeyboardInput}
        handleComposeInput={handleComposeInput}
        handleReconnect={handleReconnect}
        keyboardMode={keyboardMode}
        keyboardSize={keyboardSize}
        keyboardSpacing={keyboardSpacing}
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
          key={`${storageScopeId ?? ''}:${activeSessionId}`}
          sessionId={activeSessionId}
          storageScopeId={storageScopeId}
          connected={activeStatus === 'connected'}
          onCommit={handleComposeInput}
        />
      )}

      {/* Desktop voice panel — overlay/bottom-sheet */}
      {showVoice && !isMobile && (
        <VoiceTranscriptPanel
          transcript={voiceFinalTranscript}
          interimTranscript={voiceInterimTranscript}
          status={voiceStatus}
          error={voiceError}
          onSend={handleVoiceSend}
          onInsert={handleVoiceInsert}
          onCancel={handleVoiceCancel}
          onToggleListening={handleVoiceToggle}
          onReset={handleVoiceReset}
        />
      )}
    </div>
  )
}
