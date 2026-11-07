'use client'

import { PanelLeftOpen } from 'lucide-react'
import Link from 'next/link'
import { useEffect } from 'react'
import { newChat } from '@/lib/chat'
import { useSessionAttention } from '@/lib/hooks/use-session-attention'
import type { PaneSlot, TerminalSlot } from '@/lib/utils/slot'
import {
  NeedsYouLauncher,
  NeedsYouPanel,
  useHostNeedsYou,
  useNeedsYouState,
} from './asks/NeedsYou'
import { ContextLauncher } from './ContextLauncher'
import { CaptureLauncher } from './capture/CaptureLauncher'
import { HostsLauncher } from './HostsButton'
import { HistoryLauncher } from './history/HistoryLauncher'
import { NotesLauncher } from './notes/NotesLauncher'
import { SessionList, SessionRail, sessionsHeading } from './SessionList'
import { StatusLauncher } from './status/StatusLauncher'

interface SessionSidebarProps {
  slots: Array<TerminalSlot | PaneSlot>
  /** The session on screen */
  currentId?: string
  onSelect: (slot: TerminalSlot | PaneSlot) => void
  /** `rail`: icons and one mark per session; `panel`: the labelled list. */
  variant?: 'panel' | 'rail'
  /** The rail's way back out to the panel. */
  onOpenPanel?: () => void
}

/** The session list in the left side's panel slot (until the triage view
 * replaces it), or folded into the rail's marks. Needs you opens in the
 * list's place, and Back brings the list back. The frame owns the width. */
export function SessionSidebar({
  slots,
  currentId,
  onSelect,
  variant = 'panel',
  onOpenPanel,
}: SessionSidebarProps) {
  const attention = useSessionAttention()
  useHostNeedsYou()
  const needsYouOpen = useNeedsYouState().open
  const heading = sessionsHeading(slots.length, attention.needsYouCount)
  // Needs you needs the panel's width: the rail opens out to it.
  useEffect(() => {
    if (needsYouOpen && variant === 'rail') onOpenPanel?.()
  }, [needsYouOpen, variant, onOpenPanel])

  if (needsYouOpen && variant === 'panel')
    return (
      <div
        data-testid="session-sidebar"
        data-mode="needs-you"
        className="flex min-h-0 flex-1 flex-col"
      >
        <NeedsYouPanel />
      </div>
    )

  if (variant === 'rail') {
    const needs = attention.needsYouCount
    return (
      <div
        data-testid="session-sidebar"
        data-collapsed="true"
        className="flex min-h-0 flex-1 flex-col items-center gap-0.5 py-1"
      >
        {onOpenPanel && (
          <button
            type="button"
            className="lantern-icon-btn compact relative"
            onClick={onOpenPanel}
            aria-label={`Open the panel · ${heading} · Alt+2`}
            title={`Open the panel · ${heading} · Alt+2`}
          >
            <PanelLeftOpen className="h-[18px] w-[18px]" strokeWidth={1.7} />
            {needs > 0 && (
              <span aria-hidden="true" className="lantern-rail-count">
                {needs}
              </span>
            )}
          </button>
        )}
        <NeedsYouLauncher variant="icon" />
        <CaptureLauncher variant="icon" />
        <NotesLauncher variant="icon" />
        <HostsLauncher icon />
        <StatusLauncher variant="icon" />
        <HistoryLauncher variant="icon" />
        <ContextLauncher variant="icon" />
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
      </div>
    )
  }

  return (
    <div data-testid="session-sidebar" className="flex min-h-0 flex-1 flex-col">
      <h2
        data-testid="session-list-heading"
        className="flex-none truncate px-3 pt-3 pb-1.5"
        style={{ font: '500 15px/1 var(--font-display)' }}
      >
        {heading}
      </h2>
      {/* Labelled, under the heading, so the heading keeps its width. */}
      <div className="flex flex-none flex-wrap items-center gap-1 px-1.5 pb-1.5">
        <button
          className="lantern-btn ghost small"
          type="button"
          onClick={newChat}
        >
          New chat
        </button>
        <NeedsYouLauncher variant="tool" />
        <CaptureLauncher variant="row" />
        <NotesLauncher variant="row" />
        <StatusLauncher variant="row" />
        <HistoryLauncher variant="row" />
        <ContextLauncher variant="row" />
        <Link href="/projects" className="lantern-btn ghost small">
          Projects
        </Link>
        <Link href="/backups" className="lantern-btn ghost small">
          Backups
        </Link>
        <Link href="/grants" className="lantern-btn ghost small">
          Grants
        </Link>
        <Link href="/app" className="lantern-btn ghost small">
          Phone app
        </Link>
        <Link href="/logins" className="lantern-btn ghost small">
          Logins
        </Link>
        <HostsLauncher />
      </div>
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
    </div>
  )
}
