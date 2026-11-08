'use client'

import { maskSecrets } from '@aico/shared/secrets'
import { ago } from '@aico/shared/time'
import { Download, ExternalLink, Trash2 } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import {
  type Capture,
  captureFileUrl,
  capturePreviewUrl,
  extractedItems,
  type RouteAction,
} from '@/lib/api/captures'
import { noteHref } from '@/lib/api/notes'
import {
  formatBytes,
  formatClock,
  formatWhen,
  statusWord,
} from '@/lib/capture-format'
import {
  useCapture,
  useDeleteCapture,
  useRetryCapture,
  useRouteCapture,
  useSaveCaption,
} from '@/lib/hooks/use-captures'
import { useNote } from '@/lib/hooks/use-notes'
import { ConfirmationDialog } from '../ConfirmationDialog'
import { CaptureThumb } from './CaptureThumb'

function Preview({ capture }: { capture: Capture }) {
  const [failed, setFailed] = useState(false)
  if (capture.kind === 'image' && capture.previewState === 'ready' && !failed)
    return (
      // biome-ignore lint/performance/noImgElement: the saved picture, served by aico-web
      <img
        src={capturePreviewUrl(capture.id)}
        alt={capture.caption || capture.name}
        data-testid="capture-preview"
        className="max-h-[60dvh] w-full rounded-lg object-contain"
        style={{ background: 'var(--paper)' }}
        onError={() => setFailed(true)}
      />
    )
  let note: string | null = null
  if (capture.hasFile === false) note = null
  else if (capture.kind === 'image') {
    if (failed) note = "Your browser couldn't show this picture."
    else if (capture.previewState === 'pending') note = 'Making a preview…'
    else note = "Aico couldn't make a preview of this picture."
  }
  return (
    <div className="flex items-center gap-3">
      <CaptureThumb capture={capture} size={72} />
      {note && (
        <p
          className="text-[13px]"
          style={{ color: 'var(--mist)' }}
          role="status"
        >
          {note}
        </p>
      )}
    </div>
  )
}

function Fact({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <>
      <dt style={{ color: 'var(--mist)' }}>{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  )
}

/** Where the reading stands: waiting, in progress (since when), couldn't read
 * (with Retry), or read with nothing to show. */
function ReadingState({ capture }: { capture: Capture }) {
  const retry = useRetryCapture()
  if (capture.status === 'new')
    return (
      <p
        role="status"
        data-testid="capture-reading"
        className="text-[13px]"
        style={{ color: 'var(--mist)' }}
      >
        Waiting to be read…
      </p>
    )
  if (capture.status === 'extracting')
    return (
      <p
        role="status"
        data-testid="capture-reading"
        className="text-[13px]"
        style={{ color: 'var(--mist)' }}
      >
        Reading since {formatClock(capture.updatedAt)}…
      </p>
    )
  if (capture.status === 'failed')
    return (
      <div
        role="status"
        data-testid="capture-unread"
        className="flex flex-col gap-1 text-[13px]"
      >
        <p style={{ color: 'var(--term-error-text)' }}>
          Couldn&apos;t read it
          {capture.extractError ? `: ${capture.extractError}` : ''}.
        </p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="lantern-btn min-h-11"
            disabled={retry.isPending}
            onClick={() => retry.mutate(capture.id)}
          >
            {retry.isPending ? 'Starting…' : 'Retry'}
          </button>
          {retry.isError && (
            <span style={{ color: 'var(--term-error-text)' }}>
              {retry.error.message}
            </span>
          )}
        </div>
      </div>
    )
  if (capture.status === 'ready' && !capture.text)
    return (
      <p
        role="status"
        data-testid="capture-nothing"
        className="text-[13px]"
        style={{ color: 'var(--mist)' }}
      >
        Nothing was read from this file.
      </p>
    )
  return null
}

/** Where the capture is on its way to an owner: the suggestion with its
 * three choices, or waiting, failed or filed. Nothing for an owner Aico has no
 * adapter for beyond the plain reason it stays here. */
function RouteBlock({ capture }: { capture: Capture }) {
  const route = capture.route
  const act = useRouteCapture()
  if (!route || route.state === 'kept') return null
  if (route.state === 'confirmed')
    return (
      <p
        role="status"
        data-testid="capture-route"
        className="text-[13px]"
        style={{ color: 'var(--mist)' }}
      >
        Sending to {route.ownerLabel ?? 'the owner'}…
      </p>
    )
  const owner = route.ownerLabel ?? 'the owner'
  const choose = (action: RouteAction) => act.mutate({ id: capture.id, action })
  const buttons = (send: string | null) => (
    <div className="flex flex-wrap items-center gap-2">
      {send && route.canSend && (
        <button
          type="button"
          className="lantern-btn primary min-h-11"
          disabled={act.isPending}
          onClick={() => choose('send')}
        >
          {act.isPending ? 'Sending…' : send}
        </button>
      )}
      {route.state === 'suggested' && route.canSend && (
        <button
          type="button"
          className="lantern-btn min-h-11"
          disabled={act.isPending}
          onClick={() => choose('not_this')}
        >
          {route.notLabel ?? 'Not this'}
        </button>
      )}
      {route.state !== 'filed' && route.canSend && (
        <button
          type="button"
          className="lantern-btn min-h-11"
          disabled={act.isPending}
          onClick={() => choose('keep')}
        >
          Keep here
        </button>
      )}
    </div>
  )
  const error = act.isError ? (
    <p className="text-[12px]" style={{ color: 'var(--term-error-text)' }}>
      {act.error.message}
    </p>
  ) : null
  const box = (tone: string, children: React.ReactNode) => (
    <section
      aria-label="Where this goes"
      data-testid="capture-route"
      className="flex flex-col gap-2 rounded-lg p-3 text-[13px]"
      style={{ background: 'var(--paper)', border: `1px solid ${tone}` }}
    >
      {children}
    </section>
  )

  if (route.state === 'suggested')
    return box(
      'var(--paper-veil)',
      <>
        <p style={{ color: 'var(--bone)' }}>
          {route.canSend
            ? (route.question ?? `Send to ${owner}?`)
            : `Looks like ${(capture.type ?? 'this').replace(/_/g, ' ')}.`}
        </p>
        {route.note && <p style={{ color: 'var(--mist)' }}>{route.note}</p>}
        {route.canSend && buttons('Send')}
        {error}
      </>,
    )
  if (route.state === 'waiting')
    return box(
      'var(--beacon)',
      <>
        <p role="status" style={{ color: 'var(--beacon)' }}>
          Waiting for {owner}
          {route.note ? `. ${route.note}` : ''}.
        </p>
        <p style={{ color: 'var(--mist)' }}>
          Aico sends it when {owner} answers. Aico keeps the photo until then.
        </p>
        {buttons('Send now')}
        {error}
      </>,
    )
  if (route.state === 'failed')
    return box(
      'var(--term-error-text)',
      <>
        <p role="status" style={{ color: 'var(--term-error-text)' }}>
          Couldn&apos;t send it to {owner}
          {route.note ? `: ${route.note}` : ''}.
        </p>
        {buttons('Try again')}
        {error}
      </>,
    )
  return box(
    'var(--paper-veil)',
    <>
      {route.owner === 'notes' && route.ownerRef ? (
        <FiledInNotes noteId={route.ownerRef} />
      ) : (
        <p style={{ color: 'var(--bone)' }}>
          Sent to {owner}.
          {capture.hasFile === false ? ' Aico no longer keeps the file.' : ''}
        </p>
      )}
      {route.url && (
        <a
          className="lantern-btn min-h-11 self-start"
          href={route.url}
          target="_blank"
          rel="noreferrer"
        >
          <ExternalLink
            className="h-4 w-4"
            strokeWidth={1.7}
            aria-hidden="true"
          />
          Open in {owner}
        </a>
      )}
    </>,
  )
}

/** A capture the router filed into Notes: the note it went to, as a link. */
function FiledInNotes({ noteId }: { noteId: string }) {
  const { note } = useNote(noteId)
  return (
    <p style={{ color: 'var(--bone)' }}>
      Filed in Notes:{' '}
      <Link
        href={noteHref(noteId)}
        data-testid="filed-note-link"
        className="inline-flex min-h-11 items-center underline underline-offset-2"
        style={{ color: 'var(--lantern)' }}
      >
        {note ? maskSecrets(note.title) || 'Untitled' : 'Open the note'}
      </Link>
    </p>
  )
}

function ListItems({ capture }: { capture: Capture }) {
  const items = extractedItems(capture)
  if (!items.length) return null
  return (
    <section aria-label="List items" className="flex flex-col gap-1">
      <h2 className="lantern-sec">List items</h2>
      <ul
        className="flex flex-col gap-1 text-[14px]"
        data-testid="capture-items"
      >
        {items.map((entry, index) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: a read-only list in reading order
            key={index}
            className="flex flex-wrap items-baseline gap-x-2"
            style={{ textDecoration: entry.struck ? 'line-through' : 'none' }}
          >
            <span>{entry.item || entry.as_written}</span>
            {entry.quantity ? (
              <span style={{ color: 'var(--mist)' }}>× {entry.quantity}</span>
            ) : null}
            {entry.as_written && entry.as_written !== entry.item ? (
              <span className="text-[12px]" style={{ color: 'var(--mist)' }}>
                written: {entry.as_written}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  )
}

function Detail({ capture }: { capture: Capture }) {
  const router = useRouter()
  const save = useSaveCaption()
  const remove = useDeleteCapture()
  const [caption, setCaption] = useState(capture.caption)
  const [confirming, setConfirming] = useState(false)
  // A caption saved or changed elsewhere replaces an untouched draft.
  const [seen, setSeen] = useState(capture.caption)
  useEffect(() => {
    if (capture.caption !== seen) {
      if (caption === seen) setCaption(capture.caption)
      setSeen(capture.caption)
    }
  }, [capture.caption, seen, caption])
  const dirty = caption !== capture.caption

  return (
    <div className="flex flex-col gap-4" data-testid="capture-detail">
      <Preview capture={capture} />

      <ReadingState capture={capture} />

      <RouteBlock capture={capture} />

      {capture.needsCheck &&
      (capture.text || extractedItems(capture).length) ? (
        <p
          role="note"
          data-testid="capture-check"
          className="text-[13px]"
          style={{ color: 'var(--beacon)' }}
        >
          Check this: the backup reader (a small model on this computer) read
          it, so compare it with the picture.
        </p>
      ) : null}

      <ListItems capture={capture} />

      {capture.text ? (
        <section
          aria-label="Text from the file"
          className="flex flex-col gap-1"
        >
          <h2 className="lantern-sec">Text from the file</h2>
          <pre
            className="max-h-[40dvh] overflow-auto whitespace-pre-wrap rounded-md p-3 text-[12px]"
            style={{
              background: 'var(--paper)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {capture.text}
          </pre>
        </section>
      ) : null}

      <div className="flex flex-col gap-1">
        <label
          htmlFor="capture-caption"
          className="text-[12px]"
          style={{ color: 'var(--mist)' }}
        >
          Caption
        </label>
        <textarea
          id="capture-caption"
          rows={3}
          maxLength={4000}
          value={caption}
          onChange={(event) => setCaption(event.target.value)}
          className="w-full resize-none rounded-md px-3 py-2 text-[14px] outline-none focus-visible:border-[var(--lantern)]"
          style={{
            background: 'rgb(var(--ink-rgb) / 0.86)',
            border: '1px solid var(--paper-veil)',
            color: 'var(--bone)',
          }}
        />
        <div className="flex items-center gap-3">
          <p
            role="status"
            className="min-w-0 flex-1 text-[12px]"
            style={{
              color: save.isError ? 'var(--term-error-text)' : 'var(--mist)',
            }}
          >
            {save.isError
              ? save.error.message
              : save.isSuccess && !dirty
                ? 'Saved'
                : ''}
          </p>
          <button
            type="button"
            className="lantern-btn primary min-h-11"
            disabled={!dirty || save.isPending}
            onClick={() => save.mutate({ id: capture.id, caption })}
          >
            {save.isPending ? 'Saving…' : 'Save caption'}
          </button>
        </div>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
        <Fact label="File">{capture.name}</Fact>
        <Fact label="Size">{formatBytes(capture.size)}</Fact>
        <Fact label="Type">{capture.mime}</Fact>
        <Fact label="Sent">{formatWhen(capture.createdAt)}</Fact>
        <Fact label="Status">{statusWord(capture.status)}</Fact>
      </dl>

      <div className="flex flex-wrap gap-2">
        {capture.hasFile !== false && (
          <a
            className="lantern-btn min-h-11"
            href={captureFileUrl(capture.id)}
            download={capture.name}
          >
            <Download
              className="h-4 w-4"
              strokeWidth={1.7}
              aria-hidden="true"
            />
            Download
          </a>
        )}
        <button
          type="button"
          className="lantern-btn min-h-11"
          style={{ color: 'var(--term-error-text)' }}
          onClick={() => setConfirming(true)}
        >
          <Trash2 className="h-4 w-4" strokeWidth={1.7} aria-hidden="true" />
          Delete
        </button>
      </div>

      <ConfirmationDialog
        isOpen={confirming}
        title="Delete this capture?"
        message={`${capture.caption || capture.name} will be removed from your list.`}
        confirmText="Delete"
        pendingText="Deleting…"
        isPending={remove.isPending}
        error={remove.isError ? remove.error.message : null}
        onCancel={() => setConfirming(false)}
        onConfirm={() =>
          remove.mutate(capture.id, {
            onSuccess: () => router.replace('/captures'),
          })
        }
      />
    </div>
  )
}

/** One capture: the picture or an icon, its caption (editable), facts, and
 * the text read from it once there is some. */
export function CaptureDetail({ id }: { id: string }) {
  const view = useCapture(id)
  if (view.isLoading)
    return (
      <p
        role="status"
        className="py-3 text-[13px]"
        style={{ color: 'var(--mist)' }}
      >
        Loading capture…
      </p>
    )
  if (view.gone)
    return (
      <p
        role="status"
        data-testid="capture-gone"
        className="py-3 text-[13px]"
        style={{ color: 'var(--mist)' }}
      >
        That capture is gone. It may have been deleted.
      </p>
    )
  if (view.isError || !view.capture)
    return (
      <p
        role="status"
        data-testid="capture-failed"
        className="py-3 text-[13px]"
        style={{ color: 'var(--mist)' }}
      >
        Couldn&apos;t load this capture{view.error ? `: ${view.error}` : ''}.{' '}
        <button
          type="button"
          className="inline-flex min-h-11 items-center underline underline-offset-2 md:min-h-0"
          style={{ color: 'var(--lantern)' }}
          onClick={view.refetch}
        >
          Try again
        </button>
      </p>
    )
  return (
    <>
      {view.isStale && (
        <p
          role="status"
          data-testid="capture-stale"
          className="pb-3 text-[13px]"
          style={{ color: 'var(--beacon)' }}
        >
          Couldn&apos;t refresh. This is from {ago(view.updatedAt, Date.now())}.{' '}
          <button
            type="button"
            className="inline-flex min-h-11 items-center underline underline-offset-2 md:min-h-0"
            style={{ color: 'var(--lantern)' }}
            onClick={view.refetch}
          >
            Try again
          </button>
        </p>
      )}
      <Detail capture={view.capture} />
    </>
  )
}
