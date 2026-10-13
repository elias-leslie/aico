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
      className="inline-block shrink truncate rounded-full px-[7px] text-[11px] font-semibold leading-4 whitespace-nowrap"
      style={{
        maxWidth: '40%',
        minWidth: '2.5rem',
        color: badge.color,
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
