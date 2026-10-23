'use client'

import { clsx } from 'clsx'
import { useState } from 'react'
import { useATermOrchestration } from '@/lib/hooks/use-a-term-orchestration'
import {
  useAttentionTitle,
  useMarkActiveSeen,
  useSessionAttention,
} from '@/lib/hooks/use-session-attention'
import { useVisualViewportHeight } from '@/lib/hooks/use-visual-viewport-height'
import {
  type ATermSlot,
  getSlotName,
  getSlotSessionId,
  type PaneSlot,
} from '@/lib/utils/slot'
import { ATermContent } from './ATermContent'
import { ATermSkeleton } from './ATermSkeleton'
import { ConfirmationDialog } from './ConfirmationDialog'
import { NewSessionDialog } from './NewSessionDialog'

interface ATermTabsProps {
  projectId?: string
  projectPath?: string
  className?: string
}

export function ATermTabs({
  projectId,
  projectPath,
  className,
}: ATermTabsProps) {
  useVisualViewportHeight()
  const [sessionToEnd, setSessionToEnd] = useState<ATermSlot | PaneSlot | null>(
    null,
  )
  const [endSessionPending, setEndSessionPending] = useState(false)
  const [endSessionError, setEndSessionError] = useState<string | null>(null)

  const {
    isLoading,
    sessions,
    aTermSlots,
    fontSize,
    showSettings,
    setFontSize,
    setShowSettings,
    isMobile,
    setATermRef,
    handleStatusChange,
    aTermStatuses,
    activeSessionId,
    activeMode,
    activeStatus,
    handleKeyboardInput,
    handleComposeInput,
    handleReconnect,
    handleNewATermForProject,
    showATermManager,
    handleOpenATermManager,
    handleCloseATermManager,
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
    handleVoiceInsert,
    handleVoiceCancel,
    handleVoiceToggle,
    handleVoiceReset,
  } = useATermOrchestration({ projectId, projectPath })
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
        <ATermSkeleton />
      </div>
    )
  }

  return (
    <>
      <ATermContent
        aTermSlots={aTermSlots}
        fontSize={fontSize}
        showSettings={showSettings}
        setFontSize={setFontSize}
        setShowSettings={setShowSettings}
        isMobile={isMobile}
        setATermRef={setATermRef}
        handleStatusChange={handleStatusChange}
        aTermStatuses={aTermStatuses}
        onSlotSwitch={handleSlotSwitch}
        onSlotReset={handleSlotReset}
        onSlotCloseSession={(slot) => {
          setEndSessionError(null)
          setSessionToEnd(slot)
        }}
        handleOpenSettings={() => setShowSettings(true)}
        handleOpenATermManager={handleOpenATermManager}
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
        isOpen={showATermManager}
        onClose={handleCloseATermManager}
        defaultProjectId={
          sessions.find((session) => session.id === activeSessionId)?.project_id
        }
        onStart={(projectId, rootPath, mode) =>
          handleNewATermForProject(projectId, mode, rootPath)
        }
        isMobile={isMobile}
      />
    </>
  )
}
