'use client'

import { clsx } from 'clsx'
import { useState } from 'react'
import { useAgentTools } from '@/lib/hooks/use-agent-tools'
import { timesLabel } from '@/lib/hooks/use-check-ins'
import { useSignInWatch } from '@/lib/hooks/use-host-admin'
import {
  useAttentionTitle,
  useMarkActiveSeen,
  useSessionAttention,
} from '@/lib/hooks/use-session-attention'
import { useTerminalOrchestration } from '@/lib/hooks/use-terminal-orchestration'
import { useVisualViewportHeight } from '@/lib/hooks/use-visual-viewport-height'
import {
  getSlotSessionId,
  type PaneSlot,
  type TerminalSlot,
} from '@/lib/utils/slot'
import { ConfirmationDialog } from './ConfirmationDialog'
import { NewSessionDialog } from './NewSessionDialog'
import { sessionWhoWhere } from './SessionList'
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
    activeStatus,
    handleKeyboardInput,
    handleKeyboardPaste,
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
    uploadDone,
    clearUploadDone,
    handleUploadClick,
    handleFileSelect,
    handleFileInputChange,
  } = useTerminalOrchestration({ projectId, projectPath })
  // Opening a session clears its needs-you/finished state; the title carries
  // the count of sessions waiting on the owner.
  useMarkActiveSeen(activeSessionId)
  useAttentionTitle(useSessionAttention().needsYouCount)
  // A sign-in session opened from Hosts ends: check that host's sign-in again.
  useSignInWatch(sessions, !isLoading)

  const confirmEndSession = async (keepCheckIns = false) => {
    if (!sessionToEnd || endSessionPending) return
    setEndSessionPending(true)
    setEndSessionError(null)
    try {
      await handleSlotCloseSession(sessionToEnd, { keepCheckIns })
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
  const { agentTools } = useAgentTools()
  const pendingSessionId = sessionToEnd ? getSlotSessionId(sessionToEnd) : null
  // Named as its row is, with agent and host: many sessions share a name.
  const pendingSessionName = sessionToEnd
    ? sessionWhoWhere(terminalSlots ?? [], sessionToEnd, agentTools)
    : ''

  // Ending a session cancels its check-ins unless the owner keeps them.
  const pendingCheckIns = sessionToEnd
    ? (sessions.find((session) => session.id === pendingSessionId)?.check_ins ??
      [])
    : []
  const severalCheckIns = pendingCheckIns.length > 1
  const checkInNote = pendingCheckIns.length
    ? ` This also cancels its check-in${severalCheckIns ? 's' : ''} at ${timesLabel(pendingCheckIns.map((checkIn) => checkIn.time))}. Keep ${severalCheckIns ? 'them' : 'it'}, and the conversation comes back in a new session then.`
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
        uploadDone={uploadDone}
        clearUploadDone={clearUploadDone}
        handleFileInputChange={handleFileInputChange}
        handleFileSelect={handleFileSelect}
        sessions={sessions}
        activeSessionId={activeSessionId}
        activeStatus={activeStatus}
        handleKeyboardInput={handleKeyboardInput}
        handleKeyboardPaste={handleKeyboardPaste}
        handleComposeInput={handleComposeInput}
        className={className}
      />

      <ConfirmationDialog
        isOpen={sessionToEnd !== null}
        title="End session?"
        message={`End ${pendingSessionName}? This stops its process in every view.${checkInNote}`}
        confirmText="End session"
        secondaryText={
          pendingCheckIns.length
            ? `End, keep check-in${severalCheckIns ? 's' : ''}`
            : undefined
        }
        onSecondary={() => {
          void confirmEndSession(true)
        }}
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
        onStart={(projectId, rootPath, mode, host) =>
          handleNewTerminalForProject(projectId, mode, rootPath, host)
        }
        isMobile={isMobile}
      />
    </>
  )
}
