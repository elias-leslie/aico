'use client'

import { useSearchParams } from 'next/navigation'
import { Suspense } from 'react'
import { StatusPage } from '@/components/status/StatusPage'

/** /status, a project's page at /status?project=<id>, and opening filters
 * (?q=usage for quota, ?kind=machine for machines). Keyed on the query so
 * another link opens fresh. */
function Status() {
  const params = useSearchParams()
  return (
    <StatusPage
      key={params.toString()}
      project={params.get('project') ?? ''}
      search={params.get('q') ?? ''}
      kind={params.get('kind') ?? ''}
    />
  )
}

export default function StatusRoute() {
  return (
    <div
      className="status-shell"
      style={{ height: 'var(--terminal-viewport-height, 100dvh)' }}
    >
      <Suspense fallback={null}>
        <Status />
      </Suspense>
    </div>
  )
}
