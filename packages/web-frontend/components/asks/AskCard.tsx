'use client'

import { clsx } from 'clsx'
import { Check, Copy } from 'lucide-react'
import { useState } from 'react'
import { dropAskCaptureQueue } from '@/lib/capture-queue'
import { openFiles } from '@/lib/files-opener'
import { useServerReach } from '@/lib/frame/server-reach'
import {
  type AskReply,
  type AttachedFile,
  type OwnerAsk,
  useAskReply,
} from '@/lib/hooks/use-asks'
import { useTerminalSessions } from '@/lib/hooks/use-terminal-sessions'
import { PRODUCT_NAME } from '@/lib/project-branding'
import { plural } from '@/lib/status'
import { PlainMarkdown } from '../PlainMarkdown'
import { AttachedFiles } from './AskAttached'
import { AskFilesBlock, addMoreText, useAskFiles } from './AskFiles'
import {
  askTitle,
  Meta,
  OpenSession,
  useAsker,
  useSessionName,
} from './ask-shared'

/** Which session gets the owner's answer, in the owner's words (`text` short
 * for the phone, `detail` for the tooltip); null on an older Tether that does
 * not say (`answerTo` absent). */
function answerRoute(
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
      text: 'No session will get the answer',
      detail: 'The agent reads it when it checks.',
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
function isAppAsk(ask: OwnerAsk): boolean {
  return Boolean(ask.origin)
}

/** The https link the ask opens, else null. */
function openLink(ask: OwnerAsk): string | null {
  return typeof ask.open === 'string' && /^https:\/\//.test(ask.open)
    ? ask.open
    : null
}

/** What a down host is, in the owner's words. */
function awayText(state: string | undefined): string {
  return state === 'powered_off'
    ? 'powered off'
    : state === 'connecting'
      ? 'still connecting'
      : 'not reachable'
}

/** "48 min ago": how long ago, in words. */
function agoWords(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`
  return `${Math.floor(minutes / 1440)} days ago`
}

/** The question's text as the agent wrote it (markdown shown formatted); in
 * the side's list it folds to a few lines, with the rest one click away. */
function AskBody({ text, clamp }: { text: string; clamp: boolean }) {
  const [open, setOpen] = useState(false)
  const long = clamp && (text.length > 220 || text.split('\n').length > 4)
  return (
    <div className="mb-2">
      <PlainMarkdown
        text={text}
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

export function AskCard({
  ask,
  now,
  onSent,
  onOpenSession,
  onOpenFile,
  inSession = false,
  compact = false,
}: {
  ask: OwnerAsk
  now: number
  /** Called with what was said once the answer is saved. */
  onSent?: (text: string) => void
  onOpenSession?: () => void
  /** Opens an attached file in place; without it, the session's Files viewer. */
  onOpenFile?: (file: AttachedFile) => void
  /** Shown in the session that asked: no asker line, no Open session. */
  inSession?: boolean
  /** In the side's list: the question's text folds to a few lines. */
  compact?: boolean
}) {
  const asker = useAsker(ask)
  const nameOf = useSessionName()
  const { sessions } = useTerminalSessions({ includeDetached: true })
  const chat =
    !ask.host &&
    sessions?.some(
      (session) => session.id === ask.session && session.mode === 'aico-chat',
    )
  const app = isAppAsk(ask)
  const link = openLink(ask)
  const route = app ? null : answerRoute(ask, nameOf, chat)
  const reply = useAskReply()
  const [choice, setChoice] = useState<number | null>(null)
  const [note, setNote] = useState('')
  const hasOptions = ask.options.length > 0
  const files = useAskFiles(ask)
  const wantsFiles = files.wants !== null
  // The card leaves the list once the answer is saved, so the drawer says it.
  const send = (answer: AskReply, said: string) =>
    reply
      .mutateAsync({ id: ask.id, reply: answer })
      .then(({ ask: saved }) => {
        // Sent: the files are the agent's now, not a draft.
        dropAskCaptureQueue(ask.id)
        onSent?.(
          `${saved.delivery === 'wake' ? 'Sent to' : 'Saved for'} “${(saved.answerTo && nameOf(saved.answerTo)) || asker.name}”: ${said}.`,
        )
      })
      .catch(() => {
        // reply.error shows under the card; saved files stay saved.
      })
  const noteText = note.trim()
  const said = choice !== null || noteText.length > 0
  // A linked host that is down cannot take the answer; this is its last copy.
  const linkAway = ask.peer !== undefined
  // The server is down: an answer would be lost, so the buttons wait.
  const down = useServerReach().down
  const away = linkAway || down
  const waitTitle = down
    ? `Can’t reach ${PRODUCT_NAME}; answer once it is back`
    : undefined
  const canSend =
    !away &&
    !reply.isPending &&
    files.waiting === 0 &&
    (wantsFiles ? files.enough && (said || files.saved.length > 0) : said)
  const sendLabel =
    files.waiting > 0
      ? `Waiting for ${files.waiting} upload${files.waiting === 1 ? '' : 's'}`
      : files.wants && !files.enough
        ? addMoreText(files.wants, files.saved.length)
        : 'Send'

  const Item = inSession ? 'div' : 'li'
  return (
    <Item
      data-testid="ask-card"
      className={inSession ? undefined : 'lantern-ask'}
      data-blocking={ask.blocking ? 'true' : undefined}
    >
      {!inSession && (
        <Meta>
          <span
            className="lantern-chip"
            data-tone={ask.blocking ? 'wait' : undefined}
            data-testid="ask-urgency"
          >
            {ask.blocking && <span className="lantern-mark" data-tone="need" />}
            {ask.blocking ? 'Waiting on this' : 'No rush'}
          </span>
          <span className="min-w-0 truncate" style={{ color: 'var(--mist)' }}>
            <span style={{ color: 'var(--bone)' }}>{asker.name}</span>
            {' · asked '}
            {agoWords(now - ask.createdAt)}
            {ask.host ? ` · on ${ask.host}` : ''}
          </span>
        </Meta>
      )}
      {linkAway && (
        <p
          data-testid="ask-away"
          className="mb-1.5 text-[12px]"
          style={{ color: 'var(--ember)' }}
        >
          {ask.host ?? 'That computer'} is {awayText(ask.peer?.state)}. This is
          the last copy seen; you can answer when it is back.
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
          className="lantern-btn ghost small mb-2 -ml-2.5"
          style={{ color: 'var(--lantern)' }}
          onClick={() =>
            openFiles({ kind: 'shared', showId: ask.share ?? undefined })
          }
        >
          Open what it shared
        </button>
      )}
      {hasOptions && (
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
              onClick={() => setChoice(choice === index ? null : index)}
            >
              <b aria-hidden="true">{index + 1}</b>
              <span className="min-w-0 flex-1">{option}</span>
              {ask.recommended === index && <em>recommended</em>}
            </button>
          ))}
        </div>
      )}
      {wantsFiles && <AskFilesBlock files={files} disabled={reply.isPending} />}
      {route && (
        <p
          data-testid="answer-route"
          className="mb-1.5 truncate text-[12px]"
          style={{ color: 'var(--mist)' }}
          title={`${route.text}. ${route.detail}`}
        >
          {route.text}
        </p>
      )}
      <form
        className="lantern-ask-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (!canSend) return
          const picked = choice !== null ? ask.options[choice] : undefined
          const ids = files.saved.map((item) => item.capture?.id as string)
          send(
            {
              kind: 'answer',
              ...(choice !== null ? { option: choice } : {}),
              ...(noteText ? { note: noteText } : {}),
              ...(ids.length ? { files: ids } : {}),
            },
            [
              picked,
              noteText && `“${noteText}”`,
              ids.length && plural(ids.length, 'file'),
            ]
              .filter(Boolean)
              .join(', '),
          )
        }}
      >
        {!app && (
          <label className="lantern-field lantern-ask-note min-w-0 flex-1 px-2">
            <span className="sr-only">
              {hasOptions ? 'Note to the agent' : 'Reply to the agent'}
            </span>
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder={
                hasOptions
                  ? 'Optional note to the agent…'
                  : 'Reply to the agent…'
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
      <div className="lantern-ask-actions">
        {app && !hasOptions && (
          <button
            type="button"
            className="lantern-btn primary small"
            disabled={reply.isPending || away}
            title={waitTitle}
            onClick={() => send({ kind: 'answer', text: 'Done' }, 'Done')}
          >
            Done
          </button>
        )}
        {app && link && (
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
          <OpenSession sessionId={asker.sessionId} onOpen={onOpenSession} />
        )}
        {!app && !hasOptions && !wantsFiles && (
          <button
            type="button"
            className="lantern-btn small"
            disabled={reply.isPending || away}
            onClick={() => send({ kind: 'answer', text: 'Done' }, 'Done')}
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
            disabled={reply.isPending || away}
            onClick={() =>
              send(
                {
                  kind: 'answer',
                  text: 'Not now',
                  // A decline is the one answer a files ask takes without its files.
                  ...(wantsFiles ? { skippedFiles: true } : {}),
                },
                'Not now',
              )
            }
            title={
              waitTitle ??
              'Sends the agent “Not now”; the question counts as answered, and it moves on'
            }
          >
            Not now
          </button>
        )}
      </div>
      {reply.isError && (
        <p
          role="alert"
          className="mt-1.5 text-[12px]"
          style={{ color: 'var(--ember)' }}
        >
          {reply.error.message}
        </p>
      )}
    </Item>
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
