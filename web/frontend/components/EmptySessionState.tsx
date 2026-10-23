'use client'

import { Plus } from 'lucide-react'
import { useSessionAttention } from '@/lib/hooks/use-session-attention'
import type { ATermSlot, PaneSlot } from '@/lib/utils/slot'
import { SessionList } from './SessionSwitcher'

interface EmptySessionStateProps {
  /** Running sessions the user can open. */
  slots: Array<ATermSlot | PaneSlot>
  onOpen?: (slot: ATermSlot | PaneSlot) => void
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
  return (
    <div
      className="w-full h-full overflow-y-auto p-4"
      style={{ backgroundColor: 'var(--term-bg-deep)' }}
    >
      <div className="mx-auto flex max-w-md flex-col gap-4 pt-[10vh]">
        <p
          className="text-center text-sm"
          style={{ color: 'var(--term-text-muted)' }}
        >
          No session open.
        </p>
        <button
          type="button"
          onClick={onNewSession}
          className="mx-auto flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors"
          style={{
            backgroundColor: 'var(--term-bg-elevated)',
            border: '1px solid var(--term-border-active)',
            color: 'var(--term-text-primary)',
          }}
        >
          <Plus className="h-4 w-4" style={{ color: 'var(--term-accent)' }} />
          New session
        </button>
        {slots.length > 0 && onOpen && (
          <section aria-label="Running sessions">
            <SessionList
              slots={slots}
              attention={attention}
              onSelect={onOpen}
            />
          </section>
        )}
      </div>
    </div>
  )
}
