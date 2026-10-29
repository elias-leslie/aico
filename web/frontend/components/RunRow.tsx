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

/** What a row says under its name. A run: its progress and state
 * (`2 of 5 done · lint-fix needs a decision`); a step: model, a fallback mark,
 * state and tries. The reason follows when the owner has something to decide
 * or a run failed. */
export function runMeta(
  member: RunMember,
  extra: (string | null | undefined)[] = [],
): string {
  const waiting = member.group === 'needs-you'
  const failed = member.status === 'failed' || member.status === 'refused'
  return [
    runDetail(member),
    member.kind === 'step' && (waiting || failed) ? member.reason : null,
    ...extra,
  ]
    .filter(Boolean)
    .join(' · ')
}

type Confirming = 'fail' | 'cancel' | null

/** Cancel for a going run; Retry, Skip and Fail only when the coordinator has
 * ended (while it lives it asks the owner and answers for them). Nothing
 * renders when there is nothing to do. */
function RunControls({
  member,
  act,
  orphaned,
}: {
  member: RunMember
  act: (action: RunAct) => Promise<void>
  orphaned: boolean
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

  const decide = member.can.decide && orphaned
  const cancel = member.can.cancel && member.kind === 'run'
  if (!decide && !cancel && !error) return null
  return (
    <div className="lantern-run-controls">
      {(decide || cancel) && (
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
              Cancel run
            </button>
          )}
        </div>
      )}
      {error && !confirming && (
        <p role="alert" className="lantern-run-note error">
          {error}
        </p>
      )}
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
            : 'The run and its steps stop. This cannot be undone.'
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
  /** The run's steps, as their rows, when it has any. */
  children?: ReactNode
  open: boolean
  onToggle: () => void
  /** The run's coordinator has ended: the owner answers it from here. */
  orphaned: boolean
  act: (action: RunAct) => Promise<void>
  /** Needs the owner, itself or (while folded) a step. */
  needs: boolean
}

/** A workflow run in the session list: one line (goal, progress, state), steps
 * hidden until the row is opened. A small link opens the run's page. */
export function RunRow({
  member,
  children,
  open,
  onToggle,
  orphaned,
  act,
  needs,
}: RunRowProps) {
  const url = pageUrl(member.url)
  const meta = runMeta(member, [orphaned ? 'coordinator ended' : null])
  const age = member.at ? formatAge(Date.now() - member.at) : ''
  const failed = member.status === 'failed'
  const dot = needs ? 'var(--beacon)' : failed ? 'var(--ember)' : null
  const description = `Workflow run ${member.title}: ${meta}`
  return (
    <div className="lantern-team" data-testid="run-run">
      <div className={clsx('lantern-row', 'run', 'is-run', needs && 'needs')}>
        <button
          type="button"
          className="lantern-run-hit"
          aria-expanded={open}
          aria-label={`${open ? 'Hide' : 'Show'} steps. ${description}`}
          title={open ? 'Hide steps' : 'Show steps'}
          onClick={onToggle}
        />
        <Workflow
          aria-hidden="true"
          className="h-4 w-4"
          strokeWidth={1.7}
          style={{ color: 'var(--mist)' }}
        />
        <span className="name" title={member.title}>
          {member.title}
        </span>
        <span className="when">{age}</span>
        <span className="meta">
          {dot && (
            <span
              aria-hidden="true"
              className="h-[7px] w-[7px] flex-none rounded-full"
              style={{ backgroundColor: dot }}
            />
          )}
          <span className="line-clamp-2 min-w-0 whitespace-normal">{meta}</span>
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="lantern-run-details"
              aria-label={`Details of workflow run ${member.title}, opens in Agent Hub`}
            >
              details
            </a>
          )}
        </span>
        <ChevronRight
          aria-hidden="true"
          className="lantern-run-chevron h-4 w-4"
          data-open={open}
          strokeWidth={1.7}
        />
      </div>
      {open && (
        <div
          role="group"
          aria-label={`Steps of ${member.title}`}
          className="lantern-lanes"
        >
          {children}
          <RunControls member={member} act={act} orphaned={orphaned} />
        </div>
      )}
    </div>
  )
}

/** A step in an opened run: one line, its key, model and state. When the
 * coordinator has ended and the step waits, Retry, Skip and Fail sit under it. */
export function StepRow({
  member,
  orphaned,
  act,
}: {
  member: RunMember
  orphaned: boolean
  act: (action: RunAct) => Promise<void>
}) {
  const meta = runMeta(member)
  const waiting = member.group === 'needs-you'
  const failed = member.status === 'failed' || member.status === 'refused'
  return (
    <div data-testid="run-step">
      <div
        role="group"
        aria-label={`Step ${member.title}: ${meta}`}
        className={clsx('lantern-row', 'run', 'is-step', waiting && 'needs')}
      >
        <CornerDownRight
          aria-hidden="true"
          className="h-4 w-4"
          strokeWidth={1.7}
          style={{ color: 'var(--mist)' }}
        />
        <span className="name" title={member.title}>
          {member.title}
        </span>
        <span className="meta">
          {(waiting || failed) && (
            <span
              aria-hidden="true"
              className="h-[7px] w-[7px] flex-none rounded-full"
              style={{
                backgroundColor: waiting ? 'var(--beacon)' : 'var(--ember)',
              }}
            />
          )}
          <span className="line-clamp-2 min-w-0 whitespace-normal">{meta}</span>
        </span>
      </div>
      <RunControls member={member} act={act} orphaned={orphaned} />
    </div>
  )
}
