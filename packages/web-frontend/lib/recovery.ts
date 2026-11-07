// The Recovery page's data and words. GET /api/recovery serves what stopped and what came back;
// the page counts and words it here so the lead line and the button say the same thing.

import { at, isProblem, type StatusRow } from '@/lib/status'

export type RecoveryOutcome = 'resumed' | 'waiting' | 'gave_up'

export interface RecoveryItem {
  id: string
  name: string
  agent: string
  project: string | null
  machine: string
  cause: 'crash' | 'restart'
  what: string
  at: number
  atApprox: boolean
  outcome: RecoveryOutcome
  resumedAt: number | null
  note: string
  attemptsLeft: number | null
  resumable: boolean
  canOpen: boolean
}

export interface RecoveryView {
  checkedAt: number
  partial: string | null
  restartAt: number | null
  maxAttempts: number
  windowHours: number
  resumable: number
  items: RecoveryItem[]
}

export interface ResumeAnswer {
  resumed: number
  results: { id: string; name: string; ok: boolean; reason: string | null }[]
}

export const OUTCOME_WORD: Record<RecoveryOutcome, string> = {
  resumed: 'Resumed',
  waiting: 'Waiting',
  gave_up: 'Gave up',
}

/** Chip classes (app/globals.css .status-chip): resumed is fine, waiting is under way, gave up is lost work. */
export const OUTCOME_CHIP: Record<RecoveryOutcome, string> = {
  resumed: 'ok',
  waiting: 'running',
  gave_up: 'failed',
}

const sessions = (n: number) => `${n} session${n === 1 ? '' : 's'}`

/** "2 came back", "all 3 came back", "1 is coming back by itself", "1 didn’t come back". */
function outcomes(items: RecoveryItem[]): string {
  const count = (outcome: RecoveryOutcome) =>
    items.filter((item) => item.outcome === outcome).length
  const back = count('resumed')
  const waiting = count('waiting')
  const gaveUp = count('gave_up')
  const parts: string[] = []
  if (back)
    parts.push(
      back === items.length && items.length > 1
        ? `all ${back} came back`
        : `${back} came back`,
    )
  if (waiting)
    parts.push(
      waiting === 1
        ? '1 is coming back by itself'
        : `${waiting} are coming back by themselves`,
    )
  if (gaveUp)
    parts.push(
      gaveUp === items.length && items.length > 1
        ? `none came back`
        : gaveUp === 1
          ? '1 didn’t come back'
          : `${gaveUp} didn’t come back`,
    )
  return parts.join(', ')
}

/**
 * The Status row for memory kills, when it reports a problem. Killed jobs and processes are lost
 * work even though no session stopped, so Recovery names them rather than saying all is well.
 */
export function memoryLoss(rows: readonly StatusRow[]): StatusRow | undefined {
  return rows.find(
    (row) => /(^|\/)check-memory$/.test(row.id) && isProblem(row.shown),
  )
}

/** The state, led first: "No stopped sessions to bring back." or what stopped and how it went. */
export function lead(view: RecoveryView, now: number): string[] {
  const restart = view.items.filter((item) => item.cause === 'restart')
  const crashed = view.items.filter((item) => item.cause === 'crash')
  if (!restart.length && !crashed.length)
    return ['No stopped sessions to bring back.']
  const lines: string[] = []
  if (restart.length)
    lines.push(
      `${sessions(restart.length)} stopped when the workstation restarted${
        view.restartAt === null ? '' : ` at ${at(view.restartAt, now)}`
      }; ${outcomes(restart)}.`,
    )
  if (crashed.length)
    lines.push(
      `${sessions(crashed.length)} stopped ${crashed.length === 1 ? 'on its own' : 'on their own'}; ${outcomes(crashed)}.`,
    )
  return lines
}

/** The Resume button's label, and why it is off when it is. */
export function resumeButton(view: RecoveryView): {
  label: string
  off: string | null
} {
  const n = view.resumable
  if (n > 0) return { label: `Resume ${sessions(n)}`, off: null }
  const waiting = view.items.some((item) => item.outcome === 'waiting')
  const gaveUp = view.items.some((item) => item.outcome === 'gave_up')
  return {
    label: 'Resume',
    off: gaveUp
      ? 'Nothing here can be resumed from Aico.'
      : waiting
        ? 'Nothing to resume: the waiting ones come back by themselves.'
        : 'Nothing has stopped.',
  }
}

/** Automatic tries left, for a session still being tried or one that gave up. */
export function tries(item: RecoveryItem, windowHours: number): string | null {
  if (item.outcome === 'resumed' || item.attemptsLeft === null) return null
  if (item.outcome === 'gave_up')
    return item.resumable
      ? 'No automatic tries left. Resume tries again now.'
      : 'No automatic tries left.'
  return item.attemptsLeft === 0
    ? `No more automatic tries in ${windowHours} hours.`
    : `${item.attemptsLeft} automatic ${item.attemptsLeft === 1 ? 'try' : 'tries'} left in ${windowHours} hours.`
}

/** What came of a Resume, in words: what started and which ones were refused. */
export function resumeResult(answer: ResumeAnswer): {
  text: string
  failed: boolean
} {
  const failures = answer.results.filter((result) => !result.ok)
  if (!failures.length)
    return {
      text: `Resuming ${sessions(answer.resumed)}. Each shows as resumed here once it’s back.`,
      failed: false,
    }
  const why = failures
    .map((result) => `${result.name}: ${result.reason ?? 'refused'}`)
    .join(' ')
  return {
    text: answer.resumed
      ? `Resuming ${sessions(answer.resumed)}. Couldn’t resume ${failures.length}. ${why}`
      : `Couldn’t resume. ${why}`,
    failed: true,
  }
}
