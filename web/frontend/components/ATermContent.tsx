import { clsx } from 'clsx'
import type { ATermContentProps } from './aterm-content/types'
import { ATermFileSection } from './aterm-content/ATermFileSection'
import { ATermMobileSection } from './aterm-content/ATermMobileSection'
import { PromptCleaner } from './PromptCleaner'
import { SettingsDropdown } from './SettingsDropdown'
import { VoiceTranscriptPanel } from './VoiceTranscriptPanel'

export type { ATermContentProps }

/**
 * Renders the aterm content area with all modals and overlays
 * Extracted from ATermTabs to reduce component size
 */
export function ATermContent({
  atermSlots,
  fontFamily,
  fontSize,
  scrollback,
  cursorStyle,
  cursorBlink,
  theme,
  fontId,
  themeId,
  showSettings,
  setFontId,
  setFontSize,
  setScrollback,
  setCursorStyle,
  setCursorBlink,
  setThemeId,
  setShowSettings,
  keyboardSize,
  handleKeyboardSizeChange,
  isMobile,
  setATermRef,
  handleStatusChange,
  atermStatuses,
  onSlotSwitch,
  onSlotReset,
  onSlotClose,
  onSlotCloseSession,
  onSlotClean,
  canAddPane,
  handleOpenSettings,
  handleOpenATermManager,
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
  showCleaner,
  cleanerRawPrompt,
  handleCleanerSend,
  handleCleanerCancel,
  cleanPrompt,
  cleanerError,
  clearCleanerError,
  isCleaningPrompt,
  sessions,
  activeSessionId,
  activeMode,
  activeStatus,
  handleKeyboardInput,
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
    <div className={clsx('flex h-full min-h-0 min-w-0 flex-col overflow-visible', className)}>
      {/* Settings dropdown - all settings controls */}
      <SettingsDropdown
        fontId={fontId}
        fontSize={fontSize}
        scrollback={scrollback}
        cursorStyle={cursorStyle}
        cursorBlink={cursorBlink}
        themeId={themeId}
        setFontId={setFontId}
        setFontSize={setFontSize}
        setScrollback={setScrollback}
        setCursorStyle={setCursorStyle}
        setCursorBlink={setCursorBlink}
        setThemeId={setThemeId}
        showSettings={showSettings}
        setShowSettings={setShowSettings}
        keyboardSize={keyboardSize}
        setKeyboardSize={handleKeyboardSizeChange}
        isMobile={isMobile}
        renderTrigger={false}
      />

      {/* A-Term panels, file upload input, and upload status toasts */}
      <ATermFileSection
        atermSlots={atermSlots}
        fontFamily={fontFamily}
        fontSize={fontSize}
        scrollback={scrollback}
        cursorStyle={cursorStyle}
        cursorBlink={cursorBlink}
        theme={theme}
        setATermRef={setATermRef}
        handleStatusChange={handleStatusChange}
        atermStatuses={atermStatuses}
        onSlotSwitch={onSlotSwitch}
        onSlotReset={onSlotReset}
        onSlotClose={onSlotClose}
        onSlotCloseSession={onSlotCloseSession}
        onSlotClean={onSlotClean}
        canAddPane={canAddPane}
        handleOpenSettings={handleOpenSettings}
        handleOpenATermManager={handleOpenATermManager}
        handleUploadClick={handleUploadClick}
        onModeSwitch={onModeSwitch}
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
        isVoiceSupported={isVoiceSupported}
        handleVoiceOpen={handleVoiceOpen}
        isMobile={isMobile}
      />

      {/* Mobile keyboard + voice panel */}
      <ATermMobileSection
        sessions={sessions}
        activeStatus={activeStatus}
        activeMode={activeMode}
        handleKeyboardInput={handleKeyboardInput}
        handleReconnect={handleReconnect}
        keyboardSize={keyboardSize}
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

      {/* Prompt Cleaner Panel */}
      {showCleaner && (
        <PromptCleaner
          rawPrompt={cleanerRawPrompt}
          onSend={handleCleanerSend}
          onCancel={handleCleanerCancel}
          cleanPrompt={cleanPrompt}
          errorMessage={cleanerError}
          onClearError={clearCleanerError}
          isCleaning={isCleaningPrompt}
          showDiffToggle={true}
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
