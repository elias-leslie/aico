'use client'

import { Plus, RotateCcw } from 'lucide-react'
import { useSessionAttention } from '@/lib/hooks/use-session-attention'
import { usePaneListError } from '@/lib/hooks/use-terminal-panes'
import type { PaneSlot, TerminalSlot } from '@/lib/utils/slot'
import { SessionList } from './SessionSwitcher'

interface EmptySessionStateProps {
  /** Running sessions the user can open. */
  slots: Array<TerminalSlot | PaneSlot>
  onOpen?: (slot: TerminalSlot | PaneSlot) => void
  onNewSession?: () => void
}

/**
 * No session open: start one, or open one that is already running.
 */
export function EmptySessionState({
  slots,
  onOpen,
  onNewSession,
}: EmptySessionStateProps) {
  const attention = useSessionAttention()
  const { isError, retry } = usePaneListError()
  const failed = isError && slots.length === 0
  return (
    <div
      className="h-full w-full overflow-y-auto p-4"
      style={{ backgroundColor: 'var(--rim)' }}
    >
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
              No session open.
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
