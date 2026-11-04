'use client'

import { Activity } from 'lucide-react'
import Link from 'next/link'
import { useStatus } from '@/lib/hooks/use-status'
import { at, type Shown, summaryLine } from '@/lib/status'

/** The badge colour: the worst counted problem's. Unknown stays neutral; amber is the action colour. */
const TONE: Partial<Record<Shown, string>> = {
  failed: 'var(--term-error-text)',
  late: 'var(--beacon)',
  warn: 'var(--beacon)',
  unknown: 'var(--bone)',
}

/** The way into Status: the problem count in the worst state's colour (rows on a machine turned
 * off on purpose don't count). When the read failed it shows "?"; when the count is old (the
 * last read failed, or was long ago) it shows muted, "?" for an old zero. `icon` for the rail,
 * `row` labelled for the session list and the phone's switcher; both open the full page. */
export function StatusLauncher({
  variant = 'icon',
}: {
  variant?: 'icon' | 'row'
}) {
  const { view, failed, stale, old, readAt } = useStatus()
  const summary = view?.summary
  const count = summary?.problems ?? 0
  const dated = !!summary && (stale || old)
  const color = summary?.worst && !dated ? TONE[summary.worst] : undefined
  const title = failed
    ? 'Status: couldn’t load'
    : summary
      ? dated
        ? `Status as of ${at(readAt, Date.now())}, couldn’t refresh: ${summaryLine(summary)}`
        : `Status: ${summaryLine(summary)}`
      : 'Status'
  const text = failed || (dated && count === 0) ? '?' : count > 0 ? count : null
  const badge = text !== null && (
    <span
      aria-hidden="true"
      className={variant === 'icon' ? 'lantern-rail-count' : 'status-count'}
      data-worst={dated || failed ? undefined : (summary?.worst ?? undefined)}
      data-dated={dated || failed ? '' : undefined}
    >
      {text}
    </span>
  )
  return variant === 'icon' ? (
    <Link
      href="/status"
      className="lantern-icon-btn compact relative"
      aria-label={title}
      title={title}
      data-testid="status-link"
    >
      <Activity
        className="h-[18px] w-[18px]"
        strokeWidth={1.7}
        style={{ color }}
      />
      {badge}
    </Link>
  ) : (
    <Link
      href="/status"
      className="lantern-btn ghost small"
      aria-label={title}
      title={title}
      data-testid="status-link"
    >
      <Activity
        className="h-4 w-4"
        strokeWidth={1.7}
        aria-hidden="true"
        style={{ color }}
      />
      Status
      {badge}
    </Link>
  )
}
