'use client'

import { useState } from 'react'
import { dropAskCaptureQueue } from '@/lib/capture-queue'
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
import { AskFilesBlock, addMoreText, useAskFiles } from './AskFiles'
import {
  AskActions,
  AskChoices,
  AskForm,
  AskHead,
  answerRoute,
  isAppAsk,
  openLink,
  workbenchPath,
} from './ask-card-parts'
import { useAsker, useSessionName } from './ask-shared'

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

  const submit = () => {
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
  }

  const Item = inSession ? 'div' : 'li'
  return (
    <Item
      data-testid="ask-card"
      className={inSession ? undefined : 'lantern-ask'}
      data-blocking={ask.blocking ? 'true' : undefined}
    >
      <AskHead
        ask={ask}
        asker={asker}
        now={now}
        inSession={inSession}
        compact={compact}
        linkAway={linkAway}
        onOpenFile={onOpenFile}
      />
      {hasOptions && (
        <AskChoices ask={ask} choice={choice} onChoose={setChoice} />
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
      <AskForm
        app={app}
        hasOptions={hasOptions}
        note={note}
        canSend={canSend}
        waitTitle={waitTitle}
        sendLabel={sendLabel}
        onNote={setNote}
        onSubmit={submit}
      />
      <AskActions
        app={app}
        hasOptions={hasOptions}
        wantsFiles={wantsFiles}
        inSession={inSession}
        link={link}
        workbench={workbenchPath(ask)}
        sessionId={asker.sessionId}
        busy={reply.isPending || away}
        waitTitle={waitTitle}
        onOpenSession={onOpenSession}
        onSend={send}
      />
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
