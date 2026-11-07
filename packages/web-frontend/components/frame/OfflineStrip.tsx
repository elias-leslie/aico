'use client'

import { useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { useServerReach } from '@/lib/frame/server-reach'
import { useClock } from '@/lib/hooks/use-clock'
import { PRODUCT_NAME } from '@/lib/project-branding'
import { at } from '@/lib/status'
import styles from './Frame.module.css'

/** Over everything while the server can't be reached: since when, whether
 * what the page shows is its last answer or nothing yet, and Retry. Nothing
 * at all while it answers. */
export function OfflineStrip() {
  const reach = useServerReach()
  const now = useClock(30_000)
  const queryClient = useQueryClient()
  if (!reach.down) return null
  return (
    <div className={styles.offline} role="status" data-testid="offline-strip">
      <span>
        Can’t reach {PRODUCT_NAME} since {at(reach.since, now)}.{' '}
        {reach.answered
          ? 'Showing what it last knew.'
          : 'Nothing to show yet; sessions come back once it answers.'}
      </span>
      <button
        type="button"
        className="lantern-btn small"
        onClick={() => void queryClient.refetchQueries({ type: 'active' })}
      >
        <RefreshCw
          className="h-3.5 w-3.5"
          strokeWidth={1.7}
          aria-hidden="true"
        />
        Retry
      </button>
    </div>
  )
}
