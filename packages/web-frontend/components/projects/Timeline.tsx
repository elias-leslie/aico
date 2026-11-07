'use client'

import { useEffect, useRef } from 'react'
import { useProjectTimeline } from '@/lib/hooks/use-projects'
import { clip, dayLabel, joinDays, type ProjectDetail } from '@/lib/projects'
import styles from './ProjectsPage.module.css'
import { Roadmap } from './Roadmap'

/** The roadmap, then the git days under "Done", newest first, earlier ones as the reader reaches them. */
export function Timeline({
  project,
  now,
}: {
  project: ProjectDetail
  now: number
}) {
  const timeline = useProjectTimeline(project.id)
  const sentinel = useRef<HTMLLIElement>(null)
  const {
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    fetchNextPage,
  } = timeline
  const idle = hasNextPage && !isFetchingNextPage && !isFetchNextPageError

  useEffect(() => {
    const target = sentinel.current
    if (!idle || !target || typeof IntersectionObserver === 'undefined') return
    const watcher = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void fetchNextPage()
    })
    watcher.observe(target)
    return () => watcher.disconnect()
  }, [idle, fetchNextPage])

  const days = joinDays(timeline.data?.pages ?? [])
  const oldest = days.at(-1)?.date

  return (
    <>
      <Roadmap project={project} />
      <h2 className={styles.laneHead}>
        Done
        <span className={styles.laneHint}>from the project’s git history</span>
      </h2>
      <ul className={styles.tl} aria-label="Done, newest first">
        {days.map((day) => (
          <DayBlock key={day.date} day={day} now={now} />
        ))}
        {timeline.isPending && (
          <li
            className={styles.more}
            role="status"
            aria-label="Loading history"
          >
            <span className={styles.spin} aria-hidden="true" />
            Loading history
          </li>
        )}
        {timeline.isError && !timeline.data && (
          <li className={`${styles.more} ${styles.problem}`}>
            Couldn’t load history
            <button
              type="button"
              className="lantern-btn small"
              onClick={() => void timeline.refetch()}
            >
              Retry
            </button>
          </li>
        )}
        {isFetchingNextPage && (
          <li className={styles.more} role="status">
            <span className={styles.spin} aria-hidden="true" />
            Loading earlier
          </li>
        )}
        {isFetchNextPageError && (
          <li className={`${styles.more} ${styles.problem}`}>
            Couldn’t load earlier changes
            <button
              type="button"
              className="lantern-btn small"
              onClick={() => void fetchNextPage()}
            >
              Retry
            </button>
          </li>
        )}
        {idle && (
          <li ref={sentinel} className={styles.more}>
            <button
              type="button"
              className="lantern-btn ghost small"
              onClick={() => void fetchNextPage()}
            >
              Load earlier
            </button>
          </li>
        )}
        {timeline.data && !hasNextPage && (
          <li className={styles.more}>
            {timeline.data.pages[0]?.available === false
              ? 'No git history for this project'
              : days.length === 0
                ? 'No commits yet'
                : `Start of history${oldest ? ` · ${dayLabel(oldest, now).replace(/^[A-Za-z]+ · /, '')}` : ''}`}
          </li>
        )}
      </ul>
    </>
  )
}

function DayBlock({
  day,
  now,
}: {
  day: {
    date: string
    commits: { sha: string; subject: string; release?: string }[]
  }
  now: number
}) {
  return (
    <>
      <li className={styles.dayLabel}>{dayLabel(day.date, now)}</li>
      {day.commits.map((commit) => (
        <li key={commit.sha} className={styles.done}>
          <span className={styles.dot} aria-hidden="true" />
          <span className={styles.tx} title={commit.subject}>
            {clip(commit.subject)}
          </span>
          <span className={styles.meta}>
            {commit.release && (
              <span
                className={styles.release}
                title={`Release ${commit.release}`}
              >
                {commit.release}
              </span>
            )}
          </span>
        </li>
      ))}
    </>
  )
}
