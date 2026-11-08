'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense, useEffect } from 'react'
import { workbenchHref } from '@/lib/workbench-tabs'

/** Mockups moved into the Workbench: the old link opens the Designs tab on the same project. */
function ToDesigns() {
  const router = useRouter()
  const params = useSearchParams()
  const target = workbenchHref('designs', {
    project: params.get('project')?.trim(),
  })
  useEffect(() => {
    router.replace(target)
  }, [router, target])
  return (
    <div role="status" className="files-state">
      <p>Mockups are now Designs in the Workbench. Opening them.</p>
      <a href={target} className="lantern-btn small mt-3">
        Open Designs
      </a>
    </div>
  )
}

export default function MockupsPage() {
  return (
    <Suspense fallback={null}>
      <ToDesigns />
    </Suspense>
  )
}
