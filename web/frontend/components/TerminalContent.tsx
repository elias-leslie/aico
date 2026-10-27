import { clsx } from 'clsx'
import { useCallback, useEffect, useRef } from 'react'
import { useLocalStorageState } from '@/lib/hooks/use-local-storage-state'
import { useMediaQuery } from '@/lib/hooks/use-media-query'
import { getSlotName, getSlotPanelId, getSlotSessionId } from '@/lib/utils/slot'
import { AgentShows } from './AgentShowToast'
import { NativeKeyboardInput } from './keyboard/NativeKeyboardInput'
import { SessionSidebar, SIDE_LIST_WIDTH } from './SessionSidebar'
import { getShownSlot } from './SessionView'
import { TerminalFileSection } from './terminal-content/TerminalFileSection'
import { TerminalMobileSection } from './terminal-content/TerminalMobileSection'
import type { TerminalContentProps } from './terminal-content/types'

export type { TerminalContentProps }

/** Desktop browsers hide the compose box until it is opened, then remember
 * it on this device. Phones always show it. */
const COMPOSE_OPEN_KEY = 'a-term-compose-open'

/** Wide enough for the session list beside a readable terminal. Narrower
 * desktop windows open the list from the title, as phones do. */
const SIDE_LIST_QUERY = '(min-width: 1024px)'
/** The session list folded into its rail, and its width, remembered on this device. */
const SIDE_LIST_COLLAPSED_KEY = 'aico-side-list-hidden'
const SIDE_LIST_WIDTH_KEY = 'aico-side-list-width'

/**
 * Renders the terminal content area with all modals and overlays
 * Extracted from TerminalTabs to reduce component size
 */
export function TerminalContent({
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
  handleFileInputChange,
  handleFileSelect,
  sessions,
  activeSessionId,
  activeMode,
  activeStatus,
  handleKeyboardInput,
  handleComposeInput,
  showVoice,
  isVoiceSupported,
  voiceFinalTranscript,
  voiceInterimTranscript,
  voiceStatus,
  voiceError,
  handleVoiceOpen,
  handleVoiceSend,
  handleVoiceCancel,
  handleVoiceToggle,
  className,
}: TerminalContentProps) {
  const [composeOpen, setComposeOpen] = useLocalStorageState(
    COMPOSE_OPEN_KEY,
    false,
  )
  const wide = useMediaQuery(SIDE_LIST_QUERY) && !isMobile
  const [sideListCollapsed, setSideListCollapsed] = useLocalStorageState(
    SIDE_LIST_COLLAPSED_KEY,
    false,
  )
  const [sideListWidth, setSideListWidth] = useLocalStorageState(
    SIDE_LIST_WIDTH_KEY,
    SIDE_LIST_WIDTH.initial,
  )
  const shownSlot = getShownSlot(terminalSlots, activeSessionId)
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
        'flex h-full min-h-0 min-w-0 overflow-visible',
        className,
      )}
    >
      <AgentShows sessionName={sessionName} />
      {wide && (
        <SessionSidebar
          slots={terminalSlots}
          currentId={shownSlot ? getSlotPanelId(shownSlot) : undefined}
          onSelect={onSlotSwitch}
          onNewSession={handleOpenTerminalManager}
          collapsed={sideListCollapsed}
          onCollapsedChange={setSideListCollapsed}
          width={sideListWidth}
          onWidthChange={setSideListWidth}
        />
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-visible">
        {/* The session, file upload input, and upload status toasts */}
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
          handleFileInputChange={handleFileInputChange}
          handleFileSelect={handleFileSelect}
          activeSessionId={activeSessionId}
          isMobile={isMobile}
          sideList={wide}
          composeOpen={composeOpen}
          onToggleCompose={isMobile ? undefined : toggleCompose}
        />

        {/* Mobile keyboard + voice panel */}
        <TerminalMobileSection
          sessions={sessions}
          activeSessionId={activeSessionId}
          activeStatus={activeStatus}
          activeMode={activeMode}
          handleKeyboardInput={handleKeyboardInput}
          handleComposeInput={handleComposeInput}
          isVoiceSupported={isVoiceSupported}
          handleVoiceOpen={handleVoiceOpen}
          showVoice={showVoice}
          voiceFinalTranscript={voiceFinalTranscript}
          voiceInterimTranscript={voiceInterimTranscript}
          voiceStatus={voiceStatus}
          voiceError={voiceError}
          handleVoiceSend={handleVoiceSend}
          handleVoiceCancel={handleVoiceCancel}
          handleVoiceToggle={handleVoiceToggle}
          isMobile={isMobile}
        />

        {!isMobile && composeOpen && activeSessionId && sessions.length > 0 && (
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
