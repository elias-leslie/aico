'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import { useLiveSessions } from '@/lib/frame/live'
import {
  agoAt,
  clock,
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
import { useProjectOverview } from '@/lib/hooks/use-projects'
import { useStatus } from '@/lib/hooks/use-status'
import { agentsText, problemText, splitProjects } from '@/lib/projects'
import { plural, reason, summaryLine, WORD } from '@/lib/status'
import { TodayTimeline } from '../today/TodayTimeline'
import { useFrame } from './FrameContext'
import styles from './WideOverview.module.css'

function Section({
  title,
  sub,
  href,
  where = 'wide',
  more,
  children,
}: {
  title: string
  sub?: string
  href: string
  where?: 'wide' | 'full'
  more: string
  children: ReactNode
}) {
  const frame = useFrame()
  return (
    <section className={styles.section} aria-label={title}>
      <div className={styles.head}>
        <h2>{title}</h2>
        {sub && <span className={styles.sub}>{sub}</span>}
        <Link
          href={href}
          className={styles.more}
          onClick={(event) => {
            if (!frame) return
            event.preventDefault()
            frame.open(href, where)
          }}
        >
          {more}
        </Link>
      </div>
      {children}
    </section>
  )
}

function StatusSection() {
  const { view, loading, failed, stale } = useStatus()
  const summary = view?.summary
  return (
    <Section
      title="Status"
      sub={summary ? summaryLine(summary) : undefined}
      href="/status"
      more="Open Status"
    >
      {loading ? (
        <p className={styles.note}>Checking Status…</p>
      ) : failed || !summary ? (
        <p className={styles.note}>Status couldn’t be read.</p>
      ) : summary.problems === 0 ? (
        <p className={styles.note}>
          {stale ? 'As of the last read: ' : ''}nothing needs attention.
        </p>
      ) : (
        <ul className={styles.list} data-stale={stale ? 'true' : undefined}>
          {summary.top.slice(0, 5).map((row) => (
            <li key={row.id}>
              <span
                className="lantern-chip"
                data-tone={row.shown === 'failed' ? 'bad' : 'wait'}
              >
                {WORD[row.shown]}
              </span>
              <span className={styles.main}>
                <span className={styles.title}>{row.what}</span>
                <span className={styles.detail}>
                  {row.machine} · {reason(row) || row.meaning}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

function ProjectsSection() {
  const query = useProjectOverview()
  const active = query.data ? splitProjects(query.data, '').active : null
  const shown = active?.slice(0, 5) ?? []
  return (
    <Section
      title="Projects"
      sub={active ? plural(active.length, 'active project') : undefined}
      href="/projects"
      more="Open Projects"
    >
      {query.isPending ? (
        <p className={styles.note}>Loading projects…</p>
      ) : !active ? (
        <p className={styles.note}>Projects couldn’t be read.</p>
      ) : shown.length === 0 ? (
        <p className={styles.note}>No active projects.</p>
      ) : (
        <ul
          className={styles.list}
          data-stale={query.isError ? 'true' : undefined}
        >
          {shown.map((project) => {
            const problem = project.problems[0]
            return (
              <li key={project.id}>
                <span className={styles.main}>
                  <span className={styles.title}>{project.name}</span>
                  <span className={styles.detail}>
                    {[
                      project.top ? `Now: ${project.top}` : null,
                      project.waiting ? '1 question waiting' : null,
                      project.agents ? agentsText(project.agents) : null,
                      problem
                        ? problemText(
                            problem.kind,
                            problem.count,
                            problem.worst,
                          )
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ') || 'Quiet'}
                  </span>
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </Section>
  )
}

function RecentSection() {
  const now = useClock(30_000)
  const history = useHistory('')
  const live = useLiveSessions()
  const liveOf = (session: HistorySession) =>
    [...live.bySession.values()].find(
      (item) => item.conversation === session.id,
    )
  const shown = (history.items ?? [])
    .filter((session) => !session.test)
    .slice(0, 6)
  return (
    <Section title="Recent" href="/history" more="Open Recent">
      {history.loading ? (
        <p className={styles.note}>Loading recent sessions…</p>
      ) : history.failed ? (
        <p className={styles.note}>Recent sessions couldn’t be read.</p>
      ) : shown.length === 0 ? (
        <p className={styles.note}>No sessions yet.</p>
      ) : (
        <ul
          className={styles.list}
          data-stale={history.stale ? 'true' : undefined}
        >
          {shown.map((session) => {
            const state = standing(session, now, liveOf(session))
            return (
              <li key={session.id}>
                <span className={`status-chip ${STANDING_CHIP[state]}`}>
                  {STANDING_TEXT[state]}
                </span>
                <Link href={sessionHref(session.id)} className={styles.main}>
                  <span className={styles.title}>
                    {session.project ?? (shortFolder(session.cwd) || 'Session')}
                  </span>
                  <span className={styles.detail}>
                    {toolName(session.tool)} · {agoAt(session.endedAt, now)}
                    {session.startedAt
                      ? ` · started ${clock(session.startedAt)}`
                      : ''}
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </Section>
  )
}

/** Wide's second column at home: Status ranked by consequence, Today,
 * Projects, Recent, then Quota and spend (its own page one click away). */
export function WideOverview() {
  return (
    <div className={styles.overview} data-testid="wide-overview">
      <StatusSection />
      <Section title="Today" href="/today" more="See the day">
        <TodayTimeline />
      </Section>
      <ProjectsSection />
      <RecentSection />
      <Section
        title="Quota and spend"
        href="/quota"
        more="Open Quota and spend"
      >
        <p className={styles.note}>
          Each subscription’s window, and credits spent by day.
        </p>
      </Section>
    </div>
  )
}
