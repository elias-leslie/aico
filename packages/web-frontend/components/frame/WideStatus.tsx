'use client'

import { StatusPage } from '../status/StatusPage'

/** Wide with no page chosen: Status beside the Panel, as /status shows it. */
export function WideStatus() {
  return (
    <div
      className="status-shell"
      style={{ height: 'var(--terminal-viewport-height, 100dvh)' }}
    >
      <StatusPage project="" search="" kind="" />
    </div>
  )
}
