'use client'

import { clsx } from 'clsx'
import { ChevronDown } from 'lucide-react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ATTENTION_GROUPS,
  type Attention,
  compareAttention,
} from '@/lib/attention'
import { useClickOutside } from '@/lib/hooks/use-click-outside'
import type { SessionAttention } from '@/lib/hooks/use-session-attention'
import {
  type ATermSlot,
  getSlotName,
  getSlotPanelId,
  type PaneSlot,
} from '@/lib/utils/slot'
import { AttentionBadge, NeedsYouCount } from './AttentionBadge'
import { CoordinatorBadge } from './CoordinatorBadge'
import { SessionTitle } from './SessionTitle'

function getSlotMode(slot: ATermSlot | PaneSlot): string {
  if (slot.type === 'project') {
    return slot.activeMode
  }
  return slot.sessionMode ?? 'shell'
}

function getSlotLabel(slot: ATermSlot | PaneSlot): string {
  return `${getSlotName(slot)} [${getSlotMode(slot)}]`
}

interface SessionListEntry {
  id: string
  label: string
  slot: ATermSlot | PaneSlot
  state: Attention | null
}

/** Sessions most urgent first (Aico's tray order), alphabetical within equal
 * state, with duplicate labels numbered. */
export function sortSessionEntries(
  slots: Array<ATermSlot | PaneSlot>,
  attention?: SessionAttention,
): SessionListEntry[] {
  const sorted = [...slots].sort((slotA, slotB) => {
    const labelCompare = getSlotLabel(slotA).localeCompare(
      getSlotLabel(slotB),
      undefined,
      { sensitivity: 'base' },
    )
    if (labelCompare !== 0) {
      return labelCompare
    }
    return getSlotPanelId(slotA).localeCompare(getSlotPanelId(slotB))
  })
  const seenLabelCounts = new Map<string, number>()
  return sorted
    .map((slot) => {
      const baseLabel = getSlotLabel(slot)
      const count = (seenLabelCounts.get(baseLabel) ?? 0) + 1
      seenLabelCounts.set(baseLabel, count)
      return {
        id: getSlotPanelId(slot),
        label: count > 1 ? `${baseLabel} #${count}` : baseLabel,
        slot,
        state: attention?.forSlot(slot) ?? null,
      }
    })
    .sort((a, b) =>
      a.state && b.state ? compareAttention(a.state, b.state) : 0,
    )
}

interface SessionListProps {
  slots: Array<ATermSlot | PaneSlot>
  currentId?: string
  attention?: SessionAttention
  onSelect: (slot: ATermSlot | PaneSlot) => void
}

/** Every session, grouped Needs you / Finished / Working / Idle. */
export function SessionList({
  slots,
  currentId,
  attention,
  onSelect,
}: SessionListProps) {
  const entries = useMemo(
    () => sortSessionEntries(slots, attention),
    [slots, attention],
  )
  return (
    <>
      {entries.map(({ id, label, slot, state }, index) => {
        const isCurrent = id === currentId
        const group = state?.group
        const header =
          group && group !== entries[index - 1]?.state?.group
            ? ATTENTION_GROUPS.find((g) => g.group === group)?.title
            : null
        return (
          <div key={id}>
            {header && (
              <div
                data-testid="session-group-header"
                className="px-3 pt-2 pb-1 text-[11px] uppercase tracking-wide"
                style={{
                  color:
                    group === 'needs-you'
                      ? 'var(--term-danger)'
                      : 'var(--term-text-muted)',
                }}
              >
                {header}
              </div>
            )}
            <button
              type="button"
              onClick={() => onSelect(slot)}
              aria-current={isCurrent ? 'true' : undefined}
              className={clsx(
                'mb-1 flex w-full items-center justify-between rounded-lg px-3 py-3 text-left text-sm transition-colors hover:bg-[var(--term-bg-elevated)]',
                isCurrent && 'ring-1',
              )}
              style={{
                color: 'var(--term-text-primary)',
                backgroundColor: isCurrent
                  ? 'var(--term-bg-elevated)'
                  : 'transparent',
                borderColor: isCurrent
                  ? 'var(--term-accent-muted)'
                  : 'transparent',
              }}
            >
              <span className="flex min-w-0 flex-col items-start gap-1">
                <span className="min-w-0 max-w-full truncate">{label}</span>
                <CoordinatorBadge badge={slot.badge} ownLine />
              </span>
              <span className="ml-3 flex shrink-0 items-center gap-2">
                <AttentionBadge attention={state} />
                {isCurrent && (
                  <span
                    className="text-[11px] uppercase tracking-wide"
                    style={{ color: 'var(--term-text-muted)' }}
                  >
                    Current
                  </span>
                )}
              </span>
            </button>
          </div>
        )
      })}
    </>
  )
}

export interface SessionSwitcherProps {
  /** The session on screen */
  currentSlot: ATermSlot | PaneSlot
  /** Every session the switcher lists */
  allSlots: Array<ATermSlot | PaneSlot>
  onSwitchTo: (slot: ATermSlot | PaneSlot) => void
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
  const triggerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const currentName = getSlotName(currentSlot)
  const currentId = getSlotPanelId(currentSlot)
  const needsYouCount = attention?.needsYouCount ?? 0

  const close = useCallback(() => setIsOpen(false), [])
  const clickOutsideRefs = useMemo(() => [triggerRef, listRef], [])
  useClickOutside(clickOutsideRefs, close, isOpen)
  const select = useCallback(
    (slot: ATermSlot | PaneSlot) => {
      onSwitchTo(slot)
      setIsOpen(false)
    },
    [onSwitchTo],
  )

  const list = (
    <div
      data-testid="session-list"
      className="overflow-y-auto overscroll-contain px-2 pb-3"
      style={{
        maxHeight: isMobile ? 'calc(70vh - 3.5rem)' : '70vh',
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
      />
    </div>
  )

  return (
    <div ref={triggerRef} className="relative flex min-w-0 items-center gap-1">
      <button
        type="button"
        data-testid="session-switcher"
        onClick={() => setIsOpen(!isOpen)}
        className={clsx(
          'flex min-w-0 items-center gap-1 px-1.5 py-0.5 rounded text-xs transition-all duration-150',
          isMobile ? 'max-w-[60vw]' : 'max-w-[420px]',
          'hover:bg-[var(--term-bg-elevated)]',
        )}
        style={{ color: 'var(--term-text-primary)' }}
        title={currentName}
        aria-label={`Sessions. Open: ${currentName}${currentSlot.badge ? ` (${currentSlot.badge.label})` : ''}`}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
      >
        <CoordinatorBadge badge={currentSlot.badge} dot={isMobile} />
        <SessionTitle name={currentName} task={currentSlot.task} />
        <NeedsYouCount count={needsYouCount} />
        <ChevronDown
          className={clsx(
            'w-3 h-3 flex-shrink-0 transition-transform',
            isOpen && 'rotate-180',
          )}
        />
      </button>

      {!isMobile && isOpen && (
        <div
          ref={listRef}
          role="dialog"
          aria-label="Sessions"
          className="absolute left-0 top-full mt-1 z-50 w-[360px] max-w-[90vw] rounded-md pt-2 shadow-lg animate-in fade-in slide-in-from-top-1 duration-100"
          style={{
            backgroundColor: 'var(--term-bg-surface)',
            border: '1px solid var(--term-border-active)',
            boxShadow: 'var(--term-shadow-dropdown)',
          }}
        >
          {list}
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
              className="absolute inset-0 bg-black/50"
              onClick={close}
            />
            <div
              ref={listRef}
              className="relative z-[91] max-h-[70vh] w-full overflow-hidden rounded-t-2xl border-t animate-in slide-in-from-bottom-3 duration-150"
              style={{
                backgroundColor: 'var(--term-bg-surface)',
                borderColor: 'var(--term-border-active)',
                boxShadow: 'var(--term-shadow-dropdown)',
              }}
            >
              <div
                className="mx-auto mt-2 h-1.5 w-12 rounded-full"
                style={{ backgroundColor: 'var(--term-border)' }}
              />
              <div
                className="px-4 py-3 text-[11px] uppercase tracking-wide"
                style={{ color: 'var(--term-text-muted)' }}
              >
                Sessions
              </div>
              {list}
            </div>
          </div>,
          document.body,
        )}
    </div>
  )
}
