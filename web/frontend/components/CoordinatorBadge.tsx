import type { CoordinatorBadgeInfo } from '@/lib/utils/coordinator-badge'

/** A coordinator or lane chip in its coordinator's colour (Aico's role chip). */
export function CoordinatorBadge({
  badge,
  ownLine = false,
}: {
  badge: CoordinatorBadgeInfo | null | undefined
  /** On a line of its own (phone lists): full width, no shrinking. */
  ownLine?: boolean
}) {
  if (!badge) return null
  return (
    <span
      data-testid="coordinator-badge"
      className="inline-block truncate rounded-full px-[7px] text-[11px] font-semibold leading-4 whitespace-nowrap"
      style={{
        // Gives up width before the title does, down to a stub with its colour.
        flex: ownLine ? 'none' : '0 2 auto',
        minWidth: '3.25rem',
        maxWidth: ownLine ? '100%' : '45%',
        // Readable on light and dark themes: lean toward the theme's text.
        color: `color-mix(in srgb, ${badge.color} 70%, var(--term-text-primary))`,
        backgroundColor: `color-mix(in srgb, ${badge.color} 16%, transparent)`,
        fontFamily: 'var(--font-ui)',
        letterSpacing: '0.02em',
      }}
      title={badge.label}
    >
      {badge.label}
    </span>
  )
}
