import type { CoordinatorBadgeInfo } from '@/lib/utils/coordinator-badge'

/** A coordinator or lane chip in its coordinator's colour (Aico's role chip). */
export function CoordinatorBadge({
  badge,
}: {
  badge: CoordinatorBadgeInfo | null | undefined
}) {
  if (!badge) return null
  return (
    <span
      data-testid="coordinator-badge"
      className="inline-block shrink-0 truncate rounded-full px-[7px] text-[11px] font-semibold leading-4 whitespace-nowrap"
      style={{
        maxWidth: '45%',
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
