'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AgentHubChat } from '@/components/AgentHubChat'
import { EmptySessionState } from '@/components/EmptySessionState'
import { FilesDialog } from '@/components/files/FilesDialog'
import type { TerminalMode } from '@/components/ModeToggle'
import { StepView, useStepViewer } from '@/components/StepViewer'
import { TerminalComponent, type TerminalHandle } from '@/components/Terminal'
import {
  ConnectionNotice,
  HostNotice,
  SizeHolderNotice,
} from '@/components/TerminalNotice'
import type { ConnectionStatus, HostAway } from '@/components/terminal.types'
import { UnifiedTerminalHeaderContent as UnifiedTerminalHeader } from '@/components/terminal-header'
import { type FilesRequest, setFilesOpener } from '@/lib/files-opener'
import type { TerminalFontSize } from '@/lib/hooks/use-terminal-settings'
import type { PaneSlot, TerminalSlot } from '@/lib/utils/slot'
import {
  getSlotName,
  getSlotSessionId,
  getSlotWorkingDir,
  isPaneSlot,
} from '@/lib/utils/slot'

export interface SessionViewProps {
  slots: (TerminalSlot | PaneSlot)[]
  activeSessionId?: string | null
  fontSize: TerminalFontSize
  isMobile?: boolean
  onTerminalRef?: (sessionId: string, handle: TerminalHandle | null) => void
  onStatusChange?: (sessionId: string, status: ConnectionStatus) => void
  terminalStatuses?: Map<string, ConnectionStatus>
  onSwitch?: (slot: TerminalSlot | PaneSlot) => void
  onFontSizeChange?: (size: TerminalFontSize) => void
  onReset?: (slot: TerminalSlot | PaneSlot) => void
  onCloseSession?: (slot: TerminalSlot | PaneSlot) => void
  onUpload?: (sessionId?: string) => void
  onFilePaste?: (file: File, sessionId?: string) => void | Promise<void>
  onNewSession?: () => void
  onModeSwitch?: (
    slot: TerminalSlot | PaneSlot,
    mode: TerminalMode,
  ) => void | Promise<void>
  isModeSwitching?: boolean
  /** Desktop: whether the compose box is shown */
  composeOpen?: boolean
  onToggleCompose?: () => void
  /** The session list sits beside the session (desktop browsers), so the
   * bar shows the title without a switcher and keeps search open. */
  sideList?: boolean
}

/** The active session, or one of the user's own when none is chosen. */
export function getShownSlot(
  slots: (TerminalSlot | PaneSlot)[],
  activeSessionId?: string | null,
): TerminalSlot | PaneSlot | undefined {
  const activeSlot = activeSessionId
    ? slots.find((slot) => getSlotSessionId(slot) === activeSessionId)
    : undefined
  // A free-standing View opens only when chosen: it may be another agent's
  // live session.
  return activeSlot ?? slots.find(isPaneSlot)
}

/**
 * One session at a time: its bar (switcher, mode, search, files, menu) over
 * its terminal.
 */
export function SessionView({
  slots,
  activeSessionId,
  fontSize,
  isMobile = false,
  onTerminalRef,
  onStatusChange,
  terminalStatuses,
  onSwitch,
  onFontSizeChange,
  onReset,
  onCloseSession,
  onUpload,
  onFilePaste,
  onNewSession,
  onModeSwitch,
  isModeSwitching,
  composeOpen,
  onToggleCompose,
  sideList = false,
}: SessionViewProps) {
  const stepViewer = useStepViewer()
  const [refreshVersion, setRefreshVersion] = useState(0)
  // Files is open, on what it was asked to show.
  const [files, setFiles] = useState<{ request: FilesRequest | null } | null>(
    null,
  )
  const handleRef = useRef<TerminalHandle | null>(null)
  const slot = getShownSlot(slots, activeSessionId)
  const sessionId = slot ? getSlotSessionId(slot) : null
  const paneId = slot && isPaneSlot(slot) ? slot.paneId : null
  // Shares and clicked paths open in this view's Files.
  useEffect(() => {
    if (!sessionId) return
    setFilesOpener((request) => setFiles({ request }))
    return () => setFilesOpener(null)
  }, [sessionId])
  const sessionName = (session: string) => {
    const match = slots.find((candidate) =>
      getSlotSessionId(candidate)?.startsWith(session),
    )
    return match ? getSlotName(match) : null
  }
  const status = sessionId ? terminalStatuses?.get(sessionId) : undefined
  // Which terminal (session and redraw) has shown live output.
  const termKey = `${sessionId}:${refreshVersion}`
  const [connectedKey, setConnectedKey] = useState<string | null>(null)
  // Another device holds this terminal's shared size ("Viewing on …").
  const [sizeHolder, setSizeHolder] = useState<{
    key: string
    name: string
  } | null>(null)
  const onSizeHolderChange = useCallback(
    (name: string | null) =>
      setSizeHolder(name === null ? null : { key: termKey, name }),
    [termKey],
  )
  // A remote session's host can't be reached right now.
  const [hostAway, setHostAway] = useState<(HostAway & { key: string }) | null>(
    null,
  )
  const onHostStateChange = useCallback(
    (away: HostAway | null) =>
      setHostAway(away === null ? null : { ...away, key: termKey }),
    [termKey],
  )
  useEffect(() => {
    if (status === 'connected') setConnectedKey(termKey)
  }, [status, termKey])

  const refresh = useCallback(() => {
    setRefreshVersion((current) => current + 1)
    if (typeof window !== 'undefined') {
      requestAnimationFrame(() => {
        window.dispatchEvent(new Event('resize'))
      })
    }
  }, [])

  // A workflow step opened from the list replaces the session until it is closed.
  if (stepViewer.step) {
    return <StepView step={stepViewer.step} onBack={stepViewer.close} />
  }

  if (!slot) {
    return (
      <EmptySessionState
        slots={slots}
        onOpen={onSwitch}
        onNewSession={onNewSession}
      />
    )
  }

  const workingDir = getSlotWorkingDir(slot)
  // An Agent Hub session is a chat; it has no terminal to refit, search or type keys into.
  const chat = slot.chat === true
  const awayHere =
    !chat && hostAway?.key === termKey && status === 'connected'
      ? hostAway
      : null

  return (
    <div className="h-full w-full" style={{ backgroundColor: 'var(--rim)' }}>
      <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
        <UnifiedTerminalHeader
          slot={slot}
          isActive={true}
          fontSize={fontSize}
          onFontSizeChange={chat ? undefined : onFontSizeChange}
          onReset={
            onReset && slot.can.reset && !chat ? () => onReset(slot) : undefined
          }
          onCloseSession={
            onCloseSession && slot.can.end
              ? () => onCloseSession(slot)
              : undefined
          }
          onRefresh={chat ? undefined : refresh}
          onFiles={
            sessionId && !chat ? () => setFiles({ request: null }) : undefined
          }
          onUpload={
            onUpload && !chat
              ? () => onUpload(sessionId ?? undefined)
              : undefined
          }
          onOpenModal={sideList ? undefined : onNewSession}
          onModeSwitch={
            onModeSwitch ? (mode) => onModeSwitch(slot, mode) : undefined
          }
          isModeSwitching={isModeSwitching}
          composeOpen={composeOpen}
          onToggleCompose={chat ? undefined : onToggleCompose}
          isMobile={isMobile}
          allSlots={sideList ? undefined : slots}
          onSwitchTo={sideList ? undefined : onSwitch}
          searchAlwaysOpen={sideList}
          connectionStatus={chat ? undefined : status}
          onSearch={
            sessionId && !chat
              ? (query, options) =>
                  handleRef.current?.search(query, options) ?? {
                    query,
                    totalMatches: 0,
                    activeIndex: -1,
                    found: false,
                  }
              : undefined
          }
          onClearSearch={
            sessionId && !chat
              ? () => handleRef.current?.clearSearch()
              : undefined
          }
        />

        {/* Ink terminal inside one steady frame-edge hairline */}
        <div
          className="relative mx-1 mb-1 min-h-0 min-w-0 flex-1 overflow-hidden rounded"
          style={{
            backgroundColor: 'var(--ink)',
            boxShadow: 'inset 0 0 0 1px var(--frame-edge)',
          }}
        >
          {sessionId && chat && (
            <AgentHubChat key={sessionId} source={{ session: sessionId }} />
          )}
          {sessionId && !chat && (
            <TerminalComponent
              key={`${sessionId}:${refreshVersion}`}
              ref={(handle) => {
                handleRef.current = handle
                onTerminalRef?.(sessionId, handle)
              }}
              sessionId={sessionId}
              sessionMode={
                slot.type === 'project' ? slot.activeMode : slot.sessionMode
              }
              workingDir={workingDir || undefined}
              className="h-full"
              fontSize={fontSize}
              onStatusChange={(status) => onStatusChange?.(sessionId, status)}
              onFilePaste={
                onFilePaste
                  ? (file) => {
                      void onFilePaste(file, sessionId)
                    }
                  : undefined
              }
              onSizeHolderChange={onSizeHolderChange}
              onHostStateChange={onHostStateChange}
            />
          )}
          {sessionId && !chat && (
            <ConnectionNotice
              status={status}
              hasConnected={connectedKey === termKey}
              onReconnect={() => handleRef.current?.reconnect()}
              onNewSession={onNewSession}
            />
          )}
          {awayHere && (
            <HostNotice
              away={awayHere}
              onReconnect={() => handleRef.current?.reconnectHost()}
            />
          )}
          {!chat &&
            !awayHere &&
            sizeHolder?.key === termKey &&
            status === 'connected' && (
              <SizeHolderNotice
                holder={sizeHolder.name}
                onUseHere={() => handleRef.current?.claimSize()}
                isMobile={isMobile}
              />
            )}
        </div>
        {files && sessionId && (
          <FilesDialog
            isOpen={true}
            paneId={paneId}
            request={files.request}
            onClose={() => setFiles(null)}
            onInsertPath={(path) => handleRef.current?.pasteInput(path)}
            sessionName={sessionName}
          />
        )}
      </div>
    </div>
  )
}
