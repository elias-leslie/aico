'use client'

import { clsx } from 'clsx'
import { useState } from 'react'
import {
  useAttentionTitle,
  useMarkActiveSeen,
  useSessionAttention,
} from '@/lib/hooks/use-session-attention'
import { useTerminalOrchestration } from '@/lib/hooks/use-terminal-orchestration'
import { useVisualViewportHeight } from '@/lib/hooks/use-visual-viewport-height'
import {
  getSlotName,
  getSlotSessionId,
  type PaneSlot,
  type TerminalSlot,
} from '@/lib/utils/slot'
import { ConfirmationDialog } from './ConfirmationDialog'
import { NewSessionDialog } from './NewSessionDialog'
import { TerminalContent } from './TerminalContent'
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
  useVisualViewportHeight()
  const [sessionToEnd, setSessionToEnd] = useState<
    TerminalSlot | PaneSlot | null
  >(null)
  const [endSessionPending, setEndSessionPending] = useState(false)
  const [endSessionError, setEndSessionError] = useState<string | null>(null)

  const {
    isLoading,
    sessions,
    terminalSlots,
    fontSize,
    setFontSize,
    isMobile,
    setTerminalRef,
    handleStatusChange,
    terminalStatuses,
    activeSessionId,
    activeMode,
    activeStatus,
    handleKeyboardInput,
    handleComposeInput,
    handleNewTerminalForProject,
    showTerminalManager,
    handleOpenTerminalManager,
    handleCloseTerminalManager,
    handleSlotSwitch,
    handleSlotReset,
    handleSlotCloseSession,
    handleSlotModeSwitch,
    isModeSwitching,
    fileInputRef,
    progress,
    isUploading,
    uploadError,
    clearUploadError,
    handleUploadClick,
    handleFileSelect,
    handleFileInputChange,
    showVoice,
    voiceFinalTranscript,
    voiceInterimTranscript,
    voiceStatus,
    voiceError,
    isVoiceSupported,
    handleVoiceOpen,
    handleVoiceSend,
    handleVoiceCancel,
    handleVoiceToggle,
  } = useTerminalOrchestration({ projectId, projectPath })
  // Opening a session clears its needs-you/finished state; the title carries
  // the count of sessions waiting on the owner.
  useMarkActiveSeen(activeSessionId)
  useAttentionTitle(useSessionAttention().needsYouCount)

  const confirmEndSession = async () => {
    if (!sessionToEnd || endSessionPending) return
    setEndSessionPending(true)
    setEndSessionError(null)
    try {
      await handleSlotCloseSession(sessionToEnd)
      setSessionToEnd(null)
    } catch (error) {
      setEndSessionError(
        error instanceof Error
          ? error.message
          : 'Could not end the session. Try again.',
      )
    } finally {
      setEndSessionPending(false)
    }
  }
  const pendingSessionId = sessionToEnd ? getSlotSessionId(sessionToEnd) : null
  const pendingSessionName = sessionToEnd
    ? (sessions.find((session) => session.id === pendingSessionId)?.name ??
      getSlotName(sessionToEnd))
    : ''

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
        fontSize={fontSize}
        setFontSize={setFontSize}
        isMobile={isMobile}
        setTerminalRef={setTerminalRef}
        handleStatusChange={handleStatusChange}
        terminalStatuses={terminalStatuses}
        onSlotSwitch={handleSlotSwitch}
        onSlotReset={handleSlotReset}
        onSlotCloseSession={(slot) => {
          setEndSessionError(null)
          setSessionToEnd(slot)
        }}
        handleOpenTerminalManager={handleOpenTerminalManager}
        handleUploadClick={handleUploadClick}
        onModeSwitch={handleSlotModeSwitch}
        isModeSwitching={!!isModeSwitching}
        fileInputRef={fileInputRef}
        progress={progress}
        isUploading={isUploading}
        uploadError={uploadError}
        clearUploadError={clearUploadError}
        handleFileInputChange={handleFileInputChange}
        handleFileSelect={handleFileSelect}
        sessions={sessions}
        activeSessionId={activeSessionId}
        activeMode={activeMode}
        activeStatus={activeStatus}
        handleKeyboardInput={handleKeyboardInput}
        handleComposeInput={handleComposeInput}
        showVoice={showVoice}
        isVoiceSupported={isVoiceSupported}
        voiceFinalTranscript={voiceFinalTranscript}
        voiceInterimTranscript={voiceInterimTranscript}
        voiceStatus={voiceStatus}
        voiceError={voiceError}
        handleVoiceOpen={handleVoiceOpen}
        handleVoiceSend={handleVoiceSend}
        handleVoiceCancel={handleVoiceCancel}
        handleVoiceToggle={handleVoiceToggle}
        className={className}
      />

      <ConfirmationDialog
        isOpen={sessionToEnd !== null}
        title="End session?"
        message={`End “${pendingSessionName}”? This stops its process in every view.`}
        confirmText="End session"
        isPending={endSessionPending}
        error={endSessionError}
        onConfirm={() => {
          void confirmEndSession()
        }}
        onCancel={() => {
          setSessionToEnd(null)
          setEndSessionError(null)
        }}
      />

      <NewSessionDialog
        isOpen={showTerminalManager}
        onClose={handleCloseTerminalManager}
        defaultProjectId={
          sessions.find((session) => session.id === activeSessionId)?.project_id
        }
        onStart={(projectId, rootPath, mode) =>
          handleNewTerminalForProject(projectId, mode, rootPath)
        }
        isMobile={isMobile}
      />
    </>
  )
}
