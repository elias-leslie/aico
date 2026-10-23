'use client'

import { clsx } from 'clsx'
import { Plus } from 'lucide-react'

interface NewSessionButtonProps {
  onClick: () => void
  isMobile: boolean
}

export function NewSessionButton({ onClick, isMobile }: NewSessionButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'flex items-center justify-center rounded ml-1 transition-all duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--term-accent)]',
        'hover:border-[var(--term-accent)] hover:bg-[var(--term-bg-elevated)] hover:text-[var(--term-accent)]',
        isMobile ? 'w-7 h-7' : 'w-5 h-5',
      )}
      style={{
        backgroundColor: 'var(--term-bg-surface)',
        border: '1px solid var(--term-border)',
        color: 'var(--term-text-muted)',
      }}
      title="New session"
      aria-label="New session"
      data-testid="new-session-btn"
    >
      <Plus className={isMobile ? 'w-4 h-4' : 'w-3 h-3'} />
    </button>
  )
}
