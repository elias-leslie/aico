'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import { useLiveSessions } from '@/lib/frame/live'
import { quotaGlances } from '@/lib/frame/quota'
import {
  agoAt,
  clock,
  type HistorySession,
  plainLine,
  STANDING_CHIP,
  STANDING_TEXT,
  sessionHref,
  shortFolder,
  standing,
  toolName,
} from '@/lib/history'
import { useClock } from '@/lib/hooks/use-clock'
import { useHistory, useHistoryEvents } from '@/lib/hooks/use-history'
import { useProjectOverview } from '@/lib/hooks/use-projects'
import { useStatus } from '@/lib/hooks/use-status'
import { useUsage } from '@/lib/hooks/use-usage'
import { machineLabel } from '@/lib/machine-name'
import { agentsText, problemText, splitProjects } from '@/lib/projects'
import {
  barHeights,
  compact,
  localDay,
  summarize,
  type UsageProvider,
  unitCaption,
} from '@/lib/quota-usage'
import {
  ACTION_LABEL,
  plural,
  reason,
  type StatusRow,
  summaryLine,
  WORD,
  withSessionNames,
} from '@/lib/status'
import { TodayTimeline } from '../today/TodayTimeline'
import { useFrame } from './FrameContext'
import { QuotaBar, useRowSessionAction } from './Panel'
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

/** One Status row in Wide: what it is, why, and the session button when it has one. */
function StatusItem({ row }: { row: StatusRow }) {
  const { session, note, act, title, names } = useRowSessionAction(row)
  return (
    <li>
      <span
        className="lantern-chip"
        data-tone={row.shown === 'failed' ? 'bad' : 'wait'}
      >
        {WORD[row.shown]}
      </span>
      <span className={styles.main}>
        <span className={styles.title}>{row.what}</span>
        <span className={styles.detail}>
          {machineLabel(row.machine)} ·{' '}
          {withSessionNames(reason(row) || row.meaning, names)}
        </span>
        {note && (
          <span className={styles.detail} role="alert">
            {note}
          </span>
        )}
      </span>
      {session && (
        <button
          type="button"
          className="lantern-btn small"
          title={title}
          onClick={act}
        >
          {ACTION_LABEL[session.kind]}
        </button>
      )}
    </li>
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
            <StatusItem key={row.id} row={row} />
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

function FinalLine({ id }: { id: string }) {
  const events = useHistoryEvents(id)
  const reply = [...(events.data?.items ?? [])]
    .reverse()
    .find((event) => event.role === 'assistant' && event.kind === 'text')
  if (!reply) return null
  return <span className={styles.final}>{plainLine(reply.text)}</span>
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
          {shown.map((session, index) => {
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
                  {index < 4 && <FinalLine id={session.id} />}
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </Section>
  )
}

/** Each provider's share left with its time-gone tick, then spend per day as small bars. */
function QuotaAndSpend() {
  const { report, loading, failed, stale } = useUsage()
  const glances = quotaGlances(report)
  if (loading) return <p className={styles.note}>Checking quota…</p>
  if (failed) return <p className={styles.note}>Quota couldn’t be read.</p>
  if (!report || glances.length === 0)
    return <p className={styles.note}>No quota reports yet.</p>
  const now = Date.now()
  const spenders = report.providers.filter((provider) => provider.spend.unit)
  return (
    <div data-stale={stale ? 'true' : undefined}>
      <ul className={styles.quotas}>
        {glances.map((glance) => (
          <QuotaBar key={glance.id} glance={glance} />
        ))}
      </ul>
      {spenders.length > 0 && (
        <div className={styles.spends}>
          {spenders.map((provider) => (
            <SpendStrip key={provider.id} provider={provider} now={now} />
          ))}
        </div>
      )}
    </div>
  )
}

function SpendStrip({
  provider,
  now,
}: {
  provider: UsageProvider
  now: number
}) {
  const { unit, days } = provider.spend
  if (!unit) return null
  const heights = barHeights(days, unit)
  const { total, recordedDays } = summarize(days, unit)
  const today = localDay(now)
  const slot = 12
  return (
    <figure className={styles.spend}>
      <figcaption>
        <b>{provider.name}</b> {unitCaption(unit).toLowerCase()}
        <span className={styles.sub}>
          {' '}
          · {recordedDays} days, {compact(total)} {unit}
        </span>
      </figcaption>
      <svg
        viewBox={`0 0 ${slot * days.length} 36`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${provider.name} ${unit} per day, ${days.length} days, ${compact(total)} in all`}
      >
        {days.map((day, i) => {
          const h = heights[i]
          if (h === null) return null
          const barH = Math.max(h * 34, 1)
          return (
            <rect
              key={day.day}
              className={day.day === today ? styles.today : styles.bar1}
              x={i * slot + 2}
              y={35 - barH}
              width={slot - 4}
              height={barH}
              rx={1.5}
            />
          )
        })}
      </svg>
    </figure>
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
        <QuotaAndSpend />
      </Section>
    </div>
  )
}
