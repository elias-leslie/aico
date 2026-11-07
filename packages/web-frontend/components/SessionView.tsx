'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ContinueNotice } from '@/components/ContinueNotice'
import { ChatSession } from '@/components/chat/ChatSession'
import { EmptySessionState } from '@/components/EmptySessionState'
import { FilesDialog } from '@/components/files/FilesDialog'
import type { TerminalMode } from '@/components/ModeToggle'
import { TerminalComponent, type TerminalHandle } from '@/components/Terminal'
import {
  ConnectionNotice,
  HostNotice,
  ModelSwitchNotice,
  SignInLinkNotice,
  SizeClaimedNotice,
  SizeHolderNotice,
} from '@/components/TerminalNotice'
import type { ConnectionStatus, HostAway } from '@/components/terminal.types'
import { UnifiedTerminalHeaderContent as UnifiedTerminalHeader } from '@/components/terminal-header'
import type { ProjectSource } from '@/lib/api/pane-files'
import { type FilesRequest, setFilesOpener } from '@/lib/files-opener'
import { useAgentTools } from '@/lib/hooks/use-agent-tools'
import {
  powerHost,
  signInToolOf,
  useSignInLink,
} from '@/lib/hooks/use-host-admin'
import type { TerminalFontSize } from '@/lib/hooks/use-terminal-settings'
import type { PaneSlot, TerminalSlot } from '@/lib/utils/slot'
import {
  getSlotName,
  getSlotSessionId,
  getSlotWorkingDir,
  isPaneSlot,
} from '@/lib/utils/slot'

/** How long "Now sized for this window" stays after Use here. */
const SIZE_CLAIMED_MS = 6000

/** The link bar for a sign-in session; mounted only for one, so the query runs only then. */
function SignInLink({ sessionId, tool }: { sessionId: string; tool: string }) {
  const link = useSignInLink(sessionId, true)
  const { enabledTools } = useAgentTools()
  if (!link.data) return null
  return (
    <SignInLinkNotice
      url={link.data}
      tool={enabledTools.find((t) => t.slug === tool)?.name ?? tool}
    />
  )
}

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
  onChatBack?: () => void
}

/** The active session, or one of the user's own when none is chosen
 * (undefined); null shows none, as for a link to a session that is gone. */
export function getShownSlot(
  slots: (TerminalSlot | PaneSlot)[],
  activeSessionId?: string | null,
): TerminalSlot | PaneSlot | undefined {
  if (activeSessionId === null) return undefined
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
  onChatBack,
}: SessionViewProps) {
  const [refreshVersion, setRefreshVersion] = useState(0)
  // Files is open, on what it was asked to show.
  const [files, setFiles] = useState<{ request: FilesRequest | null } | null>(
    null,
  )
  const handleRef = useRef<TerminalHandle | null>(null)
  const slot = getShownSlot(slots, activeSessionId)
  const sessionId = slot ? getSlotSessionId(slot) : null
  // A sign-in session shows the link its tool printed as one tappable link.
  const signInTool = slot ? signInToolOf(slot.task ?? getSlotName(slot)) : null
  // Its tab's folder, or (a session outside any tab) its own.
  const project: ProjectSource | null =
    slot && isPaneSlot(slot)
      ? { kind: 'pane', paneId: slot.paneId }
      : sessionId
        ? { kind: 'session', sessionId }
        : null
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
  // Use here was pressed on this terminal: the bar confirms it for a while.
  const [claimedKey, setClaimedKey] = useState<string | null>(null)
  useEffect(() => {
    if (!claimedKey) return
    const timer = setTimeout(() => setClaimedKey(null), SIZE_CLAIMED_MS)
    return () => clearTimeout(timer)
  }, [claimedKey])
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

  if (!slot) {
    return (
      <EmptySessionState
        slots={slots}
        onOpen={onSwitch}
        onNewSession={onNewSession}
      />
    )
  }

  if (slot.chat && sessionId)
    return <ChatSession key={sessionId} id={sessionId} onBack={onChatBack} />

  const workingDir = getSlotWorkingDir(slot)
  // A chat has no terminal to refit, search or type keys into.
  const chat = slot.chat === true
  const awayHere =
    !chat && hostAway?.key === termKey && status === 'connected'
      ? hostAway
      : null

  const holderShown =
    !chat && !awayHere && sizeHolder?.key === termKey && status === 'connected'
  // Use here was pressed on this terminal and the size is this view's now.
  const claimedShown = !holderShown && claimedKey === termKey
  const sizeNotice = holderShown ? (
    <SizeHolderNotice
      holder={sizeHolder.name}
      onUseHere={() => {
        handleRef.current?.claimSize()
        setClaimedKey(termKey)
      }}
      isMobile={isMobile}
    />
  ) : claimedShown ? (
    <SizeClaimedNotice
      onDismiss={() => setClaimedKey(null)}
      isMobile={isMobile}
    />
  ) : null

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
          onModeSwitch={
            onModeSwitch ? (mode) => onModeSwitch(slot, mode) : undefined
          }
          isModeSwitching={isModeSwitching}
          composeOpen={composeOpen}
          onToggleCompose={chat ? undefined : onToggleCompose}
          isMobile={isMobile}
          searchAlwaysOpen={!isMobile}
          connectionStatus={
            chat
              ? undefined
              : awayHere
                ? awayHere.state === 'connecting'
                  ? 'connecting'
                  : 'disconnected'
                : status
          }
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

        {slot.modelSwitch && (
          <ModelSwitchNotice
            key={slot.modelSwitch.key}
            change={slot.modelSwitch}
          />
        )}

        {slot && !signInTool && <ContinueNotice slot={slot} />}

        {signInTool && sessionId && (
          <SignInLink sessionId={sessionId} tool={signInTool} />
        )}

        {/* The size bar sits above the session, never over its output. */}
        {sizeNotice}

        {/* Ink terminal inside one steady frame-edge hairline */}
        <div
          className="relative mx-1 mb-1 min-h-0 min-w-0 flex-1 overflow-hidden rounded"
          style={{
            backgroundColor: 'var(--ink)',
            boxShadow: 'inset 0 0 0 1px var(--frame-edge)',
          }}
        >
          {sessionId && chat && <ChatSession key={sessionId} id={sessionId} />}
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
              onPowerOn={() => powerHost(awayHere.host, 'on')}
            />
          )}
        </div>
        {files && sessionId && (
          <FilesDialog
            isOpen={true}
            project={project}
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
