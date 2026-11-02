'use client'

import { ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Suspense } from 'react'
import { CaptureDetail } from '@/components/capture/CaptureDetail'
import { CaptureLauncher } from '@/components/capture/CaptureLauncher'
import { CaptureList } from '@/components/capture/CaptureList'

function Captures() {
  const id = useSearchParams().get('id')
  const detail = id !== null && /^[0-9a-f]{12}$/.test(id)
  return (
    <main
      className="mx-auto flex h-full w-full max-w-xl flex-col px-4"
      style={{ color: 'var(--bone)' }}
    >
      <header className="flex flex-none items-center gap-2 py-3">
        <Link
          href={detail ? '/captures' : '/'}
          className="lantern-icon-btn"
          aria-label={detail ? 'Back to captures' : 'Back to sessions'}
          title={detail ? 'Back to captures' : 'Back to sessions'}
        >
          <ArrowLeft className="h-[18px] w-[18px]" strokeWidth={1.7} />
        </Link>
        <h1
          className="min-w-0 flex-1"
          style={{ font: '500 18px/1.2 var(--font-display)' }}
        >
          {detail ? 'Capture' : 'Captures'}
        </h1>
        <CaptureLauncher variant="row" />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-6">
        {detail ? (
          <CaptureDetail id={id} />
        ) : id !== null ? (
          <p className="py-3 text-[13px]" style={{ color: 'var(--mist)' }}>
            That isn&apos;t a capture link.
          </p>
        ) : (
          <CaptureList />
        )}
      </div>
    </main>
  )
}

export default function CapturesPage() {
  return (
    <div
      className="h-dvh"
      style={{
        backgroundColor: 'var(--term-bg-deep)',
        height: 'var(--terminal-viewport-height, 100dvh)',
      }}
    >
      <Suspense fallback={null}>
        <Captures />
      </Suspense>
    </div>
  )
}
