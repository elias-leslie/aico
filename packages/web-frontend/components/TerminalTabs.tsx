'use client'

import { clsx } from 'clsx'
import { useEffect, useState } from 'react'
import { useServerReach } from '@/lib/frame/server-reach'
import { useAgentTools } from '@/lib/hooks/use-agent-tools'
import { timesLabel } from '@/lib/hooks/use-check-ins'
import { useSignInWatch } from '@/lib/hooks/use-host-admin'
import {
  useAttentionTitle,
  useMarkActiveSeen,
  useSessionAttention,
} from '@/lib/hooks/use-session-attention'
import { useSessionView } from '@/lib/hooks/use-session-view'
import { useVisualViewportHeight } from '@/lib/hooks/use-visual-viewport-height'
import {
  getSlotSessionId,
  type PaneSlot,
  type TerminalSlot,
} from '@/lib/utils/slot'
import { ConfirmationDialog } from './ConfirmationDialog'
import { NewChatDialog } from './chat/NewChatDialog'
import { SessionWaiting } from './frame/SessionWaiting'
import { NewSessionDialog } from './NewSessionDialog'
import { endAlongsideNote, sessionWhoWhere } from './SessionList'
import { TerminalContent } from './TerminalContent'

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
  const [showChat, setShowChat] = useState(false)
  const serverDown = useServerReach().down
  useEffect(() => {
    const open = () => setShowChat(true)
    window.addEventListener('aico:new-chat', open)
    return () => window.removeEventListener('aico:new-chat', open)
  }, [])
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
    modeSwitchError,
    clearModeSwitchError,
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
  } = useSessionView({ projectId, projectPath })
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

  // Ending a session cancels its check-ins and armed waits unless the owner
  // keeps them (Tether's End keepWakes keeps both).
  const pendingSession = sessionToEnd
    ? sessions.find((session) => session.id === pendingSessionId)
    : undefined
  const pendingCheckIns = pendingSession?.check_ins ?? []
  const pendingWaits = pendingSession?.has_waits === true
  const severalCheckIns = pendingCheckIns.length > 1
  const checkInsWord = `check-in${severalCheckIns ? 's' : ''}`
  const checkInTimes = timesLabel(
    pendingCheckIns.map((checkIn) => checkIn.time),
  )
  let checkInNote = ''
  let keepText: string | undefined
  if (pendingCheckIns.length && pendingWaits) {
    checkInNote = ` This also cancels its ${checkInsWord} at ${checkInTimes} and its waits. Keep them, and the conversation comes back in a new session when one is due or ready.`
    keepText = `End, keep ${checkInsWord} and waits`
  } else if (pendingCheckIns.length) {
    checkInNote = ` This also cancels its ${checkInsWord} at ${checkInTimes}. Keep ${severalCheckIns ? 'them' : 'it'}, and the conversation comes back in a new session then.`
    keepText = `End, keep ${checkInsWord}`
  } else if (pendingWaits) {
    checkInNote =
      ' This also cancels its waits. Keep them, and the conversation comes back in a new session when one is ready.'
    keepText = 'End, keep waits'
  }

  // Before the first list: say loading, or that the server can't be reached
  // (a failed first read is not an empty list).
  if (isLoading || (serverDown && terminalSlots.length === 0)) {
    return (
      <div className={clsx('flex flex-col h-full min-h-0', className)}>
        <SessionWaiting onNewSession={handleOpenTerminalManager} />
      </div>
    )
  }

  // The agent of the newest session that has one, for a device that hasn't
  // started a session here yet.
  const recentAgentSlug =
    sessions
      .filter((session) => session.mode && session.mode !== 'shell')
      .sort(
        (a, b) =>
          Date.parse(b.created_at ?? '') - Date.parse(a.created_at ?? ''),
      )[0]?.mode ?? null

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
        isModeSwitching={isModeSwitching}
        fileInputRef={fileInputRef}
        progress={progress}
        isUploading={isUploading}
        // The toast above the session also says a failed shell/agent switch.
        uploadError={modeSwitchError ?? uploadError}
        clearUploadError={() => {
          clearModeSwitchError()
          clearUploadError()
        }}
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
        message={`End ${pendingSessionName}? This stops its process in every view.${sessionToEnd ? endAlongsideNote(sessionToEnd, agentTools) : ''}${checkInNote}`}
        confirmText="End session"
        secondaryText={keepText}
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

      {showChat && <NewChatDialog onClose={() => setShowChat(false)} />}
      <NewSessionDialog
        isOpen={showTerminalManager}
        onClose={handleCloseTerminalManager}
        defaultProjectId={
          sessions.find((session) => session.id === activeSessionId)
            ?.project_id ?? projectId
        }
        onStart={(projectId, rootPath, mode, host, name) =>
          handleNewTerminalForProject(projectId, mode, rootPath, host, name)
        }
        recentAgentSlug={recentAgentSlug}
        isMobile={isMobile}
      />
    </>
  )
}
