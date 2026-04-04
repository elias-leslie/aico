'use client'

import { Terminal } from 'lucide-react'
import Link from 'next/link'

export default function NotFound() {
  return (
    <div
      className="h-dvh flex flex-col items-center justify-center gap-5 px-6"
      style={{ backgroundColor: 'var(--term-bg-deep)', color: 'var(--term-text-primary)' }}
    >
      <div
        className="flex items-center justify-center w-14 h-14 rounded-full"
        style={{
          backgroundColor: 'var(--term-bg-elevated)',
          border: '1px solid var(--term-border)',
        }}
      >
        <Terminal
          className="w-7 h-7"
          style={{ color: 'var(--term-text-muted)' }}
        />
      </div>
      <div className="text-center max-w-md">
        <h1
          className="text-base font-medium mb-2"
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          Page not found
        </h1>
        <p
          className="text-sm leading-relaxed"
          style={{ color: 'var(--term-text-muted)', fontFamily: 'var(--font-mono)' }}
        >
          The page you&apos;re looking for doesn&apos;t exist or has been moved.
        </p>
      </div>
      <Link
        href="/"
        className="flex items-center gap-2 px-5 py-2.5 rounded-md text-sm font-medium transition-all duration-150 hover:brightness-110"
        style={{
          backgroundColor: 'var(--term-bg-elevated)',
          border: '1px solid var(--term-border-active)',
          color: 'var(--term-accent)',
          fontFamily: 'var(--font-mono)',
        }}
      >
        Go Home
      </Link>
    </div>
  )
}
