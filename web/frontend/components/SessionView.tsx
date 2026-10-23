'use client'

import { useCallback, useRef, useState } from 'react'
import { ATermComponent, type ATermHandle } from '@/components/ATerm'
import type { ConnectionStatus } from '@/components/a-term.types'
import { UnifiedATermHeaderContent as UnifiedATermHeader } from '@/components/a-term-header'
import { EmptySessionState } from '@/components/EmptySessionState'
import { PaneFilesDialog } from '@/components/files/PaneFilesDialog'
import type { ATermMode } from '@/components/ModeToggle'
import type { ATermSlot, PaneSlot } from '@/lib/utils/slot'
import {
  getSlotSessionId,
  getSlotWorkingDir,
  isPaneSlot,
} from '@/lib/utils/slot'

export interface SessionViewProps {
  slots: (ATermSlot | PaneSlot)[]
  activeSessionId?: string | null
  fontSize: number
  isMobile?: boolean
  onATermRef?: (sessionId: string, handle: ATermHandle | null) => void
  onStatusChange?: (sessionId: string, status: ConnectionStatus) => void
  aTermStatuses?: Map<string, ConnectionStatus>
  onSwitch?: (slot: ATermSlot | PaneSlot) => void
  onSettings?: () => void
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
  onSettings,
  onReset,
  onCloseSession,
  onUpload,
  onFilePaste,
  onNewSession,
  onModeSwitch,
  isModeSwitching,
}: SessionViewProps) {
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [filesPaneId, setFilesPaneId] = useState<string | null>(null)
  const handleRef = useRef<ATermHandle | null>(null)

  const refresh = useCallback(() => {
    setRefreshVersion((current) => current + 1)
    if (typeof window !== 'undefined') {
      requestAnimationFrame(() => {
        window.dispatchEvent(new Event('resize'))
      })
    }
  }, [])

  const slot = getShownSlot(slots, activeSessionId)
  if (!slot) {
    return (
      <EmptySessionState
        slots={slots}
        onOpen={onSwitch}
        onNewSession={onNewSession}
      />
    )
  }

  const sessionId = getSlotSessionId(slot)
  const workingDir = getSlotWorkingDir(slot)
  const paneId = isPaneSlot(slot) ? slot.paneId : null

  return (
    <div
      className="w-full h-full p-1"
      style={{ backgroundColor: 'var(--term-bg-deep)' }}
    >
      <div
        className="a-term-pane-shell flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-md"
        style={{ backgroundColor: 'var(--term-bg-surface)' }}
      >
        <UnifiedATermHeader
          slot={slot}
          isActive={true}
          onSettings={onSettings}
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
          onOpenModal={onNewSession}
          onModeSwitch={
            onModeSwitch ? (mode) => onModeSwitch(slot, mode) : undefined
          }
          isModeSwitching={isModeSwitching}
          isMobile={isMobile}
          allSlots={slots}
          onSwitchTo={onSwitch}
          connectionStatus={
            sessionId ? aTermStatuses?.get(sessionId) : undefined
          }
          onReconnect={
            sessionId ? () => handleRef.current?.reconnect() : undefined
          }
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

        <div
          className="relative flex-1 min-h-0 min-w-0 overflow-hidden"
          style={{ backgroundColor: 'var(--term-bg-deep)' }}
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
