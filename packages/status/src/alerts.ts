// The phone alert rule (owner, 2026-11-03): one alert per batch when a row turns failed, or when a
// backup or machine row goes late. Warnings and unknowns change only the badge and the screen.
// A batch of only project-owned failures (a project's checks, publication, jobs, app rows) goes to
// the tray instead: its owning agent fixes it (statusNotice in web-server/src/status-actions.ts).
// Rows on a machine turned off on purpose show off, so they never alert.
//
// StatusStore.checkAlerts() compares each row's shown state with the last pass (kept in status.db,
// so a restart neither repeats nor loses a change) and hands one AlertBatch to the hook. One write
// (a POST of many rows) or one timer pass is one batch.

import { PROBLEMS, type Problem, type Shown, type ShownRow, type Summary } from './show'

export interface AlertChange {
  row: ShownRow
  /** The shown state at the last pass; null for a row not seen before. */
  from: Shown | null
  to: 'failed' | 'late'
}

export interface AlertBatch {
  generated_at: string
  changes: AlertChange[]
  /** The badge rollup at this pass, for the rest of the alert. */
  summary: Summary
}

/** Told of each batch that alerts. */
export type AlertHook = (batch: AlertBatch) => void

/** Whether a row in this shown state alerts. */
export function alerting(row: ShownRow): boolean {
  if (row.shown === 'failed') return true
  return row.shown === 'late' && (row.kind === 'backup' || row.kind === 'machine')
}

/** Rows that alert now and did not at the last pass (`seen`: id to shown state). */
export function transitions(
  seen: ReadonlyMap<string, Shown>,
  rows: readonly ShownRow[],
): AlertChange[] {
  const changes: AlertChange[] = []
  for (const row of rows) {
    if (!alerting(row)) continue
    const from = seen.get(row.id) ?? null
    if (from === row.shown) continue
    changes.push({ row, from, to: row.shown as AlertChange['to'] })
  }
  // Failed first, then late, each by name.
  return changes.sort(
    (a, b) =>
      (a.to === b.to ? 0 : a.to === 'failed' ? -1 : 1) || (a.row.what < b.row.what ? -1 : 1),
  )
}

const WORD: Record<Problem, [string, string]> = {
  failed: ['failed', 'failed'],
  late: ['late', 'late'],
  unknown: ['unknown', 'unknown'],
  warn: ['warning', 'warnings'],
}

const count = (n: number, state: Problem) => `${n} ${WORD[state][n === 1 ? 0 : 1]}`

/** The alert's words: what turned failed (else late) leads, then the rest of the rollup. */
export function alertText(batch: AlertBatch): { title: string; body: string } {
  const failed = batch.changes.filter((change) => change.to === 'failed')
  const lead = failed.length ? failed : batch.changes
  const state = lead[0]?.to ?? 'failed'
  const title = `${count(lead.length, state)}: ${lead.map((change) => change.row.what).join(', ')}`
  const first = lead[0]?.row
  const detail = !first
    ? ''
    : state === 'failed'
      ? first.meaning
      : `${first.what} didn’t report when due.`
  const { summary } = batch
  const rest = PROBLEMS.filter((s) => s !== state && summary.counts[s as Problem])
    .map((s) => count(summary.counts[s as Problem], s as Problem))
    .join(', ')
  const tail = `${rest ? `Also ${rest}. ` : ''}${summary.healthy} healthy.`
  return { title, body: detail ? `${detail} ${tail}` : tail }
}
