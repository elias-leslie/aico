'use client'

import { useSearchParams } from 'next/navigation'
import { Suspense } from 'react'
import { StatusPage } from '@/components/status/StatusPage'

/** /status, and a project's page at /status?project=<id>. */
function Status() {
  return <StatusPage project={useSearchParams().get('project') ?? ''} />
}

export default function StatusRoute() {
  return (
    <div
      className="status-shell"
      style={{
        backgroundColor: 'var(--term-bg-deep)',
        height: 'var(--terminal-viewport-height, 100dvh)',
      }}
    >
      <Suspense fallback={null}>
        <Status />
      </Suspense>
    </div>
  )
}
