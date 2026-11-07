'use client'

import { useLiveSessions } from '@/lib/frame/live'
import {
  agoAt,
  type HistorySession,
  STANDING_CHIP,
  STANDING_TEXT,
  sessionHref,
  shortFolder,
  standing,
  toolName,
} from '@/lib/history'
import { useClock } from '@/lib/hooks/use-clock'
import { useHistory } from '@/lib/hooks/use-history'
import styles from './Glance.module.css'
import type { GlanceHead } from './glance-types'
import { OpenLink } from './OpenLink'

/** How many sessions the glance lists. */
const SHOWN = 4

const nameOf = (session: HistorySession) =>
  session.project ?? (shortFolder(session.cwd) || 'Session')

/** The last few sessions, test runs left out. */
function useRecent() {
  const history = useHistory('')
  const items = history.items
    ? history.items.filter((session) => !session.test).slice(0, SHOWN)
    : null
  return { history, items }
}

/** Recent for the Panel's heading: the newest two by name and age, or why there are none. */
export function useRecentGlance(): GlanceHead {
  const now = useClock(30_000)
  const { history, items } = useRecent()
  if (!items)
    return {
      count: null,
      line: history.loading
        ? 'Loading recent sessions…'
        : 'Recent sessions couldn’t be read.',
    }
  if (items.length === 0) return { count: null, line: 'No sessions yet.' }
  const lead = items
    .slice(0, 2)
    .map((session) => `${nameOf(session)} ${agoAt(session.endedAt, now)}`)
  const rest = items.length - lead.length
  return {
    count: null,
    line: [...lead, rest > 0 ? `${rest} more` : ''].filter(Boolean).join(' · '),
  }
}

/** The last sessions: state chip, project, agent and how long ago. Each opens its transcript in place. */
export function GlanceRecent() {
  const now = useClock(30_000)
  const live = useLiveSessions()
  const { history, items } = useRecent()
  if (!items)
    return (
      <p className={styles.note} role={history.loading ? 'status' : 'alert'}>
        {history.loading
          ? 'Loading recent sessions…'
          : 'Recent sessions couldn’t be read.'}
      </p>
    )
  if (items.length === 0) return <p className={styles.note}>No sessions yet.</p>
  const liveOf = (session: HistorySession) =>
    [...live.bySession.values()].find(
      (item) => item.conversation === session.id,
    )
  return (
    <ul className={styles.list} data-stale={history.stale ? 'true' : undefined}>
      {items.map((session) => {
        const state = standing(session, now, liveOf(session))
        return (
          <li key={session.id} className={styles.item}>
            <span className={`status-chip ${STANDING_CHIP[state]}`}>
              {STANDING_TEXT[state]}
            </span>
            <span className={styles.main}>
              <OpenLink href={sessionHref(session.id)} bare>
                <span className={styles.title}>{nameOf(session)}</span>
              </OpenLink>
              <span className={styles.detail}>
                {toolName(session.tool)} · {agoAt(session.endedAt, now)}
              </span>
            </span>
          </li>
        )
      })}
    </ul>
  )
}
