'use client'

import { PanelsTopLeft } from 'lucide-react'
import Link from 'next/link'

export default function NotFound() {
  return (
    <div
      className="h-dvh flex flex-col items-center justify-center gap-5 px-6"
      style={{
        backgroundColor: 'var(--term-bg-deep)',
        color: 'var(--term-text-primary)',
      }}
    >
      <div
        className="flex items-center justify-center w-14 h-14 rounded-full"
        style={{
          backgroundColor: 'var(--term-bg-elevated)',
          border: '1px solid var(--term-border)',
        }}
      >
        <PanelsTopLeft
          className="w-7 h-7"
          style={{ color: 'var(--term-text-muted)' }}
        />
      </div>
      <div className="text-center max-w-md">
        <h1
          className="mb-2"
          style={{ font: '450 17px/1.25 var(--font-display)' }}
        >
          Page not found
        </h1>
        <p
          className="text-sm leading-relaxed"
          style={{
            color: 'var(--term-text-muted)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          The page you&apos;re looking for doesn&apos;t exist or has been moved.
        </p>
      </div>
      <Link href="/" className="lantern-btn primary">
        Go home
      </Link>
    </div>
  )
}
