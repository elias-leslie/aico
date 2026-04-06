'use client'

import { useSearchParams } from 'next/navigation'
import { Suspense } from 'react'
import { ATermTabs } from '@/components/ATermTabs'

function ATermPage() {
  const searchParams = useSearchParams()
  const projectId = searchParams.get('project') || undefined
  const projectPath = searchParams.get('dir') || undefined

  return (
    <div className="h-dvh flex flex-col" style={{ backgroundColor: 'var(--term-bg-deep)' }}>
      <ATermTabs
        projectId={projectId}
        projectPath={projectPath}
        className="flex-1 min-h-0"
      />
    </div>
  )
}

// Wrap in Suspense for useSearchParams
export default function Home() {
  return (
    <Suspense
      fallback={
        <div
          className="h-dvh flex items-center justify-center px-6 text-center text-sm"
          style={{ backgroundColor: 'var(--term-bg-deep)', color: 'var(--term-text-muted)', fontFamily: 'var(--font-mono)' }}
          aria-live="polite"
        >
          Preparing aTerm workspace…
        </div>
      }
    >
      <ATermPage />
    </Suspense>
  )
}
