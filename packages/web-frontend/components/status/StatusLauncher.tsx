'use client'

import { Activity } from 'lucide-react'
import Link from 'next/link'
import { useStatus } from '@/lib/hooks/use-status'
import { type Shown, summaryLine } from '@/lib/status'

/** The badge colour: the worst counted problem's. Unknown stays neutral; amber is the action colour. */
const TONE: Partial<Record<Shown, string>> = {
  failed: 'var(--term-error-text)',
  late: 'var(--beacon)',
  warn: 'var(--beacon)',
  unknown: 'var(--bone)',
}

/** The way into Status: the problem count in the worst state's colour (rows on a machine turned
 * off on purpose don't count). `icon` for the rail, `row` labelled for the session list and the
 * phone's switcher; both open the full page. */
export function StatusLauncher({
  variant = 'icon',
}: {
  variant?: 'icon' | 'row'
}) {
  const { view, failed } = useStatus()
  const summary = view?.summary
  const count = summary?.problems ?? 0
  const color = summary?.worst ? TONE[summary.worst] : undefined
  const title = summary
    ? `Status: ${summaryLine(summary)}`
    : failed
      ? 'Status: couldn’t load'
      : 'Status'
  const badge = count > 0 && (
    <span
      aria-hidden="true"
      className={variant === 'icon' ? 'lantern-rail-count' : 'status-count'}
      data-worst={summary?.worst ?? undefined}
    >
      {count}
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
