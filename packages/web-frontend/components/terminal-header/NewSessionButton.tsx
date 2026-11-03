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
      className={clsx('lantern-icon-btn', !isMobile && 'compact')}
      title="New session"
      aria-label="New session"
      data-testid="new-session-btn"
    >
      <Plus className="h-[18px] w-[18px]" strokeWidth={1.7} />
    </button>
  )
}
