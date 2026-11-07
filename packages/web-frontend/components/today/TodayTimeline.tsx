'use client'

import Link from 'next/link'
import { useMemo } from 'react'
import { useLiveSessions } from '@/lib/frame/live'
import {
  clock,
  countOf,
  type HistorySession,
  sessionHref,
  shortFolder,
  standing,
  toolName,
} from '@/lib/history'
import { openAsks, useOwnerAsks } from '@/lib/hooks/use-asks'
import { useClock } from '@/lib/hooks/use-clock'
import { useHistory } from '@/lib/hooks/use-history'
import { useSessionLabels } from '@/lib/hooks/use-session-labels'
import styles from './TodayTimeline.module.css'

const DAY_MS = 86_400_000
const HOURS = [0, 6, 12, 18]

const hourText = (hour: number) =>
  hour === 0
    ? '12 AM'
    : hour === 12
      ? '12 PM'
      : hour < 12
        ? `${hour} AM`
        : `${hour - 12} PM`

function startOfDay(ms: number): number {
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** One session's day as a bar on a 24-hour line; questions and failures marked. */
export function TodayTimeline() {
  const now = useClock(60_000)
  const history = useHistory('')
  const live = useLiveSessions()
  const labelOf = useSessionLabels()
  const { asks } = useOwnerAsks()
  const day = startOfDay(now)
  const pct = (ms: number) =>
    `${Math.min(100, Math.max(0, ((ms - day) / DAY_MS) * 100))}%`

  const rows = useMemo(() => {
    const today = (history.items ?? []).filter(
      (session) =>
        !session.test && (session.endedAt ?? session.startedAt ?? 0) >= day,
    )
    // Oldest first, as the day reads.
    return [...today].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
  }, [history.items, day])
  const questions = openAsks(asks).filter((ask) => ask.createdAt >= day)

  const liveOf = (session: HistorySession) =>
    [...live.bySession.values()].find(
      (item) => item.conversation === session.id,
    )

  if (history.loading) return <p className={styles.note}>Loading today…</p>
  if (history.failed)
    return (
      <p className={styles.note} role="alert">
        Couldn’t read today’s sessions.{' '}
        <button
          type="button"
          className={styles.link}
          onClick={() => void history.refetch()}
        >
          Try again
        </button>
      </p>
    )
  if (rows.length === 0 && questions.length === 0)
    return <p className={styles.note}>No agent work yet today.</p>

  return (
    <div
      className={styles.chart}
      data-stale={history.stale ? 'true' : undefined}
    >
      <div className={styles.axis} aria-hidden="true">
        {HOURS.map((hour) => (
          <span key={hour} style={{ left: `${(hour / 24) * 100}%` }}>
            {hourText(hour)}
          </span>
        ))}
      </div>
      <ul className={styles.rows} aria-label="Sessions today">
        {rows.map((session) => {
          const here = liveOf(session)
          const state = standing(session, now, here)
          const start = session.startedAt ?? session.endedAt ?? day
          const end = here ? now : (session.endedAt ?? start)
          const left = Math.max(start, day)
          const label = labelOf(session)
          return (
            <li key={session.id}>
              <Link
                href={sessionHref(session.id)}
                className={styles.row}
                title={`${label} · ${session.project ?? (shortFolder(session.cwd) || 'Unknown project')} · ${toolName(session.tool)} · ${clock(session.startedAt)} to ${here ? 'now' : clock(session.endedAt)}`}
              >
                <span className={styles.label}>{label}</span>
                <span className={styles.track}>
                  <span
                    className={styles.bar}
                    data-state={state}
                    style={{
                      left: pct(left),
                      width: `max(4px, calc(${pct(end)} - ${pct(left)}))`,
                    }}
                  />
                </span>
              </Link>
            </li>
          )
        })}
        {questions.length > 0 && (
          <li className={styles.row}>
            <span className={styles.label}>Questions</span>
            <span className={styles.track}>
              {questions.map((ask) => (
                <span
                  key={ask.id}
                  className={styles.mark}
                  style={{ left: pct(ask.createdAt) }}
                  title={`${ask.question} · asked ${clock(ask.createdAt)}`}
                />
              ))}
            </span>
          </li>
        )}
      </ul>
      <p className={styles.legend}>
        {countOf(rows.length, 'session')} today
        {questions.length > 0 &&
          ` · ${countOf(questions.length, 'question')} waiting`}
        {' · '}
        <span className={styles.key} data-state="failed" /> failed
      </p>
    </div>
  )
}
