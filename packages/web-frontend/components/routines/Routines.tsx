'use client'

import {
  ChevronDown,
  ChevronRight,
  Clock,
  Pause,
  Play,
  RefreshCw,
} from 'lucide-react'
import { useState } from 'react'
import {
  type RoutineAction,
  readRoutineLog,
  useRoutineAction,
  useRoutines,
} from '@/lib/hooks/use-routines'
import { machineLabel } from '@/lib/machine-name'
import {
  chipOf,
  clockSkip,
  groupRoutines,
  headOf,
  hostsText,
  type Routine,
  type RoutineGroup,
  scheduleText,
  soonIn,
  timerDelay,
  whenIn,
} from '@/lib/routines'
import { plural } from '@/lib/status'
import styles from './Routines.module.css'

/** A machine with this many routines and nothing to look at starts folded. */
const FOLD_FROM = 10

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

const OUT_OF_REACH = 'The machine that holds it can’t be reached from here.'

/** The row's one line after its name: what it is doing, or when it runs next (always the next run;
 * the chip is how the last one went). `next` marks a time, which wears the clock icon. */
function whenLine(
  routine: Routine,
  now = Date.now(),
): { text: string; next: boolean } {
  if (routine.machineOff) return { text: '', next: false }
  if (routine.unreadable) return { text: 'state not known', next: false }
  if (routine.running) return { text: 'running now', next: false }
  if (routine.paused) return { text: 'paused', next: false }
  if (!routine.started)
    return { text: 'waiting for the scheduler', next: false }
  if (routine.nextRun === null) return { text: '', next: false }
  if (routine.nextRun <= now) return { text: 'due now', next: true }
  return { text: soonIn(routine, routine.nextRun, now), next: true }
}

/** The time's tooltip: next and last run in full. */
function whenTip(routine: Routine): string {
  const next =
    routine.nextRun === null
      ? 'No next run scheduled.'
      : `Next run ${whenIn(routine, routine.nextRun)}.`
  const last =
    routine.lastRun === null
      ? 'Not run yet.'
      : `Last run ${whenIn(routine, routine.lastRun)}${routine.lastMachine ? ` on ${machineLabel(routine.lastMachine)}` : ''}.`
  return `${next} ${last}`
}

/** "Daily at 03:30 UTC · next Nov 8, 3:30 AM UTC": the schedule and the next run in one zone. */
function scheduleLine(routine: Routine): string {
  const schedule = scheduleText(routine)
  // While it runs, nextRun is the start of this run, not the next one.
  if (
    !routine.started ||
    routine.paused ||
    routine.running ||
    routine.nextRun === null
  )
    return schedule
  const delay = timerDelay(routine)
  const notes = [
    clockSkip(routine),
    delay ? `${delay} min random delay` : null,
  ].filter(Boolean)
  const why = notes.length ? ` (${notes.join(', ')})` : ''
  return `${schedule} · next ${whenIn(routine, routine.nextRun)}${why}`
}

/** What the last run said, or why there is nothing to say. */
function lastLine(routine: Routine): string {
  if (routine.machineOff)
    return `${machineLabel(routine.home)} is off. This runs again when it’s back.`
  if (routine.unreadable)
    return `Couldn’t read it from ${machineLabel(routine.home)}: ${routine.unreadable}`
  if (routine.lastRun === null)
    return routine.started
      ? 'Not run yet.'
      : 'Registered. The scheduler picks it up within seconds.'
  const where = routine.lastMachine
    ? ` on ${machineLabel(routine.lastMachine)}`
    : ''
  return `Last run ${whenIn(routine, routine.lastRun)}${where}: ${routine.lastMeaning || 'Finished.'}`
}

const SOURCE_WORDS: Record<Routine['source'], string> = {
  'built-in': 'Built in',
  registered: 'Registered',
  systemd: 'Systemd timer, read only',
}

function Row({ routine }: { routine: Routine }) {
  const [open, setOpen] = useState(
    routine.lastState === 'failed' && !routine.paused,
  )
  const { act, pending, error, failedFor, done } = useRoutineAction()
  const [log, setLog] = useState<{ text: string; bad: boolean } | null>(null)
  const [reading, setReading] = useState(false)
  const { chip, word } = chipOf(routine)
  const when = whenLine(routine)
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
      const text = result.lines.join('\n').trim()
      setLog({
        text:
          text ||
          (result.ok
            ? 'Its last run printed nothing.'
            : 'Nothing saved from its last run yet.'),
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
          <span className={styles.name} title={routine.what}>
            {routine.what}
          </span>
          <span className={styles.when} title={whenTip(routine)}>
            {when.next && (
              <Clock
                className="h-3 w-3"
                strokeWidth={1.7}
                aria-label="Next run"
              />
            )}
            <span className={styles.whenText}>{when.text}</span>
          </span>
          <Chevron
            className={`${styles.chevron} h-3.5 w-3.5`}
            strokeWidth={1.7}
            aria-hidden="true"
          />
        </span>
      </button>
      {open && (
        <div className={styles.detail}>
          <p className={styles.meaning}>{lastLine(routine)}</p>
          <p className={styles.line}>{scheduleLine(routine)}</p>
          <p className={styles.line}>
            <span className={styles.tag} title="The project that owns it">
              {routine.project}
            </span>{' '}
            {SOURCE_WORDS[routine.source]} · runs on {hostsText(routine)}
          </p>
          {routine.source === 'systemd' ? (
            <p className={styles.cmd}>{routine.command?.join(' ')}</p>
          ) : (
            routine.command && (
              <p className={styles.cmd}>{routine.command.join(' ')}</p>
            )
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
              disabled={busy || routine.running || !!routine.unreadable}
              title={
                routine.unreadable
                  ? OUT_OF_REACH
                  : routine.running
                    ? 'It’s running now. It can run again when it finishes.'
                    : undefined
              }
              onClick={() => act(routine.kind, 'run')}
            >
              <Play
                className="h-3.5 w-3.5"
                strokeWidth={1.7}
                aria-hidden="true"
              />
              {mine('run')
                ? 'Starting…'
                : routine.running
                  ? 'Running…'
                  : 'Run now'}
            </button>
            <button
              type="button"
              className="lantern-btn small"
              disabled={busy || !!routine.unreadable}
              title={routine.unreadable ? OUT_OF_REACH : undefined}
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

/** One machine's routines: a head with the count and what needs a look, then one line per routine,
 * failed ones first. A machine with nothing to look at and many routines starts folded. */
function Group({ group }: { group: RoutineGroup }) {
  const [open, setOpen] = useState(
    group.attention || group.routines.length < FOLD_FROM,
  )
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <section className={styles.group}>
      <button
        type="button"
        className={styles.groupHead}
        aria-expanded={open}
        onClick={() => setOpen((now) => !now)}
      >
        <Chevron className="h-3.5 w-3.5" strokeWidth={1.7} aria-hidden="true" />
        <span className={styles.host}>{machineLabel(group.host)}</span>
        <span className={styles.count}>
          {plural(group.routines.length, 'routine')}
        </span>
        {group.failed > 0 && (
          <span className="status-chip failed">{group.failed} failed</span>
        )}
        {group.unknown > 0 && (
          <span className="status-chip unknown">{group.unknown} not known</span>
        )}
        {group.off > 0 && (
          <span
            className="status-chip off"
            title={`${machineLabel(group.host)} is off. These run again when it’s back.`}
          >
            Off
          </span>
        )}
      </button>
      {open && (
        <ul
          className={styles.list}
          aria-label={`Routines on ${machineLabel(group.host)}`}
        >
          {group.routines.map((routine) => (
            <Row key={routine.kind} routine={routine} />
          ))}
        </ul>
      )}
    </section>
  )
}

/** Every scheduled routine, grouped by the machine it runs on, failed ones first: schedule and next run, the last result in a chip
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
        <div className={styles.groups}>
          {groupRoutines(routines).map((group) => (
            <Group key={group.host} group={group} />
          ))}
        </div>
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
