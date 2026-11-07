'use client'

import {
  ArrowUpRight,
  FileText,
  MessageSquare,
  Play,
  RotateCcw,
  Server,
} from 'lucide-react'
import Link from 'next/link'
import type { MouseEvent } from 'react'
import { machineLabel } from '@/lib/machine-name'
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
  type SessionInfo,
  type Shown,
  tierLabel,
  tierOf,
  WORD,
  when,
  withSessionNames,
} from '@/lib/status'
import styles from './StatusRow.module.css'

const ICONS = {
  look: MessageSquare,
  run: Play,
  log: FileText,
  detail: ArrowUpRight,
  hosts: Server,
  resume: RotateCcw,
  open: ArrowUpRight,
} as const

export function StateChip({ state }: { state: Shown | 'running' }) {
  return <span className={`status-chip ${state}`}>{WORD[state]}</span>
}

/**
 * The meaning, led by why a late, unknown or machine-off row is so. A session the text names by id
 * reads as its name (or “a session that has ended”).
 */
export function Meaning({
  row,
  names = null,
}: {
  row: Row
  names?: SessionInfo['names']
}) {
  const why = reason(row)
  const meaning = withSessionNames(row.meaning, names)
  if (!why) return <>{meaning}</>
  return (
    <>
      <span className="why">{why}</span>{' '}
      {row.machine_off ? meaning : `Last report: ${meaning}`}
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
  onAction: (kind: ButtonKind, row: Row, ref: string) => void
}) {
  const { buttons, primary } = rowButtons(row, context)
  const names = context.sessions?.names
  const several =
    buttons.filter(
      (button) => button.kind === 'resume' || button.kind === 'open',
    ).length > 1
  return (
    <>
      {buttons.map((button) => {
        const Icon = ICONS[button.kind]
        const going = button.kind === 'run' && running
        const session =
          button.kind === 'resume' || button.kind === 'open'
            ? (names?.get(button.ref) ?? 'the session')
            : ''
        // Two sessions on one row: the label says which.
        const label = going
          ? 'Running…'
          : session && several
            ? `${ACTION_LABEL[button.kind]} ${session.length > 16 ? `${session.slice(0, 15)}…` : session}`
            : ACTION_LABEL[button.kind]
        const title =
          button.disabled ??
          (going
            ? 'It’s running; the row updates when it reports'
            : button.kind === 'hosts'
              ? `Open ${machineLabel(row.machine)} in Hosts`
              : button.kind === 'look'
                ? 'Start a session to look into it'
                : button.kind === 'resume'
                  ? `Resume “${session}”, which stopped`
                  : button.kind === 'open'
                    ? `Open “${session}”`
                    : button.ref)
        return (
          <button
            key={`${button.kind}:${button.ref}`}
            type="button"
            className={`lantern-btn${big ? '' : ' small'}${button.kind === primary ? ' primary' : big ? '' : ' ghost'}`}
            title={title}
            aria-label={session && !several ? `${label} ${session}` : label}
            disabled={!!button.disabled || going}
            onClick={(event: MouseEvent) => {
              event.stopPropagation()
              onAction(button.kind, row, button.ref)
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
  onAction: (kind: ButtonKind, row: Row, ref: string) => void
}) {
  const time = when(row, now)
  const updated = Date.parse(row.updated_at)
  const refs = (row.actions ?? []).flatMap((action) =>
    action.kind === 'run' || action.kind === 'log'
      ? [{ kind: action.kind, ref: action.ref }]
      : [],
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
        {isProblem(row.shown) && (
          <span className={styles.tier}>{tierLabel(tierOf(row))}</span>
        )}
        <div className="meaning">
          <Meaning row={row} names={context.sessions?.names} />
        </div>
        <span className="meta-m">
          {row.kind} · {machineLabel(row.machine)}
          {row.project && <> · {project}</>}
        </span>
      </div>
      <div className="where">
        <b>{row.kind}</b> · {machineLabel(row.machine)}
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
