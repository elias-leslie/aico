'use client'

import { PanelLeftClose, PanelLeftOpen, Plus } from 'lucide-react'
import { useRef, useState } from 'react'
import { useSessionAttention } from '@/lib/hooks/use-session-attention'
import type { PaneSlot, TerminalSlot } from '@/lib/utils/slot'
import { NeedsYouLauncher } from './asks/NeedsYou'
import { HostsLauncher } from './HostsButton'
import { HealthLauncher } from './health/HealthButton'
import { SessionList, SessionRail, sessionsHeading } from './SessionList'

/** The list's width: the default, its limits, and the keyboard step. */
export const SIDE_LIST_WIDTH = { initial: 320, min: 240, max: 560, step: 16 }
/** Dragged narrower than this, the list folds into the rail. */
const FOLD_BELOW = 180

export const clampWidth = (width: number) =>
  Math.round(
    Math.min(SIDE_LIST_WIDTH.max, Math.max(SIDE_LIST_WIDTH.min, width)),
  )

interface SessionSidebarProps {
  slots: Array<TerminalSlot | PaneSlot>
  /** The session on screen */
  currentId?: string
  onSelect: (slot: TerminalSlot | PaneSlot) => void
  onNewSession?: () => void
  /** Folded into a rail of agent marks */
  collapsed?: boolean
  onCollapsedChange?: (collapsed: boolean) => void
  /** The list's width when open */
  width?: number
  onWidthChange?: (width: number) => void
}

/** Desktop browsers: every session in a list beside the one on screen,
 * oldest first with Needs you on top, or folded into a rail that keeps who
 * needs you and switching in view. Phones open the same list as a sheet. */
export function SessionSidebar({
  slots,
  currentId,
  onSelect,
  onNewSession,
  collapsed = false,
  onCollapsedChange,
  width = SIDE_LIST_WIDTH.initial,
  onWidthChange,
}: SessionSidebarProps) {
  const attention = useSessionAttention()
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const heading = sessionsHeading(slots.length, attention.needsYouCount)
  const newButton = onNewSession && (
    <button
      type="button"
      className="lantern-btn primary"
      onClick={onNewSession}
      data-testid="new-session-btn"
      aria-label="New session"
      title="New session"
      style={{ width: 32, height: 32, padding: 0 }}
    >
      <Plus className="h-4 w-4" strokeWidth={1.7} />
    </button>
  )

  if (collapsed) {
    const needs = attention.needsYouCount
    return (
      <aside
        data-testid="session-sidebar"
        data-collapsed="true"
        className="flex w-14 flex-none flex-col items-center"
        style={{ borderRight: '1px solid rgb(var(--glass-rgb) / 0.05)' }}
      >
        <header className="flex h-12 flex-none items-center">
          <button
            type="button"
            className="lantern-icon-btn compact relative"
            onClick={() => onCollapsedChange?.(false)}
            aria-label={`Show session list · ${heading}`}
            title={`Show session list · ${heading}`}
          >
            <PanelLeftOpen className="h-[18px] w-[18px]" strokeWidth={1.7} />
            {needs > 0 && (
              <span aria-hidden="true" className="lantern-rail-count">
                {needs}
              </span>
            )}
          </button>
        </header>
        {newButton}
        <NeedsYouLauncher variant="icon" />
        <HostsLauncher icon />
        <HealthLauncher variant="icon" />
        <nav
          aria-label="Sessions"
          data-testid="session-list"
          className="flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto overscroll-contain py-2"
        >
          <SessionRail
            slots={slots}
            currentId={currentId}
            attention={attention}
            onSelect={onSelect}
          />
        </nav>
      </aside>
    )
  }

  return (
    <aside
      data-testid="session-sidebar"
      data-resizing={dragWidth !== null ? 'true' : undefined}
      className="relative flex max-w-[50vw] flex-none flex-col"
      style={{
        width: dragWidth ?? width,
        borderRight: '1px solid rgb(var(--glass-rgb) / 0.05)',
      }}
    >
      <header className="flex h-12 flex-none items-center gap-2 pr-1.5 pl-3">
        <h2
          data-testid="session-list-heading"
          className="min-w-0 flex-1 truncate"
          style={{ font: '500 15px/1 var(--font-display)' }}
        >
          {heading}
        </h2>
        <NeedsYouLauncher />
        <HealthLauncher variant="icon" />
        <HostsLauncher icon />
        {onCollapsedChange && (
          <button
            type="button"
            className="lantern-icon-btn compact"
            onClick={() => onCollapsedChange(true)}
            aria-label="Collapse session list"
            title="Collapse session list"
          >
            <PanelLeftClose className="h-[18px] w-[18px]" strokeWidth={1.7} />
          </button>
        )}
        {newButton}
      </header>
      <nav
        aria-label="Sessions"
        data-testid="session-list"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3"
      >
        <SessionList
          slots={slots}
          currentId={currentId}
          attention={attention}
          onSelect={onSelect}
        />
      </nav>
      {onWidthChange && (
        <ResizeHandle
          width={dragWidth ?? width}
          onDrag={setDragWidth}
          onWidthChange={onWidthChange}
          onFold={() => onCollapsedChange?.(true)}
        />
      )}
    </aside>
  )
}

/** The list's right edge: drag, or focus it and use the arrow keys;
 * double-click puts the default width back. The session refits as it goes
 * (its resize is debounced); the width is kept when the drag ends. */
function ResizeHandle({
  width,
  onDrag,
  onWidthChange,
  onFold,
}: {
  width: number
  /** The width while dragging; null when the drag ends */
  onDrag: (width: number | null) => void
  onWidthChange: (width: number) => void
  onFold: () => void
}) {
  const drag = useRef<{ x: number; width: number; raw: number } | null>(null)
  const end = (keep: boolean) => {
    const state = drag.current
    drag.current = null
    onDrag(null)
    if (!state || !keep) return
    if (state.raw < FOLD_BELOW) onFold()
    else onWidthChange(clampWidth(state.raw))
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize session list"
      aria-valuenow={width}
      aria-valuemin={SIDE_LIST_WIDTH.min}
      aria-valuemax={SIDE_LIST_WIDTH.max}
      tabIndex={0}
      title="Drag to resize · double-click for the default width"
      className="lantern-resize"
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.currentTarget.setPointerCapture?.(event.pointerId)
        // From the width on screen, which a narrow window may hold under the kept one.
        const shown =
          event.currentTarget.parentElement?.getBoundingClientRect().width ||
          width
        drag.current = { x: event.clientX, width: shown, raw: shown }
      }}
      onPointerMove={(event) => {
        const state = drag.current
        if (!state) return
        state.raw = state.width + event.clientX - state.x
        onDrag(clampWidth(state.raw))
      }}
      onPointerUp={() => end(true)}
      onPointerCancel={() => end(false)}
      onDoubleClick={() => onWidthChange(SIDE_LIST_WIDTH.initial)}
      onKeyDown={(event) => {
        const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key]
        if (event.key === 'Home') onWidthChange(SIDE_LIST_WIDTH.min)
        else if (event.key === 'End') onWidthChange(SIDE_LIST_WIDTH.max)
        else if (step)
          onWidthChange(clampWidth(width + step * SIDE_LIST_WIDTH.step))
        else return
        event.preventDefault()
      }}
    />
  )
}
