'use client'

import { clsx } from 'clsx'

interface MenuItemButtonProps {
  icon: React.ReactNode
  label: string
  onClick: () => void
  isMobile?: boolean
  /** Danger shows in the icon only: ember text on umber is under 4.5:1. */
  variant?: 'default' | 'danger'
  title?: string
}

/** A row in a Lantern menu. */
export function MenuItemButton({
  icon,
  label,
  onClick,
  isMobile = false,
  variant = 'default',
  title,
}: MenuItemButtonProps) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      title={title}
      className={clsx('lantern-menu-item', variant === 'danger' && 'danger')}
      style={{ minHeight: isMobile ? 44 : 38 }}
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}
