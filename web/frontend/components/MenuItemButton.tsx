'use client'

interface MenuItemButtonProps {
  icon: React.ReactNode
  label: string
  onClick: () => void
  isMobile?: boolean
  variant?: 'default' | 'danger'
  title?: string
}

/**
 * Shared menu item button used across dropdown menus.
 * Supports default and danger variants with hover effects.
 */
export function MenuItemButton({
  icon,
  label,
  onClick,
  isMobile = false,
  variant = 'default',
  title,
}: MenuItemButtonProps) {
  const colorVar =
    variant === 'danger' ? 'var(--term-error)' : 'var(--term-text-primary)'
  const hoverColorVar =
    variant === 'danger' ? 'var(--term-error)' : 'var(--term-accent)'

  return (
    <button
      role="menuitem"
      onClick={onClick}
      title={title}
      className={`
        flex items-center gap-2 w-full text-left transition-colors
        ${isMobile ? 'px-3 py-3 text-sm min-h-[44px]' : 'px-2.5 py-2 text-xs'}
      `}
      style={{
        color: colorVar,
        backgroundColor: 'transparent',
        fontFamily: 'var(--font-mono)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = 'var(--term-bg-surface)'
        e.currentTarget.style.color = hoverColorVar
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = 'transparent'
        e.currentTarget.style.color = colorVar
      }}
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}
