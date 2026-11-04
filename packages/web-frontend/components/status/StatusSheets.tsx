'use client'

import * as Dialog from '@radix-ui/react-dialog'
import { useQuery } from '@tanstack/react-query'
import { clsx } from 'clsx'
import { Copy, X } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { apiFetch } from '@/lib/api-fetch'
import { lookMessage, type StatusRow } from '@/lib/status'

/** A Status sheet: a bottom sheet on the phone, a side panel or a centred dialog on a desktop. */
export function StatusSheet({
  open,
  onOpenChange,
  title,
  place,
  children,
  foot,
  testId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  place: 'bottom' | 'side' | 'center'
  children: ReactNode
  foot?: ReactNode
  testId?: string
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-[10000]"
          style={{ backgroundColor: 'var(--scrim)' }}
        />
        <Dialog.Content
          data-testid={testId}
          aria-describedby={undefined}
          className={clsx(
            'lantern-sheet status-sheet z-[10001] outline-none',
            place,
          )}
        >
          {place === 'bottom' && <div className="grab" aria-hidden="true" />}
          <header>
            <Dialog.Title asChild>
              <h2>{title}</h2>
            </Dialog.Title>
            <Dialog.Close className="lantern-icon-btn" aria-label="Close">
              <X className="h-[18px] w-[18px]" strokeWidth={1.7} />
            </Dialog.Close>
          </header>
          <div className="body">{children}</div>
          {foot && <div className="foot">{foot}</div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

interface LogAnswer {
  ref: string
  machine: string
  ok: boolean
  /** Still printing when the server stopped it (10 s): the lines are what it printed by then. */
  truncated?: boolean
  lines: string[]
}

/** The last lines the row's log command prints, read on this machine. */
export function LogSheet({
  row,
  place,
  onClose,
}: {
  row: StatusRow
  place: 'bottom' | 'side'
  onClose: () => void
}) {
  const ref = row.actions?.find((action) => action.kind === 'log')?.ref ?? ''
  const [copied, setCopied] = useState(false)
  const log = useQuery({
    queryKey: ['status-log', row.id],
    queryFn: () =>
      apiFetch<LogAnswer>(
        '/api/status/log',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: row.id }),
        },
        'Couldn’t read the log',
      ),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  })
  return (
    <StatusSheet
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Log · ${row.what}`}
      place={place}
      testId="status-log"
      foot={
        <button
          type="button"
          className="lantern-btn ghost small"
          onClick={() => {
            void navigator.clipboard?.writeText(ref).then(() => setCopied(true))
          }}
        >
          <Copy className="h-3.5 w-3.5" strokeWidth={1.7} aria-hidden="true" />
          {copied ? 'Copied' : 'Copy command'}
        </button>
      }
    >
      <p className="status-sheet-note">
        Last lines on {row.machine}, from <span className="mono">{ref}</span>
      </p>
      {log.isPending ? (
        <p className="status-sheet-note">Reading the log…</p>
      ) : log.isError ? (
        <p className="status-sheet-note" role="alert">
          Couldn’t read the log: {(log.error as Error).message}
        </p>
      ) : log.data.lines.length === 0 ? (
        <p className="status-sheet-note">
          {log.data.truncated
            ? 'The command printed nothing in 10 seconds, so it was stopped.'
            : 'The command printed nothing.'}
        </p>
      ) : (
        <>
          {log.data.truncated ? (
            <p className="status-sheet-note" role="alert">
              Cut off: the command was still printing after 10 seconds. These
              are the last lines it printed by then, which may not be the
              newest.
            </p>
          ) : (
            !log.data.ok && (
              <p className="status-sheet-note" role="alert">
                The command ended with an error; its last lines:
              </p>
            )
          )}
          <pre>{log.data.lines.join('\n')}</pre>
        </>
      )}
    </StatusSheet>
  )
}

/** Look into it: starts a session about the row with an editable first message. */
export function LookSheet({
  row,
  project,
  place,
  onClose,
  onStarted,
}: {
  row: StatusRow
  project: string
  place: 'bottom' | 'center'
  onClose: () => void
  onStarted: (session: string | null) => void
}) {
  const [message, setMessage] = useState(() => lookMessage(row))
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const start = async () => {
    setStarting(true)
    setError(null)
    try {
      const answer = await apiFetch<{ session: string | null }>(
        '/api/status/look',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: row.id, message, project }),
        },
        'Couldn’t start the session',
      )
      onStarted(answer.session)
    } catch (failure) {
      setStarting(false)
      setError((failure as Error).message)
    }
  }
  return (
    <StatusSheet
      open
      onOpenChange={(open) => !open && onClose()}
      title="Look into it"
      place={place}
      testId="status-look"
      foot={
        <>
          <button type="button" className="lantern-btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="lantern-btn primary"
            disabled={starting || !message.trim()}
            onClick={() => void start()}
          >
            {starting ? 'Starting…' : 'Start session'}
          </button>
        </>
      }
    >
      <p className="status-sheet-lead">
        Starts a session in <b>{project}</b>, with this as its first message:
      </p>
      <textarea
        aria-label="First message"
        value={message}
        onChange={(event) => setMessage(event.target.value)}
      />
      <p className="status-sheet-note">
        The message names this row. You can change it first.
      </p>
      {error && (
        <p
          className="status-sheet-note"
          role="alert"
          style={{ color: 'var(--term-error-text)' }}
        >
          {error}
        </p>
      )}
    </StatusSheet>
  )
}
