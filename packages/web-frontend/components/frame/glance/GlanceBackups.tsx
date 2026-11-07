'use client'

import {
  ageByTarget,
  spanText,
  type TargetAge,
  targetLabel,
} from '@/lib/backups'
import { useBackups } from '@/lib/hooks/use-backups'
import { useClock } from '@/lib/hooks/use-clock'
import styles from './Glance.module.css'
import type { GlanceHead } from './glance-types'

const late = (age: TargetAge) => age.ageMs > age.limitMs
const ageText = (age: TargetAge) =>
  `${spanText(age.ageMs)} old, late after ${spanText(age.limitMs)}`

/** "Drive 38 h old, late after 36 h · 3 more fine": the most overdue destination, then how the rest stand. */
function backupsLine(ages: readonly TargetAge[]): string {
  const [first] = ages
  if (!first) return ''
  const lateOnes = ages.filter(late)
  if (lateOnes.length === 0)
    return `All ${ages.length} ${ages.length === 1 ? 'destination' : 'destinations'} current`
  const moreLate = lateOnes.length - 1
  const fine = ages.length - lateOnes.length
  return [
    `${targetLabel(first.target)} ${ageText(first)}`,
    moreLate ? `${moreLate} more late` : '',
    fine ? `${fine} ${moreLate ? '' : 'more '}fine` : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

/** Backups for the Panel's heading: the oldest copy against its limit, or why there is none to show. */
export function useBackupsGlance(): GlanceHead {
  const { entries, loading } = useBackups()
  const now = useClock(60_000)
  if (!entries)
    return {
      count: null,
      line: loading ? 'Checking backups…' : 'Backups couldn’t be read.',
    }
  const ages = ageByTarget(entries, now)
  return {
    count: null,
    line: ages.length ? backupsLine(ages) : 'No copy has an age to show yet.',
  }
}

/** Per destination, how old its oldest copy is against its own limit; ember only when it is late. */
export function GlanceBackups() {
  const { entries, loading, stale } = useBackups()
  const now = useClock(60_000)
  if (!entries)
    return (
      <p className={styles.note} role={loading ? 'status' : 'alert'}>
        {loading ? 'Checking backups…' : 'Backups couldn’t be read.'}
      </p>
    )
  const ages = ageByTarget(entries, now)
  if (ages.length === 0)
    return (
      <p className={styles.note}>
        {entries.length === 0
          ? 'No backups are registered yet.'
          : 'No copy has an age to show yet.'}
      </p>
    )
  return (
    <ul className={styles.ages} data-stale={stale ? 'true' : undefined}>
      {ages.map((age) => (
        <li key={age.target} data-late={late(age) ? 'true' : undefined}>
          <span className={styles.agesName} title={`Oldest: ${age.name}`}>
            {targetLabel(age.target)}
          </span>
          <span
            className={styles.agesTrack}
            role="img"
            aria-label={`${targetLabel(age.target)}: ${ageText(age)}`}
          >
            <span
              style={{
                width: `${Math.min(100, Math.max(2, (age.ageMs / age.limitMs) * 100))}%`,
              }}
            />
          </span>
          <span className={styles.agesText}>{ageText(age)}</span>
        </li>
      ))}
    </ul>
  )
}
