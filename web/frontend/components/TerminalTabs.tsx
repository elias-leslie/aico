'use client'

import { clsx } from 'clsx'
import { useTerminalOrchestration } from '@/lib/hooks/use-terminal-orchestration'
import { KeyboardShortcuts } from './KeyboardShortcuts'
import { TerminalContent } from './TerminalContent'
import { TerminalManagerModal } from './TerminalManagerModal'
import { TerminalSkeleton } from './TerminalSkeleton'

interface TerminalTabsProps {
  projectId?: string
  projectPath?: string
  className?: string
}

export function TerminalTabs({
  projectId,
  projectPath,
  className,
}: TerminalTabsProps) {
  const {
    // Core state
    isLoading,
    sessions,
    externalSessions,
    detachedPanes,
    terminalSlots,
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
    setTerminalRef,
    handleStatusChange,
    terminalStatuses,
    canAddPane,
    swapPanes,
    activeSessionId,
    activeMode,
    activeStatus,
    layoutMode,
    availableLayouts,
    handleKeyboardInput,
    handleReconnect,
    panes,
    handleAddTab,
    handleNewTerminalForProject,

    // Modal handlers
    showTerminalManager,
    handleOpenTerminalManager,
    handleAttachExternalSession,
    handleAttachDetachedPane,
    handleCloseTerminalManager,
    handleCloseKeyboardHelp,

    // Slot handlers
    handleSlotSwitch,
    handleSlotReset,
    handleSlotClose,
    handleSlotCloseSession,
    handleSlotClean,
    handleSlotModeSwitch,
    isModeSwitching,

    // Layout handlers
    handleLayoutModeChange,
    handleLayoutChange,

    // Keyboard shortcuts
    showKeyboardHelp,

    // Action handlers
    fileInputRef,
    progress,
    isUploading,
    uploadError,
    clearUploadError,
    handleUploadClick,
    handleFileSelect,
    handleFileInputChange,
    handleCleanerSend,
    handleCleanerCancel,
    cleanPrompt,
    cleanerError,
    clearCleanerError,
    isCleaningPrompt,

    // Prompt cleaner state
    showCleaner,
    cleanerRawPrompt,

    // Voice input
    showVoice,
    voiceFinalTranscript,
    voiceInterimTranscript,
    voiceStatus,
    voiceError,
    isVoiceSupported,
    handleVoiceOpen,
    handleVoiceSend,
    handleVoiceInsert,
    handleVoiceCancel,
    handleVoiceToggle,
    handleVoiceReset,
  } = useTerminalOrchestration({ projectId, projectPath })

  // Loading state - show skeleton
  if (isLoading) {
    return (
      <div className={clsx('flex flex-col h-full min-h-0', className)}>
        <TerminalSkeleton />
      </div>
    )
  }

  return (
    <>
      <TerminalContent
        terminalSlots={terminalSlots}
        fontFamily={fontFamily}
        fontSize={fontSize}
        scrollback={scrollback}
        cursorStyle={cursorStyle}
        cursorBlink={cursorBlink}
        theme={theme}
        fontId={fontId}
        themeId={themeId}
        showSettings={showSettings}
        setFontId={setFontId}
        setFontSize={setFontSize}
        setScrollback={setScrollback}
        setCursorStyle={setCursorStyle}
        setCursorBlink={setCursorBlink}
        setThemeId={setThemeId}
        setShowSettings={setShowSettings}
        keyboardSize={keyboardSize}
        handleKeyboardSizeChange={handleKeyboardSizeChange}
        isMobile={isMobile}
        setTerminalRef={setTerminalRef}
        handleStatusChange={handleStatusChange}
        terminalStatuses={terminalStatuses}
        onSlotSwitch={handleSlotSwitch}
        onSlotReset={handleSlotReset}
        onSlotClose={handleSlotClose}
        onSlotCloseSession={handleSlotCloseSession}
        onSlotClean={handleSlotClean}
        canAddPane={canAddPane()}
        handleOpenSettings={() => setShowSettings(true)}
        handleOpenTerminalManager={handleOpenTerminalManager}
        handleUploadClick={handleUploadClick}
        onModeSwitch={handleSlotModeSwitch}
        isModeSwitching={!!isModeSwitching}
        onSwapPanes={swapPanes}
        layoutMode={layoutMode}
        availableLayouts={availableLayouts}
        onLayoutModeChange={handleLayoutModeChange}
        onLayoutChange={handleLayoutChange}
        fileInputRef={fileInputRef}
        progress={progress}
        isUploading={isUploading}
        uploadError={uploadError}
        clearUploadError={clearUploadError}
        handleFileInputChange={handleFileInputChange}
        handleFileSelect={handleFileSelect}
        showCleaner={showCleaner}
        cleanerRawPrompt={cleanerRawPrompt}
        handleCleanerSend={handleCleanerSend}
        handleCleanerCancel={handleCleanerCancel}
        cleanPrompt={cleanPrompt}
        cleanerError={cleanerError}
        clearCleanerError={clearCleanerError}
        isCleaningPrompt={isCleaningPrompt}
        sessions={sessions}
        activeSessionId={activeSessionId}
        activeMode={activeMode}
        activeStatus={activeStatus}
        handleKeyboardInput={handleKeyboardInput}
        handleReconnect={handleReconnect}
        showVoice={showVoice}
        isVoiceSupported={isVoiceSupported}
        voiceFinalTranscript={voiceFinalTranscript}
        voiceInterimTranscript={voiceInterimTranscript}
        voiceStatus={voiceStatus}
        voiceError={voiceError}
        handleVoiceOpen={handleVoiceOpen}
        handleVoiceSend={handleVoiceSend}
        handleVoiceInsert={handleVoiceInsert}
        handleVoiceCancel={handleVoiceCancel}
        handleVoiceToggle={handleVoiceToggle}
        handleVoiceReset={handleVoiceReset}
        className={className}
      />

      {/* Terminal Manager Modal */}
      <TerminalManagerModal
        isOpen={showTerminalManager}
        onClose={handleCloseTerminalManager}
        onCreateGenericTerminal={handleAddTab}
        onCreateProjectTerminal={(projectId, rootPath) =>
          handleNewTerminalForProject(projectId, undefined, rootPath)
        }
        externalSessions={externalSessions}
        detachedPanes={detachedPanes}
        onAttachExternalSession={handleAttachExternalSession}
        onAttachDetachedPane={handleAttachDetachedPane}
        panes={panes}
      />

      {/* Keyboard shortcuts help overlay */}
      <KeyboardShortcuts
        isOpen={showKeyboardHelp}
        onClose={handleCloseKeyboardHelp}
      />

    </>
  )
}
