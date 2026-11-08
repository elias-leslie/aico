'use client'

import { ChevronDown } from 'lucide-react'
import type { ReactNode } from 'react'
import {
  type ActionContext,
  type ButtonKind,
  isCounted,
  isProblem,
  plural,
  type StatusFilter,
  type StatusRow,
} from '@/lib/status'
import { SkeletonRows } from './SkeletonRows'
import { StatusRowItem } from './StatusRow'

type Mode = 'loading' | 'failed' | 'empty' | 'live'

function LoadingRows() {
  return (
    <>
      <p className="status-muted">Loading status…</p>
      <SkeletonRows />
    </>
  )
}

function Empty({
  title,
  compact,
  children,
}: {
  title: string
  compact?: boolean
  children?: ReactNode
}) {
  return (
    <div className="status-rows">
      <div className={`status-empty${compact ? ' compact' : ''}`}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  )
}

function Fold({
  open,
  onToggle,
  children,
}: {
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className="status-fold"
      aria-expanded={open}
      onClick={onToggle}
    >
      <span>{children}</span>
      <ChevronDown className="h-4 w-4" strokeWidth={1.7} aria-hidden="true" />
    </button>
  )
}

/** The rows, or the honest reason there are none: loading, not loaded, nothing reported, nothing matching. */
export function StatusBody({
  mode,
  all,
  shown,
  filter,
  project,
  now,
  openId,
  running,
  context,
  healthyOpen,
  offOpen,
  onHealthyOpen,
  onOffOpen,
  onToggle,
  onAction,
  onClear,
}: {
  mode: Mode
  /** Every row read. */
  all: StatusRow[]
  /** The rows that pass the filters, in order. */
  shown: StatusRow[]
  filter: StatusFilter
  /** The project the page is fixed to; empty on the main Status page. */
  project: string
  now: number
  openId: string | null
  running: ReadonlySet<string>
  context: ActionContext
  healthyOpen: boolean
  offOpen: boolean
  onHealthyOpen: (open: boolean) => void
  onOffOpen: (open: boolean) => void
  onToggle: (row: StatusRow) => void
  onAction: (kind: ButtonKind, row: StatusRow, ref: string) => void
  onClear: () => void
}) {
  if (mode === 'loading') return <LoadingRows />
  if (mode === 'failed')
    return (
      <Empty title="No rows to show">
        The list comes back when the server answers.
      </Empty>
    )
  if (mode === 'empty')
    return (
      <Empty title="No rows yet">
        Each check, job, backup and service adds its row the first time it
        reports.
        <br />
        Nothing has reported to this Aico so far.
      </Empty>
    )
  if (!shown.length)
    return (
      <Empty title="Nothing matches">
        {plural(
          all.filter((row) => !project || row.project === project).length,
          'row',
        )}{' '}
        hidden by these filters.{' '}
        <button
          type="button"
          className="lantern-btn ghost small"
          onClick={onClear}
        >
          Clear filters
        </button>
      </Empty>
    )

  const problems = shown.filter(isCounted)
  // Off is not healthy: a row of a machine that is off has nothing to report, so it folds apart.
  const healthy = shown.filter((row) => row.shown === 'ok')
  // Rows waiting after their machine came back sit with the off rows until they report.
  const offRows = shown.filter(
    (row) => row.shown === 'off' || (isProblem(row.shown) && !isCounted(row)),
  )
  const hasSearch = !!filter.search.trim()
  const filteredStates = (state: 'ok' | 'off') =>
    hasSearch ||
    filter.states.includes(state) ||
    (!problems.length && filter.states.length > 0)
  const showHealthy = healthyOpen || filteredStates('ok')
  const showOff = offOpen || filteredStates('off')
  const rowsOf = (list: StatusRow[]) => (
    <div className="status-rows">
      {list.map((row) => (
        <StatusRowItem
          key={row.id}
          row={row}
          now={now}
          open={openId === row.id}
          running={running.has(row.id)}
          context={context}
          onToggle={onToggle}
          onAction={onAction}
        />
      ))}
    </div>
  )
  return (
    <>
      {problems.length > 0 ? (
        <section className="status-group" aria-label="Problems">
          <div className="lantern-sec">
            Problems <span className="n">{problems.length}</span>
          </div>
          {rowsOf(problems)}
        </section>
      ) : (
        !filter.states.length &&
        !hasSearch && <Empty title="No problems" compact />
      )}
      {healthy.length > 0 && (
        <section className="status-group" aria-label="Healthy">
          <Fold open={showHealthy} onToggle={() => onHealthyOpen(!showHealthy)}>
            <b>{healthy.length} healthy</b>
          </Fold>
          {showHealthy && rowsOf(healthy)}
        </section>
      )}
      {offRows.length > 0 && (
        <section className="status-group" aria-label="Off">
          <Fold open={showOff} onToggle={() => onOffOpen(!showOff)}>
            <b>{offRows.length} off</b>{' '}
            <span className="status-muted">
              · their machine is off, so nothing is reported
            </span>
          </Fold>
          {showOff && rowsOf(offRows)}
        </section>
      )}
    </>
  )
}
