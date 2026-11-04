'use client'

import { useSearchParams } from 'next/navigation'
import { Suspense } from 'react'
import { HistoryPage } from '@/components/history/HistoryPage'

/** /history lists recent sessions; /history?session=<id> shows one session's transcript. */
function History() {
  return <HistoryPage session={useSearchParams().get('session') ?? ''} />
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
