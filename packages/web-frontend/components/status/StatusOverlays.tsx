'use client'

import Link from 'next/link'
import { HostsSheet } from '@/components/HostsSheet'
import {
  type ActionContext,
  type ButtonKind,
  lookProject,
  type SessionInfo,
  type StatusFilter,
  type StatusRow,
  when,
} from '@/lib/status'
import { type FilterOptions, FiltersSheet } from './StatusFilterControls'
import { ActionButtons, Meaning, StateChip } from './StatusRow'
import { LogSheet, LookSheet, StatusSheet } from './StatusSheets'
import type { Sheet, Toast } from './use-status-actions'

/** Status lives in the aico project: a row with no project of its own is looked into there. */
const HOME_PROJECT = 'aico'

function RowSheet({
  row,
  phone,
  running,
  context,
  names,
  now,
  onAction,
  onClose,
}: {
  row: StatusRow
  phone: boolean
  running: boolean
  context: ActionContext
  names: SessionInfo['names']
  now: number
  onAction: (kind: ButtonKind, row: StatusRow, ref: string) => void
  onClose: () => void
}) {
  const time = when(row, now)
  return (
    <StatusSheet
      open
      onOpenChange={(open) => !open && onClose()}
      title={row.what}
      place={phone ? 'bottom' : 'center'}
      testId="status-row-sheet"
    >
      <div className="status-sheet-meta">
        <StateChip state={running ? 'running' : row.shown} />
        <span>
          {row.kind} · {row.machine}
          {row.project ? ` · ${row.project}` : ''}
        </span>
      </div>
      <p className="status-sheet-lead">
        <Meaning row={row} names={names} />
      </p>
      <p className="status-sheet-note">
        {time.lead}
        {time.sub && (
          <>
            <br />
            {time.sub}
          </>
        )}
      </p>
      <div className="status-sheet-acts">
        <ActionButtons
          row={row}
          context={context}
          big
          running={running}
          onAction={onAction}
        />
      </div>
    </StatusSheet>
  )
}

/** Whatever sits over the page: the open sheet, and the toast that says how an action went. */
export function StatusOverlays({
  sheet,
  sheetRow,
  phone,
  now,
  running,
  context,
  sessions,
  projects,
  filter,
  project,
  filterOptions,
  toast,
  onAction,
  onFilterChange,
  onFilterClear,
  onClose,
  onStarted,
}: {
  sheet: Sheet
  /** The row the open sheet is about, if it is about one. */
  sheetRow: StatusRow | undefined
  phone: boolean
  now: number
  running: ReadonlySet<string>
  context: ActionContext
  sessions: SessionInfo
  projects: Parameters<typeof lookProject>[1]
  filter: StatusFilter
  project: string
  filterOptions: FilterOptions
  toast: Toast | null
  onAction: (kind: ButtonKind, row: StatusRow, ref: string) => void
  onFilterChange: (next: Partial<StatusFilter>) => void
  onFilterClear: () => void
  onClose: () => void
  onStarted: (session: string | null) => void
}) {
  return (
    <>
      {sheet?.kind === 'row' && sheetRow && (
        <RowSheet
          row={sheetRow}
          phone={phone}
          running={running.has(sheetRow.id)}
          context={context}
          names={sessions.names}
          now={now}
          onAction={onAction}
          onClose={onClose}
        />
      )}
      {sheet?.kind === 'log' && sheetRow && (
        <LogSheet
          row={sheetRow}
          place={phone ? 'bottom' : 'side'}
          onClose={onClose}
        />
      )}
      {sheet?.kind === 'look' && sheetRow && (
        <LookSheet
          row={sheetRow}
          project={lookProject(sheetRow, projects, HOME_PROJECT)}
          place={phone ? 'bottom' : 'center'}
          onClose={onClose}
          onStarted={onStarted}
        />
      )}
      {sheet?.kind === 'filters' && (
        <FiltersSheet
          filter={filter}
          project={project}
          options={filterOptions}
          onChange={onFilterChange}
          onClear={onFilterClear}
          onClose={onClose}
        />
      )}
      {sheet?.kind === 'hosts' && (
        <HostsSheet open onOpenChange={(open) => !open && onClose()} />
      )}
      {toast && (
        <div className="status-toast" role="status">
          {toast.text}
          {toast.href && (
            <Link href={toast.href} className="status-toast-link">
              Open
            </Link>
          )}
        </div>
      )}
    </>
  )
}
