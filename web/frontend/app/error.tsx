'use client'

import { AlertTriangle, RefreshCw } from 'lucide-react'
import { useEffect } from 'react'
import { PRODUCT_NAME } from '@/lib/project-branding'

function getDisplayMessage(productName: string): string {
  return `An unexpected error interrupted ${productName}. Reload to restore your session.`
}

// biome-ignore lint/suspicious/noShadowRestrictedNames: Next.js App Router convention requires this export name
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error(`${PRODUCT_NAME} error boundary caught:`, error)
  }, [error])

  return (
    <div
      className="h-dvh flex flex-col items-center justify-center gap-5 px-6"
      style={{
        backgroundColor: 'var(--term-bg-deep)',
        color: 'var(--term-text-primary)',
      }}
      role="alert"
      aria-live="assertive"
    >
      <div
        className="flex items-center justify-center w-14 h-14 rounded-full"
        style={{
          backgroundColor: 'var(--term-error-muted)',
          border: '1px solid var(--term-danger-border)',
        }}
      >
        <AlertTriangle
          className="w-7 h-7"
          style={{ color: 'var(--term-error)' }}
        />
      </div>
      <div className="text-center max-w-md">
        <h1
          className="text-base font-medium mb-2"
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          {PRODUCT_NAME} encountered an error
        </h1>
        <p
          className="text-sm leading-relaxed"
          style={{
            color: 'var(--term-text-muted)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          {getDisplayMessage(PRODUCT_NAME)}
        </p>
        {error.digest ? (
          <p
            className="mt-2 text-xs"
            style={{
              color: 'var(--term-text-dim)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            Reference: {error.digest}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        onClick={reset}
        className="flex items-center gap-2 px-5 py-2.5 rounded-md text-sm font-medium transition-all duration-150 hover:brightness-110"
        style={{
          backgroundColor: 'var(--term-bg-elevated)',
          border: '1px solid var(--term-border-active)',
          color: 'var(--term-accent)',
          fontFamily: 'var(--font-mono)',
        }}
      >
        <RefreshCw className="w-4 h-4" />
        Reload {PRODUCT_NAME}
      </button>
    </div>
  )
}
