'use client'

import { useSearchParams } from 'next/navigation'
import { Suspense } from 'react'
import { MachinesPage } from '@/components/machines/MachinesPage'
import { QuotaPage } from '@/components/quota/QuotaPage'
import { StatusPage } from '@/components/status/StatusPage'

/** /status, a project's page at /status?project=<id>, and opening filters
 * (?q=usage opens Quota, ?kind=machine opens Machines). Keyed on the query so
 * another link opens fresh. */
function Status() {
  const params = useSearchParams()
  // Quota and Machines have their own views at the addresses Status used to
  // filter to (the side list links there).
  if (params.get('q') === 'usage') return <QuotaPage />
  if (params.get('kind') === 'machine') return <MachinesPage />
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
