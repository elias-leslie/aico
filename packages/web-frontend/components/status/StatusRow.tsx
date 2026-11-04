'use client'

import {
  ArrowUpRight,
  FileText,
  MessageSquare,
  Play,
  Server,
} from 'lucide-react'
import Link from 'next/link'
import type { MouseEvent } from 'react'
import {
  ACTION_LABEL,
  type ActionContext,
  ago,
  at,
  type ButtonKind,
  isProblem,
  type StatusRow as Row,
  reason,
  rowButtons,
  type Shown,
  WORD,
  when,
} from '@/lib/status'

const ICONS = {
  look: MessageSquare,
  run: Play,
  log: FileText,
  detail: ArrowUpRight,
  hosts: Server,
} as const

export function StateChip({ state }: { state: Shown | 'running' }) {
  return <span className={`status-chip ${state}`}>{WORD[state]}</span>
}

/** The meaning, led by why a late or unknown row is so. */
export function Meaning({ row }: { row: Row }) {
  const why = reason(row)
  if (!why) return <>{row.meaning}</>
  return (
    <>
      <span className="why">{why}</span> Last report: {row.meaning}
    </>
  )
}

export function ActionButtons({
  row,
  context,
  big = false,
  running = false,
  onAction,
}: {
  row: Row
  context: ActionContext
  big?: boolean
  running?: boolean
  onAction: (kind: ButtonKind, row: Row) => void
}) {
  const { buttons, primary } = rowButtons(row, context)
  return (
    <>
      {buttons.map((button) => {
        const Icon = ICONS[button.kind]
        const label = ACTION_LABEL[button.kind]
        const title =
          button.disabled ??
          (button.kind === 'hosts'
            ? `Open ${row.machine} in Hosts`
            : button.kind === 'look'
              ? 'Start a session to look into it'
              : button.ref)
        return (
          <button
            key={button.kind}
            type="button"
            className={`lantern-btn${big ? '' : ' small'}${button.kind === primary ? ' primary' : big ? '' : ' ghost'}`}
            title={title}
            aria-label={label}
            disabled={!!button.disabled || (button.kind === 'run' && running)}
            onClick={(event: MouseEvent) => {
              event.stopPropagation()
              onAction(button.kind, row)
            }}
          >
            <Icon
              className="h-3.5 w-3.5"
              strokeWidth={1.7}
              aria-hidden="true"
            />
            <span className="lbl">{label}</span>
          </button>
        )
      })}
    </>
  )
}

export function StatusRowItem({
  row,
  now,
  open,
  running,
  context,
  onToggle,
  onAction,
}: {
  row: Row
  now: number
  open: boolean
  running: boolean
  context: ActionContext
  onToggle: (row: Row) => void
  onAction: (kind: ButtonKind, row: Row) => void
}) {
  const time = when(row, now)
  const updated = Date.parse(row.updated_at)
  const refs = (row.actions ?? []).filter(
    (action) => action.kind === 'run' || action.kind === 'log',
  )
  const project = row.project && (
    <Link
      href={`/status?project=${encodeURIComponent(row.project)}`}
      className="status-project"
      onClick={(event) => event.stopPropagation()}
    >
      {row.project}
    </Link>
  )
  return (
    // Clicking anywhere on the row opens it; the name is the button a keyboard uses.
    <div
      className={`status-row${isProblem(row.shown) ? '' : ' healthy'}${open ? ' open' : ''}`}
      data-row={row.id}
      onClick={() => onToggle(row)}
    >
      <div className="chipcell">
        <StateChip state={running ? 'running' : row.shown} />
      </div>
      <div className="main-cell">
        <button
          type="button"
          className="what"
          aria-expanded={open}
          onClick={(event) => {
            event.stopPropagation()
            onToggle(row)
          }}
        >
          {row.what}
        </button>
        <div className="meaning">
          <Meaning row={row} />
        </div>
        <span className="meta-m">
          {row.kind} · {row.machine}
          {row.project && <> · {project}</>}
        </span>
      </div>
      <div className="where">
        <b>{row.kind}</b> · {row.machine}
        {row.project && (
          <>
            <br />
            {project}
          </>
        )}
      </div>
      <div className="when">
        <span className="phone-only">
          {time.tone === 'late' ? (
            <span className="late-t">{time.short}</span>
          ) : (
            time.short
          )}
        </span>
        <span className="desk">
          {time.tone === 'late' ? (
            <span className="late-t">{time.lead}</span>
          ) : time.tone === 'strong' ? (
            <b>{time.lead}</b>
          ) : (
            time.lead
          )}
          {time.sub && <span className="sec">{time.sub}</span>}
        </span>
      </div>
      <div className="acts">
        <ActionButtons
          row={row}
          context={context}
          running={running}
          onAction={onAction}
        />
      </div>
      {open && (
        <div className="more">
          <dl>
            <dt>Row</dt>
            <dd className="mono">{row.id}</dd>
            <dt>Last run</dt>
            <dd>{at(row.last_run ? Date.parse(row.last_run) : null, now)}</dd>
            <dt>Next due</dt>
            <dd>
              {row.next_run ? at(Date.parse(row.next_run), now) : 'No schedule'}
            </dd>
            <dt>Last report</dt>
            <dd>
              {at(updated, now)} ({ago(updated, now)})
            </dd>
            {refs.map((action) => (
              <FragmentRef
                key={action.kind}
                label={ACTION_LABEL[action.kind]}
                value={action.ref}
              />
            ))}
          </dl>
        </div>
      )}
    </div>
  )
}

function FragmentRef({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd className="mono">{value}</dd>
    </>
  )
}
