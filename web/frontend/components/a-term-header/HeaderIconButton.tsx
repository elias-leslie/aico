'use client'

import { clsx } from 'clsx'
import { memo } from 'react'
import type { IconButtonProps } from './types'

export const HeaderIconButton = memo(function HeaderIconButton({
  icon,
  onClick,
  tooltip,
  isMobile,
}: IconButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx('lantern-icon-btn', !isMobile && 'compact')}
      title={tooltip}
      aria-label={tooltip}
    >
      {icon}
    </button>
  )
})
