'use client'

import { offlineMessage, useOffline } from '@/lib/offline'

/** Shown while the service worker answers from the saved copy (both hosts unreachable). */
export function OfflineBanner() {
  const state = useOffline()
  if (!state.offline) return null
  return (
    <p
      role="status"
      data-testid="offline-banner"
      className="mb-1 flex-none rounded-lg px-3 py-2 text-[13px]"
      style={{ background: 'var(--paper)', color: 'var(--beacon)' }}
    >
      {offlineMessage(state)}
    </p>
  )
}

/**
 * Everything inside turns read-only while offline: a disabled fieldset disables every button, box and
 * switch under it, links still work. `display: contents` keeps the page's own flex layout.
 */
export function ReadOnlyScope({ children }: { children: React.ReactNode }) {
  const { offline } = useOffline()
  return (
    <fieldset
      disabled={offline}
      className="contents [&_button:disabled]:cursor-not-allowed [&_button:disabled]:opacity-60"
      style={{ border: 0, margin: 0, padding: 0, minInlineSize: 0 }}
    >
      {children}
    </fieldset>
  )
}
