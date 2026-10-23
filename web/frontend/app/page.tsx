'use client'

import { useSearchParams } from 'next/navigation'
import { Suspense } from 'react'
import { ATermSkeleton } from '@/components/ATermSkeleton'
import { ATermTabs } from '@/components/ATermTabs'

/** The first non-empty value of a query parameter (`?project=&project=x` is x). */
function getSingleSearchParam(
  params: URLSearchParams,
  name: string,
): string | undefined {
  return params.getAll(name).find((entry) => entry.length > 0)
}

// The page is a static file, so the query is read in the browser. Everything
// under the boundary reads it (here and in the session hooks); the export
// renders the skeleton in its place.
function HomeTabs() {
  const searchParams = useSearchParams()
  return (
    <ATermTabs
      projectId={getSingleSearchParam(searchParams, 'project')}
      projectPath={getSingleSearchParam(searchParams, 'dir')}
      className="flex-1 min-h-0"
    />
  )
}

export default function Home() {
  return (
    <div
      className="h-dvh flex flex-col"
      style={{
        backgroundColor: 'var(--term-bg-deep)',
        height: 'var(--a-term-viewport-height, 100dvh)',
      }}
    >
      <Suspense fallback={<ATermSkeleton />}>
        <HomeTabs />
      </Suspense>
    </div>
  )
}
