'use client'

import { useMemo } from 'react'
import {
  digestParts,
  digestStart,
  sinceText,
  spendText,
  useDigest,
  useLastLook,
} from '@/lib/frame/digest'
import { useClock } from '@/lib/hooks/use-clock'
import { TodayTimeline } from './TodayTimeline'

/** The day: what happened since this device last looked, and who worked when. */
export function TodayPage() {
  const lastLook = useLastLook()
  const now = useClock(60_000)
  const start = useMemo(() => digestStart(lastLook, Date.now()), [lastLook])
  const { digest, loading, failed, refetch } = useDigest(start)
  const parts = digest ? digestParts(digest) : null
  const spend = digest ? spendText(digest) : null
  return (
    <main className="status-page">
      <div className="status">
        <header className="status-head">
          <h1>Today</h1>
          <span className="sub">
            who worked when · questions and failures marked
          </span>
        </header>
        <section
          aria-label="While you were away"
          className="status-rows"
          style={{ padding: 12 }}
        >
          <h2 className="lantern-sec">While you were away</h2>
          {loading ? (
            <p className="status-muted">Checking what happened…</p>
          ) : failed || !digest || !parts ? (
            <p className="status-muted" role="alert">
              Couldn’t read what happened.{' '}
              <button
                type="button"
                className="underline"
                onClick={() => void refetch()}
              >
                Try again
              </button>
            </p>
          ) : (
            <p style={{ fontSize: 13.5 }}>
              <span style={{ color: 'var(--mist)', marginRight: 8 }}>
                {sinceText(start, now, lastLook === null)}
              </span>
              {parts.finished}
              {parts.rest.length > 0 && `, ${parts.rest.join(', ')}`}
              {digest.problems.count > 0 &&
                `, ${digest.problems.count} ${digest.problems.count === 1 ? 'problem' : 'problems'}`}
              {spend && ` · ${spend}`}
              {parts.unread && (
                <span style={{ display: 'block', color: 'var(--mist)' }}>
                  {parts.unread}
                </span>
              )}
            </p>
          )}
        </section>
        <section aria-label="Timeline" style={{ padding: 12 }}>
          <TodayTimeline />
        </section>
      </div>
    </main>
  )
}
