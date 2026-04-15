'use client'

import { clsx } from 'clsx'
import { useATermOrchestration } from '@/lib/hooks/use-a-term-orchestration'
import { ATermContent } from './ATermContent'
import { ATermManagerModal } from './ATermManagerModal'
import { ATermSkeleton } from './ATermSkeleton'
import { KeyboardShortcuts } from './KeyboardShortcuts'

interface ATermTabsProps {
  projectId?: string
  projectPath?: string
  detachedPaneId?: string
  className?: string
}

export function ATermTabs({
  projectId,
  projectPath,
  detachedPaneId,
  className,
}: ATermTabsProps) {
  const {
    // Core state
    isLoading,
    sessions,
    externalSessions,
    detachedPanes,
    aTermSlots,
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
    aTermStatuses,
    canAddPane,
    swapPanes,
    activeSessionId,
    activeMode,
    activeStatus,
    layoutMode,
    availableLayouts,
    storageScopeId,
    handleKeyboardInput,
    handleReconnect,
    panes,
    handleAddTab,
    handleNewATermForProject,

    // Modal handlers
    showATermManager,
    handleOpenATermManager,
    handleAttachExternalSession,
    handleAttachDetachedPane,
    handleCloseATermManager,
    handleCloseKeyboardHelp,

    // Slot handlers
    handleSlotSwitch,
    handleSlotReset,
    handleSlotDetach,
    handleSlotClose,
    handleSlotCloseSession,
    handleSlotClean,
    handleSlotModeSwitch,
    handleSlotProjectSwitch,
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
  } = useATermOrchestration({ projectId, projectPath, detachedPaneId })

  // Loading state - show skeleton
  if (isLoading) {
    return (
      <div className={clsx('flex flex-col h-full min-h-0', className)}>
        <ATermSkeleton />
      </div>
    )
  }

  return (
    <>
      <ATermContent
        aTermSlots={aTermSlots}
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
        setATermRef={setATermRef}
        handleStatusChange={handleStatusChange}
        aTermStatuses={aTermStatuses}
        onSlotSwitch={handleSlotSwitch}
        onSlotReset={handleSlotReset}
        onSlotDetach={handleSlotDetach}
        onSlotClose={handleSlotClose}
        onSlotCloseSession={handleSlotCloseSession}
        onSlotClean={handleSlotClean}
        canAddPane={canAddPane()}
        handleOpenSettings={() => setShowSettings(true)}
        handleOpenATermManager={handleOpenATermManager}
        handleUploadClick={handleUploadClick}
        onModeSwitch={handleSlotModeSwitch}
        onProjectSwitch={handleSlotProjectSwitch}
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
        storageScopeId={storageScopeId}
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

      {/* A-Term Manager Modal */}
      <ATermManagerModal
        isOpen={showATermManager}
        onClose={handleCloseATermManager}
        onCreateGenericATerm={handleAddTab}
        onCreateProjectATerm={(projectId, rootPath) =>
          handleNewATermForProject(projectId, undefined, rootPath)
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
