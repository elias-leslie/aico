import { Clock } from 'lucide-react'
import type { SessionCheckIn } from '@/lib/hooks/use-terminal-sessions'

/** The session's next check-in as a quiet chip: `Check-in 5:30 PM` (weekday
 * when it is not today). Every time is in the tooltip and the label. */
export function CheckInBadge({
  checkIns,
}: {
  checkIns: SessionCheckIn[] | undefined
}) {
  if (!checkIns?.length) return null
  const byTime = [...checkIns].sort((a, b) => a.due_at - b.due_at)
  const [next] = byTime
  const all = byTime.map((checkIn) => checkIn.time).join(', ')
  const label = `Check-in ${next.time}`
  return (
    <span
      data-testid="check-in-badge"
      role="img"
      aria-label={checkIns.length > 1 ? `Check-ins at ${all}` : label}
      title={checkIns.length > 1 ? `Check-ins at ${all}` : label}
      className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 text-[11px] leading-4 whitespace-nowrap"
      style={{
        color: 'var(--mist)',
        backgroundColor: 'color-mix(in srgb, var(--mist) 14%, transparent)',
        fontFamily: 'var(--font-ui)',
      }}
    >
      <Clock className="h-3 w-3" strokeWidth={1.7} aria-hidden="true" />
      {label}
      {checkIns.length > 1 && (
        <span aria-hidden="true">+{checkIns.length - 1}</span>
      )}
    </span>
  )
}
