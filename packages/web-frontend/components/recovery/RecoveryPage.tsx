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
import {
  type Chip,
  Group,
  Notice,
  Quiet,
  Row,
  SectionHead,
} from '../settings/kit'
import styles from './RecoveryPage.module.css'

const CHIP = OUTCOME_CHIP as Record<RecoveryItem['outcome'], Chip>

/** A stopped session: its name and where it ran, and its outcome as a chip. Opens to what happened and, once it is back, Open. */
function Stopped({
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
    <Row
      name={item.name}
      meta={where || undefined}
      chip={CHIP[item.outcome]}
      chipText={OUTCOME_WORD[item.outcome]}
      defaultOpen={item.outcome !== 'resumed'}
    >
      <p>
        {item.what} ·{' '}
        <time dateTime={new Date(item.at).toISOString()}>
          {item.cause === 'restart' ? 'around ' : item.atApprox ? 'about ' : ''}
          {at(item.at, now)}
        </time>
      </p>
      <small>
        {item.note}
        {item.outcome === 'resumed' && item.resumedAt !== null
          ? ` Back at ${at(item.resumedAt, now)}.`
          : ''}
      </small>
      {left && <small>{left}</small>}
      {item.canOpen && item.outcome === 'resumed' && (
        <div>
          <Link
            className="lantern-btn small"
            href={`/?session=${encodeURIComponent(item.id)}`}
            aria-label={`Open ${item.name}`}
          >
            Open
          </Link>
        </div>
      )}
    </Row>
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
    <section aria-label="Recovery" data-testid="recovery-page">
      <SectionHead
        title="Recovery"
        sub="Sessions that stopped on their own, and what came back."
      >
        <button
          className="lantern-btn ghost small"
          type="button"
          disabled={refreshing}
          onClick={() => void refetch()}
        >
          {refreshing ? 'Checking…' : 'Check again'}
        </button>
      </SectionHead>

      {loading && <Quiet role="status">Checking for stopped sessions…</Quiet>}

      {failed && (
        <Notice
          failed
          actions={
            <button
              className="lantern-btn small"
              type="button"
              onClick={() => void refetch()}
            >
              Try again
            </button>
          }
        >
          Couldn’t check on stopped sessions, so this can’t say if any need you.
        </Notice>
      )}

      {view && button && (
        <>
          <div className={styles.lead} aria-label="State" role="group">
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
          </div>
          {lost && (
            <Notice>
              Status reports lost work this page can’t list, because no session
              stopped: {withSessionNames(lost.meaning, sessions.names)}{' '}
              <Link href="/status">Open Status</Link>
            </Notice>
          )}
          {view.partial && (
            <Notice>
              {view.partial} Sessions stopped by a restart may be missing here.
            </Notice>
          )}

          {/* Nothing stopped: no Resume to offer, so no off button beside "No stopped sessions". */}
          {(view.items.length > 0 || !button.off) && (
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
          )}

          {resume.isError && (
            <Notice failed>
              Couldn’t resume: {(resume.error as Error).message}
            </Notice>
          )}
          {answer && <Notice failed={answer.failed}>{answer.text}</Notice>}

          {view.items.length > 0 && (
            <Group
              title="Stopped sessions"
              count={view.items.length}
              label="Stopped sessions"
            >
              {view.items.map((item) => (
                <Stopped
                  key={item.id}
                  item={item}
                  now={now}
                  windowHours={view.windowHours}
                />
              ))}
            </Group>
          )}
        </>
      )}
    </section>
  )
}
