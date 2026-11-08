'use client'

import { ago } from '@aico/shared/time'
import { clsx } from 'clsx'
import { Check, Copy } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { openFiles } from '@/lib/files-opener'
import type { AskReply, AttachedFile, OwnerAsk } from '@/lib/hooks/use-asks'
import { sessionHostLabel } from '@/lib/machines'
import { openAppPath, workbenchPathOf } from '@/lib/workbench'
import { PlainMarkdown } from '../PlainMarkdown'
import { AttachedFiles } from './AskAttached'
import { askTitle, Meta, OpenSession } from './ask-shared'

/** Which session gets the owner's answer, in the owner's words (`text` short
 * for the phone, `detail` for the tooltip); null on an older Tether that does
 * not say (`answerTo` absent). */
export function answerRoute(
  ask: OwnerAsk,
  nameOf: (id: string) => string | null,
  chat = false,
): { text: string; detail: string } | null {
  if (chat && ask.session)
    return {
      text: 'Answer goes to this chat',
      detail: 'The chat that asked gets it.',
    }
  if (ask.answerTo === undefined) return null
  if (ask.answerTo === null)
    return {
      text: 'The agent reads this when it checks',
      detail:
        'No session is waiting on this answer; it stays here for the agent.',
    }
  const name = nameOf(ask.answerTo)
  const label = name ? `“${name}”` : `session ${ask.answerTo}`
  if (ask.answerTo === ask.session)
    return {
      text: `Answer goes to ${label}`,
      detail: 'The session that asked gets it.',
    }
  return {
    text: `Answer goes to ${label} (asker ended)`,
    detail:
      'The session that asked has ended, so the session that launched it gets the answer.',
  }
}

/** An ask an app filed (a notice or a failed Status row): nobody is waiting to read the
 * answer, so the card shows its choices and the link it opens, nothing to say to an agent. */
export function isAppAsk(ask: OwnerAsk): boolean {
  return Boolean(ask.origin)
}

/** The https link the ask opens, else null. */
export function openLink(ask: OwnerAsk): string | null {
  return typeof ask.open === 'string' && /^https:\/\//.test(ask.open)
    ? ask.open
    : null
}

/** The Workbench page the ask leads to (the Designs tab on one design, say), else null. It opens in
 * the Workbench window, or in place on a phone, so it is never a plain link. */
export function workbenchPath(ask: OwnerAsk): string | null {
  return workbenchPathOf(openLink(ask))
}

/** The button for it: "Open design" on the Designs tab, else "Open". */
function workbenchLabel(path: string): string {
  return new URLSearchParams(path.split('?')[1] ?? '').get('tab') === 'designs'
    ? 'Open design'
    : 'Open'
}

/** What a down host is, in the owner's words. */
function awayText(state: string | undefined): string {
  return state === 'powered_off'
    ? 'powered off'
    : state === 'connecting'
      ? 'still connecting'
      : 'not reachable'
}

/** The question's text as the agent wrote it (markdown shown formatted); in
 * the side's list it folds to a few lines, with the rest one click away. */
function AskBody({ text, clamp }: { text: string; clamp: boolean }) {
  const [open, setOpen] = useState(false)
  const router = useRouter()
  const long = clamp && (text.length > 220 || text.split('\n').length > 4)
  return (
    <div className="mb-2">
      <PlainMarkdown
        text={text}
        buttons
        onOpenApp={(path) => openAppPath(path, (to) => router.push(to))}
        className={clsx(
          'lantern-ask-body text-[13.5px]',
          long && !open && 'folded',
        )}
      />
      {long && (
        <button
          type="button"
          className="lantern-ask-more"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}

/** Who asked and when, any note that the asking computer is away, the question, and what came with it. */
export function AskHead({
  ask,
  asker,
  now,
  inSession,
  compact,
  linkAway,
  onOpenFile,
}: {
  ask: OwnerAsk
  asker: { name: string }
  now: number
  inSession: boolean
  compact: boolean
  /** A linked host that is down: this card is its last copy. */
  linkAway: boolean
  onOpenFile?: (file: AttachedFile) => void
}) {
  // A notice from a program isn't an agent carrying on: it says nothing about urgency, and a
  // security alert must not read as No rush.
  const urgency = ask.blocking
    ? 'Waiting on this'
    : ask.origin
      ? null
      : 'No rush'
  return (
    <>
      {!inSession && (
        <Meta>
          {urgency && (
            <span
              className="lantern-chip"
              data-tone={ask.blocking ? 'wait' : undefined}
              data-testid="ask-urgency"
              title={
                ask.blocking
                  ? 'The agent has stopped until you answer'
                  : 'The agent keeps working; answer when you can'
              }
            >
              {ask.blocking && (
                <span className="lantern-mark" data-tone="need" />
              )}
              {urgency}
            </span>
          )}
          <span className="min-w-0 truncate" style={{ color: 'var(--mist)' }}>
            <span style={{ color: 'var(--bone)' }}>{asker.name}</span>
            {' · asked '}
            {ago(ask.createdAt, now)}
            {ask.host ? ` · on ${sessionHostLabel(ask.host)}` : ''}
          </span>
        </Meta>
      )}
      {linkAway && (
        <p
          data-testid="ask-away"
          className="mb-1.5 text-[12px]"
          style={{ color: 'var(--ember)' }}
        >
          {ask.host ? sessionHostLabel(ask.host) : 'That computer'} is{' '}
          {awayText(ask.peer?.state)}. This is the last copy seen; you can
          answer when it is back.
        </p>
      )}
      <p className="mb-1.5 font-semibold" style={{ overflowWrap: 'anywhere' }}>
        {askTitle(ask)}
      </p>
      {ask.body && <AskBody text={ask.body} clamp={compact} />}
      {ask.command && <CommandBox command={ask.command} />}
      <AttachedFiles
        ask={ask}
        onOpen={
          onOpenFile ?? ((file) => openFiles({ kind: 'path', path: file.path }))
        }
      />
      {ask.share && !ask.attached?.length && (
        <button
          type="button"
          className="lantern-btn ghost small mb-2"
          onClick={() =>
            openFiles({ kind: 'shared', showId: ask.share ?? undefined })
          }
        >
          Open what it shared
        </button>
      )}
    </>
  )
}

/** The ask's options as a radio group; picking the chosen one again clears it. */
export function AskChoices({
  ask,
  choice,
  onChoose,
}: {
  ask: OwnerAsk
  choice: number | null
  onChoose: (choice: number | null) => void
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Choices"
      className="mb-2 flex flex-col gap-1.5"
    >
      {ask.options.map((option, index) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={choice === index}
          className="lantern-ask-option"
          data-recommended={ask.recommended === index ? 'true' : undefined}
          onClick={() => onChoose(choice === index ? null : index)}
        >
          <b aria-hidden="true">{index + 1}</b>
          <span className="min-w-0 flex-1">{option}</span>
          {ask.recommended === index && <em>recommended</em>}
        </button>
      ))}
    </div>
  )
}

/** The reply box and Send. */
export function AskForm({
  app,
  hasOptions,
  note,
  canSend,
  waitTitle,
  sendLabel,
  onNote,
  onSubmit,
}: {
  app: boolean
  hasOptions: boolean
  note: string
  canSend: boolean
  waitTitle: string | undefined
  sendLabel: string
  onNote: (note: string) => void
  onSubmit: () => void
}) {
  return (
    <form
      className="lantern-ask-form"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      {!app && (
        <label className="lantern-field lantern-ask-note min-w-0 flex-1 px-2">
          <span className="sr-only">
            {hasOptions ? 'Note to the agent' : 'Reply to the agent'}
          </span>
          <input
            value={note}
            onChange={(event) => onNote(event.target.value)}
            placeholder={
              hasOptions ? 'Optional note to the agent…' : 'Reply to the agent…'
            }
            maxLength={1000}
            className="text-[13px]"
          />
        </label>
      )}
      {(!app || hasOptions) && (
        <button
          type="submit"
          className="lantern-btn primary small"
          disabled={!canSend}
          title={waitTitle}
        >
          {sendLabel}
        </button>
      )}
    </form>
  )
}

/** The buttons under the form: Done, Open, Open session, Reply "Done", Not now. */
export function AskActions({
  app,
  hasOptions,
  wantsFiles,
  note,
  inSession,
  link,
  workbench,
  sessionId,
  busy,
  waitTitle,
  onOpenSession,
  onSend,
}: {
  app: boolean
  hasOptions: boolean
  wantsFiles: boolean
  /** What is typed in the reply box; Not now takes it along on a files ask, where Send can't. */
  note: string
  inSession: boolean
  /** The https link the ask opens, if any. */
  link: string | null
  /** The Workbench page the ask leads to, if it does (see workbenchPath). */
  workbench: string | null
  sessionId: string | null
  /** An answer is being saved, or the server or host can't take one. */
  busy: boolean
  waitTitle: string | undefined
  onOpenSession?: () => void
  onSend: (answer: AskReply, said: string) => void
}) {
  const router = useRouter()
  return (
    <div className="lantern-ask-actions">
      {workbench && (
        <a
          href={workbench}
          className="lantern-btn primary small"
          onClick={(event) => {
            event.preventDefault()
            openAppPath(workbench, (to) => router.push(to))
          }}
        >
          {workbenchLabel(workbench)}
        </a>
      )}
      {/* Without choices or a link, Done is all there is to press; with a link the work is there. */}
      {app && !hasOptions && !link && (
        <button
          type="button"
          className="lantern-btn primary small"
          disabled={busy}
          title={waitTitle}
          onClick={() => onSend({ kind: 'answer', text: 'Done' }, 'Done')}
        >
          Done
        </button>
      )}
      {app && link && !workbench && (
        <a
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          className="lantern-btn small"
        >
          Open
        </a>
      )}
      {!app && !inSession && (
        <OpenSession sessionId={sessionId} onOpen={onOpenSession} />
      )}
      {!app && !hasOptions && !wantsFiles && !workbench && (
        <button
          type="button"
          className="lantern-btn small"
          disabled={busy}
          onClick={() => onSend({ kind: 'answer', text: 'Done' }, 'Done')}
          title={
            waitTitle ??
            'Sends the agent “Done”; the question counts as answered'
          }
        >
          Reply “Done”
        </button>
      )}
      {!app && (
        <button
          type="button"
          className="lantern-ask-later"
          disabled={busy}
          onClick={() =>
            onSend(
              {
                kind: 'answer',
                text: 'Not now',
                // A decline is the one answer a files ask takes without its files.
                ...(wantsFiles ? { skippedFiles: true } : {}),
                ...(wantsFiles && note ? { note } : {}),
              },
              wantsFiles && note ? `Not now, “${note}”` : 'Not now',
            )
          }
          title={
            waitTitle ??
            (wantsFiles && note
              ? 'Sends the agent “Not now” and what you typed, without any files; the question counts as answered'
              : 'Sends the agent “Not now”; the question counts as answered, and it moves on')
          }
        >
          Not now
        </button>
      )}
    </div>
  )
}

function CommandBox({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="lantern-ask-cmd mb-2">
      <code className="min-w-0 flex-1 whitespace-pre-wrap">{command}</code>
      <button
        type="button"
        className="lantern-btn ghost small"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(command)
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1500)
          } catch {
            setCopied(false)
          }
        }}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5" strokeWidth={1.7} />
        ) : (
          <Copy className="h-3.5 w-3.5" strokeWidth={1.7} />
        )}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}
