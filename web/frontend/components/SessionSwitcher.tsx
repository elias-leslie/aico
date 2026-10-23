'use client'

import { clsx } from 'clsx'
import { ChevronDown } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ATTENTION_GROUPS,
  type Attention,
  compareAttention,
} from '@/lib/attention'
import { useAgentTools } from '@/lib/hooks/use-agent-tools'
import { useClickOutside } from '@/lib/hooks/use-click-outside'
import type { SessionAttention } from '@/lib/hooks/use-session-attention'
import {
  type ATermSlot,
  getSlotName,
  getSlotPanelId,
  type PaneSlot,
} from '@/lib/utils/slot'
import { AgentIcon, getAgentColor } from './AgentIcon'
import { NeedsYouCount } from './AttentionBadge'
import { CoordinatorBadge } from './CoordinatorBadge'
import { SessionTitle } from './SessionTitle'

function getSlotMode(slot: ATermSlot | PaneSlot): string {
  if (slot.type === 'project') {
    return slot.activeMode
  }
  return slot.sessionMode ?? 'shell'
}

interface SessionListEntry {
  id: string
  label: string
  mode: string
  slot: ATermSlot | PaneSlot
  state: Attention | null
}

/** Sessions most urgent first (Aico's tray order), alphabetical within equal
 * state; the same name with the same agent is numbered. */
export function sortSessionEntries(
  slots: Array<ATermSlot | PaneSlot>,
  attention?: SessionAttention,
): SessionListEntry[] {
  const key = (slot: ATermSlot | PaneSlot) =>
    `${getSlotName(slot)} [${getSlotMode(slot)}]`
  const sorted = [...slots].sort((slotA, slotB) => {
    const labelCompare = key(slotA).localeCompare(key(slotB), undefined, {
      sensitivity: 'base',
    })
    if (labelCompare !== 0) {
      return labelCompare
    }
    return getSlotPanelId(slotA).localeCompare(getSlotPanelId(slotB))
  })
  const seenCounts = new Map<string, number>()
  return sorted
    .map((slot) => {
      const count = (seenCounts.get(key(slot)) ?? 0) + 1
      seenCounts.set(key(slot), count)
      const name = getSlotName(slot)
      return {
        id: getSlotPanelId(slot),
        label: count > 1 ? `${name} #${count}` : name,
        mode: getSlotMode(slot),
        slot,
        state: attention?.forSlot(slot) ?? null,
      }
    })
    .sort((a, b) =>
      a.state && b.state ? compareAttention(a.state, b.state) : 0,
    )
}

/** What a row says under its name: who it waits on, or just its agent. */
function rowMeta(agent: string, state: Attention | null): string {
  if (state?.group === 'needs-you') return `${agent} is waiting for you`
  if (state?.group === 'finished') return `${agent} finished · not opened yet`
  return agent
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
  const { agentTools } = useAgentTools()
  const entries = useMemo(
    () => sortSessionEntries(slots, attention),
    [slots, attention],
  )
  const agentName = (mode: string) =>
    agentTools.find((tool) => tool.slug === mode)?.name ??
    (mode === 'shell' ? 'Shell' : mode)
  const groupSize = (group: string) =>
    entries.filter((entry) => entry.state?.group === group).length
  return (
    <>
      {entries.map(({ id, label, mode, slot, state }, index) => {
        const isCurrent = id === currentId
        const group = state?.group
        const header =
          group && group !== entries[index - 1]?.state?.group
            ? ATTENTION_GROUPS.find((g) => g.group === group)?.title
            : null
        const tool = agentTools.find((t) => t.slug === mode)
        return (
          <div key={id}>
            {header && (
              <h3
                data-testid="session-group-header"
                className="lantern-sec mx-2.5 mt-3.5 mb-1.5"
              >
                {header}
                {group && <span className="n">{groupSize(group)}</span>}
              </h3>
            )}
            <button
              type="button"
              onClick={() => onSelect(slot)}
              aria-current={isCurrent ? 'true' : undefined}
              className={clsx('lantern-row', group === 'needs-you' && 'needs')}
            >
              <AgentIcon
                slug={mode}
                size={16}
                color={getAgentColor(mode, tool?.color)}
              />
              <span className="name">{label}</span>
              <span className="when">{state?.age ?? ''}</span>
              <span className="meta">
                {(group === 'needs-you' || group === 'finished') && (
                  <span
                    aria-hidden="true"
                    className="h-[7px] w-[7px] flex-none rounded-full"
                    style={{
                      backgroundColor:
                        group === 'needs-you' ? 'var(--beacon)' : 'var(--jade)',
                    }}
                  />
                )}
                <CoordinatorBadge badge={slot.badge} ownLine />
                <span className="truncate">
                  {rowMeta(agentName(mode), state)}
                </span>
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
        <SessionTitle name={currentName} task={currentSlot.task} />
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
              <h2
                className="flex-none px-[18px] pt-3 pb-1"
                style={{ font: '500 18px/1.2 var(--font-display)' }}
              >
                Sessions
              </h2>
              {list}
            </div>
          </div>,
          document.body,
        )}
    </div>
  )
}
