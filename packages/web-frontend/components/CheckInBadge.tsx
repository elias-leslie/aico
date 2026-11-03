import { Clock } from 'lucide-react'
import { pendingCheckInTime } from '@/lib/hooks/use-check-ins'
import type { SessionCheckIn } from '@/lib/hooks/use-terminal-sessions'

/** The session's next check-in as a quiet chip: `Check-in 5:30 PM` (weekday
 * when it is not today), or `Check-in waiting since 2:27 PM` once due. Every
 * time is in the tooltip and the label. */
export function CheckInBadge({
  checkIns,
}: {
  checkIns: SessionCheckIn[] | undefined
}) {
  if (!checkIns?.length) return null
  const now = Date.now()
  const byTime = [...checkIns].sort((a, b) => a.due_at - b.due_at)
  const [next] = byTime
  const waiting = next.due_at <= now
  const all = byTime
    .map((checkIn) => pendingCheckInTime(checkIn.time, checkIn.due_at, now))
    .join(', ')
  const label = `Check-in ${pendingCheckInTime(next.time, next.due_at, now)}`
  const summary =
    checkIns.length > 1 ? `Check-ins ${waiting ? '' : 'at '}${all}` : label
  const tooltip = waiting
    ? `${summary}. It goes in once the session is idle and nothing is typed.`
    : summary
  return (
    <span
      data-testid="check-in-badge"
      role="img"
      aria-label={summary}
      title={tooltip}
      className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 text-[11px] leading-4 whitespace-nowrap"
      style={{
        color: waiting ? 'var(--lantern)' : 'var(--mist)',
        backgroundColor: `color-mix(in srgb, ${waiting ? 'var(--lantern)' : 'var(--mist)'} 14%, transparent)`,
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
