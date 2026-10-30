'use client'

import { clsx } from 'clsx'
import { ChevronDown } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useClickOutside } from '@/lib/hooks/use-click-outside'
import type { SessionAttention } from '@/lib/hooks/use-session-attention'
import {
  getSlotName,
  getSlotPanelId,
  type PaneSlot,
  type TerminalSlot,
} from '@/lib/utils/slot'
import { NeedsYouCount } from './AttentionBadge'
import { NeedsYouLauncher } from './asks/NeedsYou'
import { CoordinatorBadge } from './CoordinatorBadge'
import { HostBadge } from './HostBadge'
import { HostsButton } from './HostsButton'
import { HostsSheet } from './HostsSheet'
import { HealthLauncher } from './health/HealthButton'
import { SessionList, sessionsHeading } from './SessionList'
import { SessionTitle } from './SessionTitle'

export interface SessionSwitcherProps {
  /** The session on screen */
  currentSlot: TerminalSlot | PaneSlot
  /** Every session the switcher lists */
  allSlots: Array<TerminalSlot | PaneSlot>
  onSwitchTo: (slot: TerminalSlot | PaneSlot) => void
  isMobile?: boolean
  /** Agent state per slot (needs you, finished, working, idle); without it
   * the list is alphabetical and has no badges. */
  attention?: SessionAttention
}

/**
 * The session's title; opens the session list (a bottom sheet on a phone, a
 * menu on a desktop).
 */
export function SessionSwitcher({
  currentSlot,
  allSlots,
  onSwitchTo,
  isMobile = false,
  attention,
}: SessionSwitcherProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [hostsOpen, setHostsOpen] = useState(false)
  const triggerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const currentName = getSlotName(currentSlot)
  const currentId = getSlotPanelId(currentSlot)
  const needsYouCount = attention?.needsYouCount ?? 0
  /** The open session's state and age, `working 3m`. */
  const currentState = attention?.forSlot(currentSlot)?.detail ?? null

  const close = useCallback(() => setIsOpen(false), [])
  const clickOutsideRefs = useMemo(() => [triggerRef, listRef], [])
  useClickOutside(clickOutsideRefs, close, isOpen)
  const select = useCallback(
    (slot: TerminalSlot | PaneSlot) => {
      onSwitchTo(slot)
      setIsOpen(false)
    },
    [onSwitchTo],
  )

  // The Hosts sheet outlives the list: opening it folds the list away.
  const openHosts = useCallback(() => {
    setIsOpen(false)
    setHostsOpen(true)
  }, [])

  useEffect(() => {
    if (!isOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [isOpen])

  const list = (
    <div
      data-testid="session-list"
      className="overflow-y-auto overscroll-contain px-2 pb-3"
      style={{
        maxHeight: isMobile ? undefined : '70vh',
        flex: isMobile ? '1 1 auto' : undefined,
        WebkitOverflowScrolling: 'touch',
        overscrollBehavior: 'contain',
        scrollbarGutter: 'stable',
        touchAction: 'pan-y',
      }}
    >
      <SessionList
        slots={allSlots}
        currentId={currentId}
        attention={attention}
        onSelect={select}
        phone={isMobile}
      />
    </div>
  )

  return (
    <div ref={triggerRef} className="relative flex min-w-0 items-center">
      <button
        type="button"
        data-testid="session-switcher"
        onClick={() => setIsOpen(!isOpen)}
        className={clsx(
          'flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 transition-colors hover:bg-[var(--paper-veil)]',
          isMobile ? 'max-w-full' : 'max-w-[460px]',
        )}
        style={{
          color: 'var(--bone)',
          font: '450 15px/1.2 var(--font-display)',
          letterSpacing: '0.01em',
        }}
        title={currentName}
        aria-label={`Sessions. Open: ${currentName}${currentSlot.badge ? ` (${currentSlot.badge.label})` : ''}`}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
      >
        <CoordinatorBadge badge={currentSlot.badge} dot={isMobile} />
        <HostBadge host={currentSlot.host} state={currentSlot.hostState} />
        <SessionTitle name={currentName} task={currentSlot.task} />
        {isMobile && currentState && (
          <span
            data-testid="session-state"
            className="min-w-[3ch] truncate whitespace-nowrap"
            style={{
              flexShrink: 100,
              color: 'var(--mist)',
              font: '400 12px/1 var(--font-ui)',
            }}
          >
            {currentState}
          </span>
        )}
        <NeedsYouCount count={needsYouCount} />
        <ChevronDown
          aria-hidden="true"
          className={clsx(
            'h-3.5 w-3.5 flex-shrink-0 transition-transform',
            isOpen && 'rotate-180',
          )}
          style={{ color: 'var(--mist)' }}
        />
      </button>

      {!isMobile && isOpen && (
        <div
          ref={listRef}
          role="dialog"
          aria-label="Sessions"
          className="lantern-sheet lantern-enter absolute left-0 top-full z-50 mt-1.5 w-[380px] max-w-[90vw] rounded-xl pt-1"
        >
          {list}
          <div className="flex justify-end gap-2 px-2 pb-2">
            <NeedsYouLauncher variant="row" />
            <HealthLauncher variant="row" />
            <HostsButton onClick={openHosts} />
          </div>
        </div>
      )}

      {isMobile &&
        isOpen &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            data-testid="session-sheet"
            className="fixed inset-0 z-[90] flex items-end"
            role="dialog"
            aria-modal="true"
            aria-label="Sessions"
          >
            <button
              type="button"
              aria-label="Close sessions"
              className="absolute inset-0"
              style={{ backgroundColor: 'var(--scrim)' }}
              onClick={close}
            />
            <div
              ref={listRef}
              className="lantern-sheet lantern-rise relative z-[91] flex max-h-[84dvh] w-full flex-col overflow-hidden rounded-t-[14px]"
            >
              <div
                aria-hidden="true"
                className="mx-auto mt-2 h-1 w-9 flex-none rounded-full"
                style={{ backgroundColor: 'var(--paper-veil)' }}
              />
              <div className="flex flex-none items-center gap-2 pt-3 pr-3 pb-1 pl-[18px]">
                <h2
                  className="min-w-0 flex-1"
                  style={{ font: '500 18px/1.2 var(--font-display)' }}
                >
                  {sessionsHeading(allSlots.length, needsYouCount)}
                </h2>
                <NeedsYouLauncher variant="row" />
                <HealthLauncher variant="row" />
                <HostsButton onClick={openHosts} />
              </div>
              {list}
            </div>
          </div>,
          document.body,
        )}

      {hostsOpen && <HostsSheet open onOpenChange={setHostsOpen} />}
    </div>
  )
}
