'use client'

import { Plus, RotateCcw } from 'lucide-react'
import { usePathname, useSearchParams } from 'next/navigation'
import { newChat } from '@/lib/chat'
import { useServerReach } from '@/lib/frame/server-reach'
import { useSessionAttention } from '@/lib/hooks/use-session-attention'
import { usePaneListError } from '@/lib/hooks/use-terminal-panes'
import type { PaneSlot, TerminalSlot } from '@/lib/utils/slot'
import { useFrame } from './frame/FrameContext'
import { SideEdgeButton, sideIsAway } from './frame/SideEdgeButton'
import { SessionList } from './SessionList'

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
  // Can't reach the server: the list is its last answer, so its states are muted.
  const down = useServerReach().down
  const { isError, retry } = usePaneListError()
  const failed = isError && slots.length === 0
  // The link named a session that isn't running (or isn't listed yet). Only
  // the home link does: Recent's ?session= names a past session beside it.
  const onHome = usePathname() === '/'
  const linked = useSearchParams()?.get('session') ?? null
  const missing = onHome ? linked : null
  // The side panel already lists the sessions: don't repeat them here.
  const frame = useFrame()
  const listedBeside =
    !!frame?.docked && (frame.tier === 'panel' || frame.tier === 'wide')
  return (
    <div
      className="h-full w-full overflow-y-auto p-4"
      style={{ backgroundColor: 'var(--rim)' }}
      data-stale={down ? 'true' : undefined}
    >
      {sideIsAway(frame) && (
        <div className="-mx-2 -mt-2 flex h-12 items-center">
          <SideEdgeButton />
        </div>
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
            <div className="flex flex-wrap justify-center gap-2">
              <button
                type="button"
                onClick={onNewSession}
                className="lantern-btn primary"
              >
                <Plus className="h-4 w-4" strokeWidth={1.7} />
                New session
              </button>
              <button type="button" className="lantern-btn" onClick={newChat}>
                New chat
              </button>
            </div>
          </>
        )}
      </div>
      {slots.length > 0 && onOpen && !listedBeside && (
        <section
          aria-label="Running sessions"
          className="mx-auto mt-6 max-w-md transition-opacity"
          style={{ opacity: down ? 0.62 : 1 }}
        >
          <SessionList slots={slots} attention={attention} onSelect={onOpen} />
        </section>
      )}
    </div>
  )
}
