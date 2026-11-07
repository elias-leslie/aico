'use client'

import { useStatus } from '@/lib/hooks/use-status'
import { useStatusSessions } from '@/lib/hooks/use-status-sessions'
import { machineLabel } from '@/lib/machine-name'
import { plural, reason, WORD, withSessionNames } from '@/lib/status'
import styles from './Glance.module.css'
import type { GlanceHead } from './glance-types'
import { OpenLink } from './OpenLink'

/** How many problems the glance lists; the rest are one link away. */
const SHOWN = 3

/** Status for the Panel's heading: the problem count, or why there is none to show. */
export function useStatusGlance(): GlanceHead & { problems: number | null } {
  const { view, loading } = useStatus()
  const problems = view?.summary.problems ?? null
  if (problems !== null)
    return {
      problems,
      count: problems ? plural(problems, 'problem') : 'all healthy',
      line: null,
    }
  return {
    problems,
    count: null,
    line: loading ? 'Checking Status…' : 'Status couldn’t be read.',
  }
}

/** The top problems, worst first, each with its state chip; "N more in Status" for the rest. */
export function GlanceStatus() {
  const { view, loading, stale } = useStatus()
  const { names } = useStatusSessions()
  const summary = view?.summary
  if (!summary)
    return (
      <p className={styles.note} role={loading ? 'status' : 'alert'}>
        {loading ? 'Checking Status…' : 'Status couldn’t be read.'}
      </p>
    )
  if (summary.problems === 0)
    return (
      <p className={styles.note} data-stale={stale ? 'true' : undefined}>
        {stale ? 'As of the last read: nothing' : 'Nothing'} needs attention.
      </p>
    )
  const rows = summary.top.slice(0, SHOWN)
  const more = summary.problems - rows.length
  return (
    <div data-stale={stale ? 'true' : undefined}>
      <ul className={styles.list}>
        {rows.map((row) => (
          <li key={row.id} className={styles.item}>
            <span className={`status-chip ${row.shown}`}>
              {WORD[row.shown]}
            </span>
            <span className={styles.main}>
              <span className={styles.title}>{row.what}</span>
              <span className={styles.detail}>
                {machineLabel(row.machine)} ·{' '}
                {withSessionNames(reason(row) || row.meaning, names)}
              </span>
            </span>
          </li>
        ))}
      </ul>
      {more > 0 && <OpenLink href="/status">{more} more in Status</OpenLink>}
    </div>
  )
}
