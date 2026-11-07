'use client'

import { useClock } from '@/lib/hooks/use-clock'
import { useHistory } from '@/lib/hooks/use-history'
import { plural } from '@/lib/status'
import { OpenLink } from './glance/OpenLink'
import styles from './TodayRow.module.css'

function startOfDay(ms: number): number {
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** Today as one line under the Panel's sections: how many sessions ran, and the way to the day's timeline. */
export function TodayRow() {
  const now = useClock(60_000)
  const history = useHistory('')
  const day = startOfDay(now)
  const count = history.items
    ? history.items.filter(
        (session) =>
          !session.test && (session.endedAt ?? session.startedAt ?? 0) >= day,
      ).length
    : null
  const text =
    count !== null
      ? `Today: ${plural(count, 'session')}`
      : history.loading
        ? 'Today: loading…'
        : 'Today couldn’t be read.'
  return (
    <p className={styles.row} data-stale={history.stale ? 'true' : undefined}>
      <span>{text}</span>
      <span aria-hidden="true">·</span>
      <OpenLink href="/today" label="See the day">
        See the day
      </OpenLink>
    </p>
  )
}
