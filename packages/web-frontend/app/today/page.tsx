'use client'

import { TodayPage } from '@/components/today/TodayPage'

/** /today: the day so far, one line of what changed and who worked when. */
export default function TodayRoute() {
  return (
    <div
      className="status-shell"
      style={{ height: 'var(--terminal-viewport-height, 100dvh)' }}
    >
      <TodayPage />
    </div>
  )
}
