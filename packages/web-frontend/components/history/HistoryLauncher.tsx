'use client'

import { History } from 'lucide-react'
import Link from 'next/link'

const TITLE = 'Recent sessions: what Claude Code, Codex and Pi did'

/** The way into recent sessions, beside Status. */
export function HistoryLauncher({
  variant = 'icon',
}: {
  variant?: 'icon' | 'row'
}) {
  return variant === 'icon' ? (
    <Link
      href="/history"
      className="lantern-icon-btn compact"
      aria-label={TITLE}
      title={TITLE}
      data-testid="history-link"
    >
      <History className="h-[18px] w-[18px]" strokeWidth={1.7} />
    </Link>
  ) : (
    <Link
      href="/history"
      className="lantern-btn ghost small"
      aria-label={TITLE}
      title={TITLE}
      data-testid="history-link"
    >
      <History className="h-4 w-4" strokeWidth={1.7} aria-hidden="true" />
      Recent
    </Link>
  )
}
