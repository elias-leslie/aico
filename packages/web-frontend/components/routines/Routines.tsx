'use client'

import { ChevronDown, ChevronRight, Pause, Play, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import {
  type RoutineAction,
  readRoutineLog,
  useRoutineAction,
  useRoutines,
} from '@/lib/hooks/use-routines'
import {
  chipOf,
  headOf,
  type Routine,
  scheduleText,
  sortRoutines,
} from '@/lib/routines'
import { shortWhen } from '@/lib/short-when'
import styles from './Routines.module.css'

/** The collapsed row's value beside "Routines": "12 routines · 1 failed"; why, when it is not known. */
export function useRoutinesHead(): {
  value: string | null
  tone: 'ok' | 'warn' | 'failed' | 'unknown' | null
} {
  const { routines, loading, failed } = useRoutines()
  if (loading) return { value: 'Checking…', tone: null }
  if (failed || !routines) return { value: 'Couldn’t read', tone: 'unknown' }
  if (routines.length === 0) return { value: 'None yet', tone: null }
  return headOf(routines)
}

function Note({
  children,
  retry,
  bad = false,
}: {
  children: string
  retry?: () => void
  bad?: boolean
}) {
  return (
    <div
      className={styles.note}
      data-bad={bad ? 'true' : undefined}
      role={bad ? 'alert' : 'status'}
    >
      <p>{children}</p>
      {retry && (
        <button type="button" className="lantern-btn small" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  )
}

/** When it runs, and what it is doing or has to say about next. */
function whenLine(routine: Routine): string {
  const schedule = scheduleText(routine)
  if (routine.unreadable) return `${schedule} · state not known`
  if (routine.running) return `${schedule} · running now`
  if (routine.paused) return `${schedule} · paused`
  if (!routine.started) return `${schedule} · waiting for the scheduler`
  return routine.nextRun === null
    ? schedule
    : `${schedule} · next ${shortWhen(routine.nextRun)}`
}

/** What the last run said, or why there is nothing to say. */
function lastLine(routine: Routine): string {
  if (routine.unreadable)
    return `Couldn’t read it from ${routine.home}: ${routine.unreadable}`
  if (routine.lastRun === null)
    return routine.started
      ? 'Not run yet.'
      : 'Registered. The scheduler picks it up within seconds.'
  const where = routine.lastMachine ? ` on ${routine.lastMachine}` : ''
  return `Last run ${shortWhen(routine.lastRun)}${where}: ${routine.lastMeaning || 'Finished.'}`
}

function Row({ routine }: { routine: Routine }) {
  const [open, setOpen] = useState(
    routine.lastState === 'failed' && !routine.paused,
  )
  const { act, pending, error, failedFor, done } = useRoutineAction()
  const [log, setLog] = useState<{ text: string; bad: boolean } | null>(null)
  const [reading, setReading] = useState(false)
  const { chip, word } = chipOf(routine)
  const Chevron = open ? ChevronDown : ChevronRight
  const mine = (action: RoutineAction) =>
    pending?.kind === routine.kind && pending.action === action
  const busy = pending?.kind === routine.kind
  const asked =
    done?.kind === routine.kind && done.action === 'run'
      ? 'Asked it to run. It starts within a few seconds.'
      : ''

  async function showLog() {
    setReading(true)
    try {
      const result = await readRoutineLog(routine.kind)
      setLog({
        text: result.lines.length
          ? result.lines.join('\n')
          : 'Nothing saved from its last run yet.',
        bad: !result.ok,
      })
    } catch (failure) {
      setLog({ text: (failure as Error).message, bad: true })
    } finally {
      setReading(false)
    }
  }

  return (
    <li className={styles.row} data-testid={`routine-${routine.kind}`}>
      <button
        type="button"
        className={styles.head}
        aria-expanded={open}
        onClick={() => setOpen((now) => !now)}
      >
        <span className={styles.top}>
          <span className={`status-chip ${chip}`}>{word}</span>
          <span className={styles.name}>{routine.what}</span>
          <Chevron
            className={`${styles.chevron} h-3.5 w-3.5`}
            strokeWidth={1.7}
            aria-hidden="true"
          />
        </span>
        <span className={styles.line}>{whenLine(routine)}</span>
      </button>
      {open && (
        <div className={styles.detail}>
          <p className={styles.meaning}>{lastLine(routine)}</p>
          <p className={styles.line}>
            <span className={styles.tag} title="The project that owns it">
              {routine.project}
            </span>{' '}
            {routine.source === 'registered' ? 'Registered' : 'Built in'} · runs
            on {routine.home}
          </p>
          {routine.command && (
            <p className={styles.cmd}>{routine.command.join(' ')}</p>
          )}
          {routine.post && <p className={styles.cmd}>POST {routine.post}</p>}
          {log && (
            <pre
              className={styles.log}
              role={log.bad ? 'alert' : undefined}
              aria-label={`Last output of ${routine.what}`}
            >
              {log.text}
            </pre>
          )}
          {asked && <p className={styles.line}>{asked}</p>}
          {error && pending === null && failedFor?.kind === routine.kind && (
            <p role="alert" className={styles.err}>
              {error}
            </p>
          )}
          <div className={styles.controls}>
            <button
              type="button"
              className="lantern-btn small"
              disabled={busy || routine.running}
              onClick={() => act(routine.kind, 'run')}
            >
              <Play
                className="h-3.5 w-3.5"
                strokeWidth={1.7}
                aria-hidden="true"
              />
              {mine('run') ? 'Starting…' : 'Run now'}
            </button>
            <button
              type="button"
              className="lantern-btn small"
              disabled={busy}
              onClick={() =>
                act(routine.kind, routine.paused ? 'resume' : 'pause')
              }
            >
              <Pause
                className="h-3.5 w-3.5"
                strokeWidth={1.7}
                aria-hidden="true"
              />
              {routine.paused
                ? mine('resume')
                  ? 'Resuming…'
                  : 'Resume'
                : mine('pause')
                  ? 'Pausing…'
                  : 'Pause'}
            </button>
            <button
              type="button"
              className="lantern-btn small ghost"
              disabled={reading}
              onClick={showLog}
            >
              {reading ? 'Reading…' : 'Show log'}
            </button>
          </div>
        </div>
      )}
    </li>
  )
}

/** Every scheduled routine, failed ones first: schedule and next run, the last result in a chip
 * with detail when a row opens, Run now, Pause or Resume, and the last output. Built-in jobs and
 * the ones projects register (aico routines add) sit in this one list. */
export function RoutinesBody() {
  const { routines, loading, failed, stale, error, refetch, refreshing } =
    useRoutines()
  if (loading)
    return (
      <p className={styles.plain} role="status">
        Checking routines…
      </p>
    )
  if (failed || !routines)
    return (
      <Note bad retry={() => refetch()}>
        {`Couldn’t load routines. ${error || 'The Aico server didn’t answer'}, so nothing here counts as OK.`}
      </Note>
    )
  return (
    <div className={styles.wrap}>
      {stale && (
        <Note retry={() => refetch()}>
          Couldn’t refresh. Showing the last list that loaded.
        </Note>
      )}
      {routines.length === 0 ? (
        <p className={styles.plain}>
          No routines yet. A project adds its own with aico routines add.
        </p>
      ) : (
        <ul className={styles.list} aria-label="Routines">
          {sortRoutines(routines).map((routine) => (
            <Row key={routine.kind} routine={routine} />
          ))}
        </ul>
      )}
      <button
        type="button"
        className="lantern-btn small"
        disabled={refreshing}
        onClick={() => refetch()}
      >
        <RefreshCw
          className="h-3.5 w-3.5"
          strokeWidth={1.7}
          aria-hidden="true"
        />
        {refreshing ? 'Refreshing…' : 'Refresh'}
      </button>
    </div>
  )
}
