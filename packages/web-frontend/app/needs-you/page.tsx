'use client'

import { NeedsYouPage } from '@/components/asks/NeedsYou'

/** /needs-you: every question, access request and answered one, in the main area. */
export default function NeedsYouRoute() {
  return (
    <div
      className="status-shell"
      style={{ height: 'var(--terminal-viewport-height, 100dvh)' }}
    >
      <NeedsYouPage />
    </div>
  )
}
