'use client'

import { Plus } from 'lucide-react'
import { useSessionAttention } from '@/lib/hooks/use-session-attention'
import type { PaneSlot, TerminalSlot } from '@/lib/utils/slot'
import { SessionList, sessionsHeading } from './SessionList'

interface SessionSidebarProps {
  slots: Array<TerminalSlot | PaneSlot>
  /** The session on screen */
  currentId?: string
  onSelect: (slot: TerminalSlot | PaneSlot) => void
  onNewSession?: () => void
}

/** Desktop browsers: every session in a list beside the one on screen,
 * oldest first with Needs you on top. Phones open the same list as a sheet. */
export function SessionSidebar({
  slots,
  currentId,
  onSelect,
  onNewSession,
}: SessionSidebarProps) {
  const attention = useSessionAttention()
  return (
    <aside
      data-testid="session-sidebar"
      className="flex w-[320px] flex-none flex-col"
      style={{ borderRight: '1px solid rgb(var(--glass-rgb) / 0.05)' }}
    >
      <header className="flex h-12 flex-none items-center gap-2 pr-1.5 pl-3">
        <h2
          data-testid="session-list-heading"
          className="min-w-0 flex-1 truncate"
          style={{ font: '500 15px/1 var(--font-display)' }}
        >
          {sessionsHeading(slots.length, attention.needsYouCount)}
        </h2>
        {onNewSession && (
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
        )}
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
    </aside>
  )
}
