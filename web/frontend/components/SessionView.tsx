'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ATermComponent, type ATermHandle } from '@/components/ATerm'
import type { ConnectionStatus } from '@/components/a-term.types'
import { UnifiedATermHeaderContent as UnifiedATermHeader } from '@/components/a-term-header'
import { EmptySessionState } from '@/components/EmptySessionState'
import { PaneFilesDialog } from '@/components/files/PaneFilesDialog'
import type { ATermMode } from '@/components/ModeToggle'
import { ConnectionNotice, SizeHolderNotice } from '@/components/TerminalNotice'
import type { ATermFontSize } from '@/lib/hooks/use-a-term-settings'
import type { ATermSlot, PaneSlot } from '@/lib/utils/slot'
import {
  getSlotSessionId,
  getSlotWorkingDir,
  isPaneSlot,
} from '@/lib/utils/slot'

export interface SessionViewProps {
  slots: (ATermSlot | PaneSlot)[]
  activeSessionId?: string | null
  fontSize: ATermFontSize
  isMobile?: boolean
  onATermRef?: (sessionId: string, handle: ATermHandle | null) => void
  onStatusChange?: (sessionId: string, status: ConnectionStatus) => void
  aTermStatuses?: Map<string, ConnectionStatus>
  onSwitch?: (slot: ATermSlot | PaneSlot) => void
  onFontSizeChange?: (size: ATermFontSize) => void
  onReset?: (slot: ATermSlot | PaneSlot) => void
  onCloseSession?: (slot: ATermSlot | PaneSlot) => void
  onUpload?: (sessionId?: string) => void
  onFilePaste?: (file: File, sessionId?: string) => void | Promise<void>
  onNewSession?: () => void
  onModeSwitch?: (
    slot: ATermSlot | PaneSlot,
    mode: ATermMode,
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
  slots: (ATermSlot | PaneSlot)[],
  activeSessionId?: string | null,
): ATermSlot | PaneSlot | undefined {
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
  onATermRef,
  onStatusChange,
  aTermStatuses,
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
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [filesPaneId, setFilesPaneId] = useState<string | null>(null)
  const handleRef = useRef<ATermHandle | null>(null)
  const slot = getShownSlot(slots, activeSessionId)
  const sessionId = slot ? getSlotSessionId(slot) : null
  const status = sessionId ? aTermStatuses?.get(sessionId) : undefined
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

  const workingDir = getSlotWorkingDir(slot)
  const paneId = isPaneSlot(slot) ? slot.paneId : null

  return (
    <div className="h-full w-full" style={{ backgroundColor: 'var(--rim)' }}>
      <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
        <UnifiedATermHeader
          slot={slot}
          isActive={true}
          fontSize={fontSize}
          onFontSizeChange={onFontSizeChange}
          onReset={onReset && slot.can.reset ? () => onReset(slot) : undefined}
          onCloseSession={
            onCloseSession && slot.can.end
              ? () => onCloseSession(slot)
              : undefined
          }
          onRefresh={refresh}
          onFiles={
            paneId && sessionId ? () => setFilesPaneId(paneId) : undefined
          }
          onUpload={
            onUpload ? () => onUpload(sessionId ?? undefined) : undefined
          }
          onOpenModal={sideList ? undefined : onNewSession}
          onModeSwitch={
            onModeSwitch ? (mode) => onModeSwitch(slot, mode) : undefined
          }
          isModeSwitching={isModeSwitching}
          composeOpen={composeOpen}
          onToggleCompose={onToggleCompose}
          isMobile={isMobile}
          allSlots={sideList ? undefined : slots}
          onSwitchTo={sideList ? undefined : onSwitch}
          searchAlwaysOpen={sideList}
          connectionStatus={status}
          onSearch={
            sessionId
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
            sessionId ? () => handleRef.current?.clearSearch() : undefined
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
          {sessionId && (
            <ATermComponent
              key={`${sessionId}:${refreshVersion}`}
              ref={(handle) => {
                handleRef.current = handle
                onATermRef?.(sessionId, handle)
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
            />
          )}
          {sessionId && (
            <ConnectionNotice
              status={status}
              hasConnected={connectedKey === termKey}
              onReconnect={() => handleRef.current?.reconnect()}
              onNewSession={onNewSession}
            />
          )}
          {sizeHolder?.key === termKey && status === 'connected' && (
            <SizeHolderNotice
              holder={sizeHolder.name}
              onUseHere={() => handleRef.current?.claimSize()}
              isMobile={isMobile}
            />
          )}
        </div>
        {paneId && filesPaneId === paneId && sessionId && (
          <PaneFilesDialog
            isOpen={true}
            paneId={paneId}
            onClose={() => setFilesPaneId(null)}
            onInsertPath={(path) => handleRef.current?.pasteInput(path)}
          />
        )}
      </div>
    </div>
  )
}
