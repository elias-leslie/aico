import { clsx } from 'clsx'
import { useCallback, useEffect, useRef } from 'react'
import { publishShownSession } from '@/lib/frame/shown-session'
import { useLocalStorageState } from '@/lib/hooks/use-local-storage-state'
import {
  getSlotName,
  getSlotPanelId,
  getSlotSessionId,
  type PaneSlot,
  type TerminalSlot,
} from '@/lib/utils/slot'
import { AgentShows } from './AgentShowToast'
import { SessionAsk } from './asks/SessionAsk'
import { useFrame } from './frame/FrameContext'
import { LeftSide } from './frame/LeftSide'
import { Panel } from './frame/Panel'
import { Rail } from './frame/Rail'
import { NativeKeyboardInput } from './keyboard/NativeKeyboardInput'
import { getShownSlot } from './SessionView'
import { TerminalFileSection } from './terminal-content/TerminalFileSection'
import { TerminalMobileSection } from './terminal-content/TerminalMobileSection'
import type { TerminalContentProps } from './terminal-content/types'

export type { TerminalContentProps }

/** Desktop browsers hide the compose box until it is opened, then remember
 * it on this device. Phones type straight into the session instead. */
const COMPOSE_OPEN_KEY = 'a-term-compose-open'

/**
 * Renders the terminal content area with all modals and overlays
 * Extracted from TerminalTabs to reduce component size
 */
export function TerminalContent(props: TerminalContentProps) {
  return <TerminalContentBody {...props} />
}

function TerminalContentBody({
  terminalSlots,
  fontSize,
  setFontSize,
  isMobile,
  setTerminalRef,
  handleStatusChange,
  terminalStatuses,
  onSlotSwitch,
  onSlotReset,
  onSlotCloseSession,
  handleOpenTerminalManager,
  handleUploadClick,
  onModeSwitch,
  isModeSwitching,
  fileInputRef,
  progress,
  isUploading,
  uploadError,
  clearUploadError,
  uploadDone,
  clearUploadDone,
  handleFileInputChange,
  handleFileSelect,
  sessions,
  activeSessionId,
  activeStatus,
  handleKeyboardInput,
  handleKeyboardPaste,
  handleComposeInput,
  className,
}: TerminalContentProps) {
  const [composeOpen, setComposeOpen] = useLocalStorageState(
    COMPOSE_OPEN_KEY,
    false,
  )
  const frame = useFrame()
  const shownSlot = getShownSlot(terminalSlots, activeSessionId)
  // A deep link or a session picked from the sheet shows that session.
  const setSheetOpen = frame?.setSheetOpen
  // Not on first render: a page opened by its link (/needs-you on a phone)
  // keeps its sheet open.
  const firstSession = useRef(true)
  // biome-ignore lint/correctness/useExhaustiveDependencies: on a new session only
  useEffect(() => {
    if (firstSession.current) {
      firstSession.current = false
      return
    }
    setSheetOpen?.(false)
  }, [activeSessionId])
  useShownSessionPublisher(shownSlot)
  const atFull = frame?.docked === true && frame.tier === 'full'
  const select = (slot: TerminalSlot | PaneSlot) => {
    onSlotSwitch(slot)
    if (frame && !frame.docked) frame.setSheetOpen(false)
    else if (atFull) frame?.setTier('panel')
  }
  const currentId = shownSlot ? getSlotPanelId(shownSlot) : undefined
  // A chat has no terminal to type keys into.
  const chatShown = shownSlot?.chat === true
  const sessionName = (session: string) => {
    const slot = terminalSlots.find((candidate) =>
      getSlotSessionId(candidate)?.startsWith(session),
    )
    return slot ? getSlotName(slot) : null
  }
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
        'relative flex h-full min-h-0 min-w-0 overflow-visible',
        className,
      )}
    >
      <AgentShows sessionName={sessionName} />
      <LeftSide
        onNewSession={handleOpenTerminalManager}
        rail={
          <Rail
            slots={terminalSlots}
            currentId={currentId}
            onSelect={select}
            onNewSession={handleOpenTerminalManager}
          />
        }
        panel={
          <Panel
            slots={terminalSlots}
            currentId={currentId}
            onSelect={select}
          />
        }
      />
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-visible"
        // Full covers the session: it keeps its size underneath, out of reach.
        inert={atFull}
        data-testid="session-side"
      >
        {/* The session, file upload input, and upload status toasts */}
        {
          <TerminalFileSection
            terminalSlots={terminalSlots}
            fontSize={fontSize}
            setTerminalRef={setTerminalRef}
            handleStatusChange={handleStatusChange}
            terminalStatuses={terminalStatuses}
            onSlotSwitch={onSlotSwitch}
            onSlotReset={onSlotReset}
            onSlotCloseSession={onSlotCloseSession}
            setFontSize={setFontSize}
            handleOpenTerminalManager={handleOpenTerminalManager}
            handleUploadClick={handleUploadClick}
            onModeSwitch={onModeSwitch}
            isModeSwitching={isModeSwitching}
            fileInputRef={fileInputRef}
            progress={progress}
            isUploading={isUploading}
            uploadError={uploadError}
            clearUploadError={clearUploadError}
            uploadDone={uploadDone}
            clearUploadDone={clearUploadDone}
            handleFileInputChange={handleFileInputChange}
            handleFileSelect={handleFileSelect}
            activeSessionId={activeSessionId}
            isMobile={isMobile}
            onChatBack={
              frame && !frame.docked
                ? () => frame.setSheetOpen(true)
                : undefined
            }
            composeOpen={composeOpen}
            onToggleCompose={isMobile ? undefined : toggleCompose}
          />
        }

        {/* The open session's question for the owner, above where you type */}
        <SessionAsk
          sessionId={
            !chatShown && shownSlot ? getSlotSessionId(shownSlot) : null
          }
          className="order-3 flex-none"
        />

        {/* Phone typing and key row, while a session is open */}
        {!chatShown && shownSlot && (
          <TerminalMobileSection
            sessions={sessions}
            activeSessionId={activeSessionId}
            handleKeyboardInput={handleKeyboardInput}
            handleKeyboardPaste={handleKeyboardPaste}
            handleFileSelect={handleFileSelect}
            isMobile={isMobile}
          />
        )}

        {!chatShown &&
          !isMobile &&
          composeOpen &&
          activeSessionId &&
          sessions.length > 0 && (
            <div className="order-3">
              <NativeKeyboardInput
                key={activeSessionId}
                inputRef={composeInputRef}
                sessionId={activeSessionId}
                connected={activeStatus === 'connected'}
                onCommit={handleComposeInput}
              />
            </div>
          )}
      </div>
    </div>
  )
}

/** Tell the frame which session is on screen, so leaving a page comes back to it. */
function useShownSessionPublisher(
  slot: TerminalSlot | PaneSlot | null | undefined,
) {
  const sessionId = slot ? getSlotSessionId(slot) : null
  useEffect(() => {
    publishShownSession(sessionId)
    return () => publishShownSession(null)
  }, [sessionId])
}
