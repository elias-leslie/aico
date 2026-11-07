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
  /** Shown on the right and makes the row unavailable, still focusable so
   * its tooltip and this note can be read ("Agent sessions only"). */
  unavailable?: string
}

/** A row in a Lantern menu. */
export function MenuItemButton({
  icon,
  label,
  onClick,
  isMobile = false,
  variant = 'default',
  title,
  unavailable,
}: MenuItemButtonProps) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={unavailable ? undefined : onClick}
      title={title}
      aria-disabled={unavailable ? true : undefined}
      className={clsx(
        'lantern-menu-item',
        variant === 'danger' && 'danger',
        unavailable && 'unavailable',
      )}
      style={{ minHeight: isMobile ? 44 : 38 }}
    >
      {icon}
      <span>{label}</span>
      {unavailable && (
        <span className="ml-auto text-xs" style={{ color: 'var(--mist)' }}>
          {unavailable}
        </span>
      )}
    </button>
  )
}
