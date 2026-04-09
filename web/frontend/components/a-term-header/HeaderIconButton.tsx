'use client'

import { clsx } from 'clsx'
import { memo } from 'react'
import type { IconButtonProps } from './types'

export const HeaderIconButton = memo(function HeaderIconButton({
  icon,
  onClick,
  tooltip,
  variant = 'default',
  isMobile,
}: IconButtonProps) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'flex items-center justify-center rounded transition-all duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--term-accent)]',
        isMobile ? 'w-8 h-8' : 'w-6 h-6',
      )}
      style={{
        color:
          variant === 'danger' ? 'var(--term-error)' : 'var(--term-text-muted)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = 'var(--term-bg-elevated)'
        if (variant === 'default') {
          e.currentTarget.style.color = 'var(--term-accent)'
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = 'transparent'
        e.currentTarget.style.color =
          variant === 'danger' ? 'var(--term-error)' : 'var(--term-text-muted)'
      }}
      title={tooltip}
      aria-label={tooltip}
    >
      {icon}
    </button>
  )
})
