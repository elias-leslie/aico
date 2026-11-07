'use client'

import { useServerReach } from '@/lib/frame/server-reach'
import { useClock } from '@/lib/hooks/use-clock'
import { PRODUCT_NAME } from '@/lib/project-branding'
import { at } from '@/lib/status'
import { useFrame } from './FrameContext'
import { LeftSide } from './LeftSide'

/** The session side before the first session list arrives: the left side
 * still opens pages, and the session area says plainly whether it is
 * loading or the server can't be reached (no endless placeholder). */
export function SessionWaiting({
  onNewSession,
}: {
  onNewSession?: () => void
}) {
  const reach = useServerReach()
  const now = useClock(30_000)
  const atFull = useFrame()?.tier === 'full'
  return (
    <div className="relative flex h-full min-h-0 min-w-0 flex-1">
      <LeftSide onNewSession={onNewSession} loading rail={null} panel={null} />
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center"
        style={{ background: 'var(--ink)', color: 'var(--mist)' }}
        inert={atFull}
        data-testid="session-waiting"
        role="status"
      >
        {reach.down ? (
          <>
            <p style={{ color: 'var(--bone)' }}>
              Can’t reach {PRODUCT_NAME} since {at(reach.since, now)}.
            </p>
            <p className="text-sm">Your sessions show here once it answers.</p>
          </>
        ) : (
          <p className="text-sm">Loading sessions…</p>
        )}
      </div>
    </div>
  )
}
