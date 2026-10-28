'use client'

import { clsx } from 'clsx'
import { ChevronRight, CornerDownRight, Workflow } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import type { RunMember } from 'tether/teams'
import { DECISION_LABEL, DECISIONS, runDetail } from 'tether/teams'
import { formatAge } from '@/lib/attention'
import type { RunAct } from '@/lib/hooks/use-workflow-runs'
import { ConfirmationDialog } from './ConfirmationDialog'

/** The run's page, only when it is a web address. */
export function pageUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed.toString()
      : null
  } catch {
    return null
  }
}

/** What a row says under its name. A run: its state and its steps; a step: its
 * state, models and tries. The reason follows when the owner has something to
 * decide or a run failed. */
export function runMeta(
  member: RunMember,
  extra: (string | null | undefined)[] = [],
): string {
  const waiting = member.group === 'needs-you'
  const failed = member.status === 'failed' || member.status === 'refused'
  return [runDetail(member), waiting || failed ? member.reason : null, ...extra]
    .filter(Boolean)
    .join(' · ')
}

type Confirming = 'fail' | 'cancel' | null

/** Retry, Skip and Fail for a step waiting on the owner, Cancel while it is
 * going, Dismiss once the run has ended; a run also says where its plan is
 * changed. Nothing renders when there is nothing to do. */
function RunControls({
  member,
  act,
}: {
  member: RunMember
  act: (action: RunAct) => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<Confirming>(null)
  const what = member.kind === 'run' ? 'run' : 'step'
  const label = (verb: string) => `${verb} ${what} ${member.title}`

  async function send(action: RunAct) {
    setBusy(true)
    setError(null)
    try {
      await act(action)
      setConfirming(null)
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'The run was not changed',
      )
    } finally {
      setBusy(false)
    }
  }

  const { decide, cancel, dismiss } = member.can
  if (!decide && !cancel && !dismiss && !error && !member.hint) return null
  const cancelCopy =
    what === 'step'
      ? 'The step stops. The rest of the run carries on.'
      : 'The run and its steps stop. This cannot be undone.'
  return (
    <div className="lantern-run-controls">
      {(decide || cancel || dismiss) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {decide &&
            DECISIONS.map((decision) => (
              <button
                key={decision}
                type="button"
                className={clsx(
                  'lantern-btn small',
                  decision === 'retry' && 'primary',
                )}
                disabled={busy}
                aria-label={label(DECISION_LABEL[decision])}
                onClick={() =>
                  decision === 'fail'
                    ? setConfirming('fail')
                    : void send({ type: 'resume', member, action: decision })
                }
              >
                {DECISION_LABEL[decision]}
              </button>
            ))}
          {cancel && (
            <button
              type="button"
              className="lantern-btn small ghost"
              disabled={busy}
              aria-label={label('Cancel')}
              onClick={() => setConfirming('cancel')}
            >
              Cancel {what}
            </button>
          )}
          {dismiss && (
            <button
              type="button"
              className="lantern-btn small ghost"
              disabled={busy}
              aria-label={label('Dismiss')}
              onClick={() => void send({ type: 'dismiss', member })}
            >
              Dismiss
            </button>
          )}
        </div>
      )}
      {error && !confirming && (
        <p role="alert" className="lantern-run-note error">
          {error}
        </p>
      )}
      {member.hint && <p className="lantern-run-note">{member.hint}</p>}
      <ConfirmationDialog
        isOpen={confirming !== null}
        title={
          confirming === 'fail'
            ? `Fail ${what} ${member.title}?`
            : `Cancel ${what} ${member.title}?`
        }
        message={
          confirming === 'fail'
            ? 'The workflow records it as failed and carries on without it.'
            : cancelCopy
        }
        confirmText={confirming === 'fail' ? 'Fail it' : `Cancel ${what}`}
        cancelText="Keep going"
        isPending={busy}
        error={error}
        onConfirm={() =>
          void send(
            confirming === 'fail'
              ? { type: 'resume', member, action: 'fail' }
              : { type: 'cancel', member },
          )
        }
        onCancel={() => {
          setConfirming(null)
          setError(null)
        }}
      />
    </div>
  )
}

interface RunRowProps {
  member: RunMember
  /** The run's steps with their rows, when it has any. */
  children?: ReactNode
  isTeam: boolean
  open: boolean
  onToggle: () => void
  /** Step counts for a run: `1 working · 2 done`. */
  summary: string | null
  orphaned: boolean
  act: (action: RunAct) => Promise<void>
  /** Needs the owner, itself or (while folded) a step. */
  needs: boolean
}

/** A workflow run or one of its steps in the session list. The row opens the
 * run's page in Agent Hub; its controls sit under it. */
export function RunRow({
  member,
  children,
  isTeam,
  open,
  onToggle,
  summary,
  orphaned,
  act,
  needs,
}: RunRowProps) {
  const isRun = member.kind === 'run'
  const url = pageUrl(member.url)
  const meta = runMeta(member, [
    isRun ? summary : null,
    orphaned ? 'coordinator ended' : null,
  ])
  const age = member.at ? formatAge(Date.now() - member.at) : ''
  const failed = member.status === 'failed' || member.status === 'refused'
  const dot = needs ? 'var(--beacon)' : failed ? 'var(--ember)' : null
  const Icon = isRun ? Workflow : CornerDownRight
  const rowClass = clsx(
    'lantern-row',
    'run',
    isRun ? 'is-run' : 'is-step',
    needs && 'needs',
    isTeam && 'lead',
  )
  const body = (
    <>
      <Icon
        aria-hidden="true"
        className="h-4 w-4"
        strokeWidth={1.7}
        style={{ color: 'var(--mist)' }}
      />
      <span className="name">{member.title}</span>
      <span className="when">{age}</span>
      <span className="meta">
        {dot && (
          <span
            aria-hidden="true"
            className="h-[7px] w-[7px] flex-none rounded-full"
            style={{ backgroundColor: dot }}
          />
        )}
        <span className="truncate">{meta}</span>
      </span>
    </>
  )
  const description = `${isRun ? 'Workflow run' : 'Step'} ${member.title}: ${meta}`
  return (
    <div
      className={clsx(isTeam && 'lantern-team')}
      data-testid={`run-${member.kind}`}
    >
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className={rowClass}
          aria-label={`${description}. Opens in Agent Hub`}
          title="Open in Agent Hub"
        >
          {body}
        </a>
      ) : (
        <div className={rowClass} role="group" aria-label={description}>
          {body}
        </div>
      )}
      {isTeam && (
        <button
          type="button"
          className="lantern-fold"
          aria-expanded={open}
          aria-label={`${open ? 'Hide' : 'Show'} steps of ${member.title}`}
          title={open ? 'Hide steps' : 'Show steps'}
          onClick={onToggle}
        >
          <ChevronRight
            aria-hidden="true"
            className="h-4 w-4"
            strokeWidth={1.7}
          />
        </button>
      )}
      <RunControls member={member} act={act} />
      {isTeam && open && (
        <div
          role="group"
          aria-label={`Steps of ${member.title}`}
          className="lantern-lanes"
        >
          {children}
        </div>
      )}
    </div>
  )
}
