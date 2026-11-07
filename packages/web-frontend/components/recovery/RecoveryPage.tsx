'use client'

import Link from 'next/link'
import { useClock } from '@/lib/hooks/use-clock'
import { useRecovery } from '@/lib/hooks/use-recovery'
import { useStatus } from '@/lib/hooks/use-status'
import { useStatusSessions } from '@/lib/hooks/use-status-sessions'
import {
  lead,
  memoryLoss,
  OUTCOME_CHIP,
  OUTCOME_WORD,
  type RecoveryItem,
  resumeButton,
  resumeResult,
  tries,
} from '@/lib/recovery'
import { at, withSessionNames } from '@/lib/status'
import styles from './RecoveryPage.module.css'

function Row({
  item,
  now,
  windowHours,
}: {
  item: RecoveryItem
  now: number
  windowHours: number
}) {
  const where = [item.agent, item.machine, item.project]
    .filter(Boolean)
    .join(' · ')
  const left = tries(item, windowHours)
  return (
    <li className={styles.row} data-outcome={item.outcome}>
      <div className={styles.who}>
        <strong className={styles.name}>{item.name}</strong>
        <span className={styles.where}>{where}</span>
      </div>
      <div className={styles.what}>
        <span>
          {item.what} ·{' '}
          <time dateTime={new Date(item.at).toISOString()}>
            {item.cause === 'restart'
              ? 'around '
              : item.atApprox
                ? 'about '
                : ''}
            {at(item.at, now)}
          </time>
        </span>
        <span className={styles.note}>
          {item.note}
          {item.outcome === 'resumed' && item.resumedAt !== null
            ? ` Back at ${at(item.resumedAt, now)}.`
            : ''}
        </span>
        {left && <span className={styles.note}>{left}</span>}
      </div>
      <div className={styles.end}>
        <span className={`status-chip ${OUTCOME_CHIP[item.outcome]}`}>
          {OUTCOME_WORD[item.outcome]}
        </span>
        {item.canOpen && item.outcome === 'resumed' && (
          <Link
            className={`lantern-btn small ${styles.open}`}
            href={`/?session=${encodeURIComponent(item.id)}`}
            aria-label={`Open ${item.name}`}
          >
            Open
          </Link>
        )}
      </div>
    </li>
  )
}

/** Recovery: what stopped on its own, what came back, and one Resume for what is waiting on you. */
export function RecoveryPage() {
  const now = useClock(30_000)
  const { view, loading, failed, stale, readAt, refetch, refreshing, resume } =
    useRecovery()
  const button = view ? resumeButton(view) : null
  const status = useStatus()
  const sessions = useStatusSessions()
  const lost = status.view ? memoryLoss(status.view.rows) : undefined
  const answer = resume.data ? resumeResult(resume.data) : null

  return (
    <main className={styles.page} data-testid="recovery-page">
      <header className={styles.head}>
        <h1>Recovery</h1>
        <button
          className="lantern-btn ghost small"
          type="button"
          disabled={refreshing}
          onClick={() => void refetch()}
        >
          {refreshing ? 'Checking…' : 'Check again'}
        </button>
      </header>

      {loading && <p role="status">Checking for stopped sessions…</p>}

      {failed && (
        <div role="alert" className={styles.notice}>
          <p>
            Couldn’t check on stopped sessions, so this can’t say if any need
            you.
          </p>
          <button
            className="lantern-btn small"
            type="button"
            onClick={() => void refetch()}
          >
            Try again
          </button>
        </div>
      )}

      {view && button && (
        <>
          <section className={styles.lead} aria-label="State">
            {lead(view, now).map((line) => (
              <p key={line} className={styles.state}>
                {line}
              </p>
            ))}
            <p className={styles.checked}>
              Last checked {at(readAt ?? view.checkedAt, now)}
              {stale
                ? '. The latest check failed, so this may be out of date.'
                : ''}
            </p>
            {lost && (
              <p role="status" className={styles.notice}>
                Status reports lost work this page can’t list, because no
                session stopped:{' '}
                {withSessionNames(lost.meaning, sessions.names)}{' '}
                <Link href="/status">Open Status</Link>
              </p>
            )}
            {view.partial && (
              <p role="status" className={styles.notice}>
                {view.partial} Sessions stopped by a restart may be missing
                here.
              </p>
            )}
          </section>

          <div className={styles.action}>
            <button
              className="lantern-btn primary"
              type="button"
              disabled={!!button.off || resume.isPending}
              aria-describedby={button.off ? 'resume-why' : undefined}
              onClick={() => resume.mutate()}
            >
              {resume.isPending ? 'Resuming…' : button.label}
            </button>
            {button.off && (
              <span id="resume-why" className={styles.why}>
                {button.off}
              </span>
            )}
          </div>

          {resume.isError && (
            <p role="alert" className={styles.notice}>
              Couldn’t resume: {(resume.error as Error).message}
            </p>
          )}
          {answer && (
            <p
              role={answer.failed ? 'alert' : 'status'}
              className={styles.notice}
            >
              {answer.text}
            </p>
          )}

          {view.items.length > 0 && (
            <ul className={styles.rows} aria-label="Stopped sessions">
              {view.items.map((item) => (
                <Row
                  key={item.id}
                  item={item}
                  now={now}
                  windowHours={view.windowHours}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </main>
  )
}
