'use client'

import { useSearchParams } from 'next/navigation'
import { Suspense } from 'react'
import { HistoryPage } from '@/components/history/HistoryPage'

/** /history lists recent sessions; /history?session=<id> shows one session's transcript;
 * /history?standing=failed lists only the sessions that failed. */
function History() {
  const params = useSearchParams()
  return (
    <HistoryPage
      session={params.get('session') ?? ''}
      failedOnly={params.get('standing') === 'failed'}
    />
  )
}

export default function HistoryRoute() {
  return (
    <div
      className="status-shell"
      style={{
        backgroundColor: 'var(--term-bg-deep)',
        height: 'var(--terminal-viewport-height, 100dvh)',
      }}
    >
      <Suspense fallback={null}>
        <History />
      </Suspense>
    </div>
  )
}
