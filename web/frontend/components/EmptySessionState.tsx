'use client'

import { Plus, RotateCcw } from 'lucide-react'
import { useSearchParams } from 'next/navigation'
import { useSessionAttention } from '@/lib/hooks/use-session-attention'
import { usePaneListError } from '@/lib/hooks/use-terminal-panes'
import type { PaneSlot, TerminalSlot } from '@/lib/utils/slot'
import { NeedsYouLauncher } from './asks/NeedsYou'
import { HostsLauncher } from './HostsButton'
import { HealthLauncher } from './health/HealthButton'
import { SessionList } from './SessionList'

interface EmptySessionStateProps {
  /** Running sessions the user can open. */
  slots: Array<TerminalSlot | PaneSlot>
  onOpen?: (slot: TerminalSlot | PaneSlot) => void
  onNewSession?: () => void
  /** No session list beside this (a phone or a narrow window): show Needs
   * you, Health and Hosts here, as the session sheet does. */
  showLaunchers?: boolean
}

/**
 * No session open: start one, or open one that is already running.
 */
export function EmptySessionState({
  slots,
  onOpen,
  onNewSession,
  showLaunchers = false,
}: EmptySessionStateProps) {
  const attention = useSessionAttention()
  const { isError, retry } = usePaneListError()
  const failed = isError && slots.length === 0
  // The link named a session that isn't running (or isn't listed yet).
  const missing = useSearchParams()?.get('session') ?? null
  return (
    <div
      className="h-full w-full overflow-y-auto p-4"
      style={{ backgroundColor: 'var(--rim)' }}
    >
      {showLaunchers && (
        <header className="lantern-sheet-tools mx-auto flex max-w-md flex-wrap items-center justify-end gap-2">
          <NeedsYouLauncher variant="row" />
          <HealthLauncher variant="row" />
          <HostsLauncher />
        </header>
      )}
      <div className="mx-auto flex max-w-md flex-col items-center gap-3 pt-[12vh] text-center">
        {failed ? (
          <>
            <p
              role="alert"
              style={{
                font: '450 17px/1.25 var(--font-display)',
                color: 'var(--bone)',
              }}
            >
              Couldn't load your sessions.
            </p>
            <button type="button" onClick={retry} className="lantern-btn">
              <RotateCcw className="h-4 w-4" strokeWidth={1.7} />
              Try again
            </button>
          </>
        ) : (
          <>
            <p
              style={{
                font: '450 17px/1.25 var(--font-display)',
                color: 'var(--bone)',
              }}
            >
              {missing ? 'Session not found.' : 'No session open.'}
            </p>
            <button
              type="button"
              onClick={onNewSession}
              className="lantern-btn primary"
            >
              <Plus className="h-4 w-4" strokeWidth={1.7} />
              New session
            </button>
          </>
        )}
      </div>
      {slots.length > 0 && onOpen && (
        <section
          aria-label="Running sessions"
          className="mx-auto mt-6 max-w-md"
        >
          <SessionList slots={slots} attention={attention} onSelect={onOpen} />
        </section>
      )}
    </div>
  )
}
