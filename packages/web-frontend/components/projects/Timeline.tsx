'use client'

import { useEffect, useRef, useState } from 'react'
import { useProjectTimeline } from '@/lib/hooks/use-projects'
import {
  blockedReason,
  clip,
  dayLabel,
  type ProjectDetail,
  type RoadmapItem,
} from '@/lib/projects'
import styles from './ProjectsPage.module.css'

/** Items with a key of their text, counted when two lines read the same. */
function keyed(items: RoadmapItem[]): [string, RoadmapItem][] {
  const seen = new Map<string, number>()
  return items.map((item) => {
    const n = (seen.get(item.text) ?? 0) + 1
    seen.set(item.text, n)
    return [`${item.text}#${n}`, item]
  })
}

function PlanLink({ path }: { path: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      title={copied ? `Copied ${path}` : `Copy the plan’s path: ${path}`}
      onClick={() => {
        void navigator.clipboard?.writeText(path).then(
          () => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          },
          () => undefined,
        )
      }}
    >
      {copied ? 'copied' : 'plan'}
    </button>
  )
}

function RoadmapLine({
  item,
  lane,
}: {
  item: RoadmapItem
  lane: 'now' | 'next' | 'later'
}) {
  const blocked = !!item.blocked
  return (
    <li
      className={`${styles[lane]} ${blocked ? styles.blocked : ''}`}
      title={blocked ? blockedReason(item) : undefined}
    >
      <span className={styles.dot} aria-hidden="true" />
      <span className={styles.tx}>{item.text}</span>
      <span className={styles.meta}>
        {item.session && (
          <a href={`/?session=${encodeURIComponent(item.session)}`}>session</a>
        )}
        {item.plan && <PlanLink path={item.plan} />}
      </span>
    </li>
  )
}

/** Now, Next and Later from the roadmap, then the git days, newest first, earlier ones as the reader reaches them. */
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

  const noRoadmap =
    project.now.length + project.next.length + project.later.length === 0
  const days = timeline.data?.pages.flatMap((page) => page.days) ?? []
  const oldest = days.at(-1)?.date

  return (
    <>
      {noRoadmap && <p className={styles.empty}>No roadmap yet.</p>}
      <ul className={styles.tl} aria-label="Timeline">
        {keyed(project.now).map(([key, item]) => (
          <RoadmapLine key={`now-${key}`} item={item} lane="now" />
        ))}
        {keyed(project.next).map(([key, item]) => (
          <RoadmapLine key={`next-${key}`} item={item} lane="next" />
        ))}
        {keyed(project.later).map(([key, item]) => (
          <RoadmapLine key={`later-${key}`} item={item} lane="later" />
        ))}
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
            {days.length === 0
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
