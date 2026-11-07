'use client'

import { type QuotaGlance, quotaGlances, quotaLine } from '@/lib/frame/quota'
import { useUsage } from '@/lib/hooks/use-usage'
import styles from './Glance.module.css'
import type { GlanceHead } from './glance-types'

/** One subscription: its name and short line, and a bar of how much is left with a tick for how far into the window we are. */
function QuotaBar({ glance }: { glance: QuotaGlance }) {
  const unknown = glance.left === null
  return (
    <li className={styles.quota} title={glance.meaning}>
      <div className={styles.quotaLine}>
        <b>{glance.name}</b>
        <span>{glance.short}</span>
      </div>
      <div
        className={styles.bar}
        data-unknown={unknown ? 'true' : undefined}
        role="img"
        aria-label={
          glance.state !== 'left'
            ? `${glance.name}: ${glance.answer}`
            : `${glance.name}: ${glance.left}% left${glance.gone === null ? '' : `, ${glance.gone}% of the way through the window`}`
        }
      >
        {!unknown && <span style={{ width: `${glance.left}%` }} />}
        {!unknown && glance.gone !== null && (
          <i className={styles.tick} style={{ left: `${glance.gone}%` }} />
        )}
      </div>
    </li>
  )
}

/** Quota for the Panel's heading: each subscription in a few words, or why there are none. */
export function useQuotaGlance(): GlanceHead {
  const { report, loading, failed } = useUsage()
  const glances = quotaGlances(report)
  if (glances.length > 0) return { count: null, line: quotaLine(glances) }
  return {
    count: null,
    line: loading
      ? 'Checking quota…'
      : failed
        ? 'Quota couldn’t be read.'
        : 'No quota reports yet.',
  }
}

/** One bar per subscription. */
export function GlanceQuota() {
  const { report, loading, failed, stale } = useUsage()
  const glances = quotaGlances(report)
  if (loading)
    return (
      <p className={styles.note} role="status">
        Checking quota…
      </p>
    )
  if (failed)
    return (
      <p className={styles.note} role="alert">
        Quota couldn’t be read.
      </p>
    )
  if (glances.length === 0)
    return <p className={styles.note}>No quota reports yet.</p>
  return (
    <ul className={styles.quotas} data-stale={stale ? 'true' : undefined}>
      {glances.map((glance) => (
        <QuotaBar key={glance.id} glance={glance} />
      ))}
    </ul>
  )
}
