'use client'

import {
  Archive,
  ArchiveRestore,
  History,
  Pin,
  PinOff,
  Trash2,
  X,
} from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import type { NoteDetail, NoteKind, NotePatch } from '@/lib/api/notes'
import { formatAge } from '@/lib/attention'
import { formatWhen } from '@/lib/capture-format'
import { type SaveState, useAutosave } from '@/lib/hooks/use-autosave'
import { useDeleteNote, useNote, useNoteActions } from '@/lib/hooks/use-notes'
import { ConfirmationDialog } from '../ConfirmationDialog'
import { NoteAttachments } from './NoteAttachments'
import { NoteHistory } from './NoteHistory'
import { type NoteActions, NoteItems } from './NoteItems'

const MUTED = { color: 'var(--mist)' } as const

const SAVE_WORDS: Record<SaveState, string> = {
  saved: 'Saved',
  dirty: 'Saving…',
  saving: 'Saving…',
  error: "Couldn't save.",
}

export function SaveStatus({
  state,
  onRetry,
}: {
  state: SaveState
  onRetry: () => void
}) {
  return (
    <p
      role="status"
      data-testid="note-save-state"
      data-state={state}
      className="min-w-0 flex-1 text-[12px]"
      style={{
        color: state === 'error' ? 'var(--term-error-text)' : 'var(--mist)',
      }}
    >
      {SAVE_WORDS[state]}
      {state === 'error' && (
        <>
          {' '}
          <button
            type="button"
            className="inline-flex min-h-11 items-center underline underline-offset-2"
            style={{ color: 'var(--lantern)' }}
            onClick={onRetry}
          >
            Retry
          </button>
        </>
      )}
    </p>
  )
}

function Labels({
  note,
  actions,
  onError,
}: {
  note: NoteDetail
  actions: NoteActions
  onError: (message: string) => void
}) {
  const [text, setText] = useState('')
  const set = (labels: string[]) =>
    void actions
      .setLabels(labels)
      .catch((error) =>
        onError(
          error instanceof Error ? error.message : "Couldn't save the labels",
        ),
      )
  const add = () => {
    const label = text.trim()
    if (!label) return
    setText('')
    if (!note.labels.some((have) => have.toLowerCase() === label.toLowerCase()))
      set([...note.labels, label])
  }
  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      data-testid="note-labels"
    >
      {note.labels.map((label) => (
        <span
          key={label}
          className="inline-flex items-center gap-1 rounded-full py-px pr-1 pl-2.5 text-[12px]"
          style={{ background: 'var(--paper-veil)', color: 'var(--bone)' }}
        >
          {label}
          <button
            type="button"
            className="grid h-6 w-6 place-items-center"
            aria-label={`Remove label ${label}`}
            onClick={() => set(note.labels.filter((have) => have !== label))}
          >
            <X className="h-3 w-3" strokeWidth={2} />
          </button>
        </span>
      ))}
      <input
        type="text"
        aria-label="Add a label"
        placeholder="Add a label"
        maxLength={40}
        className="min-h-9 w-32 min-w-0 bg-transparent px-1 text-[13px] outline-none focus-visible:underline"
        style={{ color: 'var(--bone)' }}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
          event.preventDefault()
          add()
        }}
        onBlur={add}
      />
    </div>
  )
}

function Editor({
  id,
  note,
  stale,
}: {
  id: string
  note: NoteDetail
  stale: string | null
}) {
  const router = useRouter()
  const actions = useNoteActions(id)
  const remove = useDeleteNote()
  const [history, setHistory] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bodyBox = useRef<HTMLTextAreaElement>(null)

  const auto = useAutosave({
    base: { title: note.title, body: note.body },
    save: (patch) => actions.save(patch),
  })
  const { draft } = auto

  // The text box grows with its text.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the text changes
  useEffect(() => {
    const box = bodyBox.current
    if (!box) return
    box.style.height = 'auto'
    box.style.height = `${box.scrollHeight}px`
  }, [draft.body])

  const change = (patch: NotePatch) => {
    setError(null)
    void actions
      .save(patch)
      .catch((failure) =>
        setError(
          failure instanceof Error ? failure.message : "Couldn't save that",
        ),
      )
  }

  const isList = note.kind === 'list'
  const showItems = isList || note.items.length > 0
  const showBody = !isList || draft.body !== ''
  const kinds: [NoteKind, string][] = [
    ['note', 'Note'],
    ['list', 'List'],
  ]

  return (
    <div className="flex flex-col gap-3" data-testid="note-editor">
      {stale && (
        <p
          role="status"
          data-testid="note-stale"
          className="text-[13px]"
          style={{ color: 'var(--beacon)' }}
        >
          {stale}
        </p>
      )}
      <div className="flex items-center gap-1">
        <SaveStatus state={auto.state} onRetry={auto.retry} />
        <button
          type="button"
          className="lantern-icon-btn"
          aria-pressed={note.pinned}
          aria-label={note.pinned ? 'Unpin' : 'Pin to the top'}
          title={note.pinned ? 'Unpin' : 'Pin to the top'}
          onClick={() => change({ pinned: !note.pinned })}
          style={note.pinned ? { color: 'var(--lantern)' } : undefined}
        >
          {note.pinned ? (
            <PinOff className="h-[18px] w-[18px]" strokeWidth={1.7} />
          ) : (
            <Pin className="h-[18px] w-[18px]" strokeWidth={1.7} />
          )}
        </button>
        <button
          type="button"
          className="lantern-icon-btn"
          aria-label="History"
          title="History"
          onClick={() => setHistory(true)}
        >
          <History className="h-[18px] w-[18px]" strokeWidth={1.7} />
        </button>
        <button
          type="button"
          className="lantern-icon-btn"
          aria-label={note.archived ? 'Unarchive' : 'Archive'}
          title={note.archived ? 'Unarchive' : 'Archive'}
          onClick={() => change({ archived: !note.archived })}
        >
          {note.archived ? (
            <ArchiveRestore className="h-[18px] w-[18px]" strokeWidth={1.7} />
          ) : (
            <Archive className="h-[18px] w-[18px]" strokeWidth={1.7} />
          )}
        </button>
        <button
          type="button"
          className="lantern-icon-btn"
          aria-label="Delete"
          title="Delete"
          style={{ color: 'var(--term-error-text)' }}
          onClick={() => setConfirming(true)}
        >
          <Trash2 className="h-[18px] w-[18px]" strokeWidth={1.7} />
        </button>
      </div>

      {note.archived && (
        <p
          role="status"
          className="text-[13px]"
          style={{ color: 'var(--beacon)' }}
        >
          Archived. It stays out of the main list.
        </p>
      )}

      <input
        type="text"
        aria-label="Title"
        placeholder="Title"
        maxLength={500}
        className="w-full bg-transparent py-1 outline-none placeholder:text-[var(--mist)]"
        style={{
          font: '500 22px/1.25 var(--font-display)',
          color: 'var(--bone)',
        }}
        value={draft.title}
        onChange={(event) => auto.edit({ title: event.target.value })}
      />

      <div className="flex items-center gap-2" role="group" aria-label="Kind">
        {kinds.map(([kind, label]) => (
          <button
            key={kind}
            type="button"
            className="lantern-btn small min-h-9"
            aria-pressed={note.kind === kind}
            onClick={() => note.kind !== kind && change({ kind })}
          >
            {label}
          </button>
        ))}
      </div>

      <Labels note={note} actions={actions} onError={setError} />

      {showBody && (
        <textarea
          ref={bodyBox}
          aria-label="Text"
          placeholder={isList ? 'Text' : 'Write a note'}
          rows={isList ? 2 : 6}
          maxLength={200000}
          className="w-full resize-none bg-transparent py-1 text-[15px] leading-relaxed outline-none placeholder:text-[var(--mist)]"
          style={{ color: 'var(--bone)' }}
          value={draft.body}
          onChange={(event) => auto.edit({ body: event.target.value })}
        />
      )}

      {showItems && <NoteItems note={note} actions={actions} />}

      <NoteAttachments
        noteId={id}
        attachments={note.attachments}
        onChanged={actions.refresh}
      />

      {error && (
        <p
          role="alert"
          className="text-[12px]"
          style={{ color: 'var(--term-error-text)' }}
        >
          {error}
        </p>
      )}
      <p className="text-[12px]" style={MUTED}>
        Edited {formatWhen(note.editedAt)}
      </p>

      {history && (
        <NoteHistory
          noteId={id}
          onOpenChange={setHistory}
          onRestore={(field, text) => auto.edit({ [field]: text })}
        />
      )}
      <ConfirmationDialog
        isOpen={confirming}
        title="Delete this note?"
        message={`${note.title || 'This note'} will be removed, with its items. Its photos stay in Captures.`}
        confirmText="Delete"
        pendingText="Deleting…"
        isPending={remove.isPending}
        error={remove.isError ? remove.error.message : null}
        onCancel={() => setConfirming(false)}
        onConfirm={() =>
          remove.mutate(note.id, { onSuccess: () => router.replace('/notes') })
        }
      />
    </div>
  )
}

/** One note: loading, gone, failed and stale states around the editor. */
export function NoteEditor({ id }: { id: string }) {
  const view = useNote(id)
  if (view.isLoading)
    return (
      <p role="status" className="py-3 text-[13px]" style={MUTED}>
        Loading note…
      </p>
    )
  if (view.gone)
    return (
      <p
        role="status"
        data-testid="note-gone"
        className="py-3 text-[13px]"
        style={MUTED}
      >
        That note is gone. It may have been deleted.{' '}
        <Link
          href="/notes"
          className="underline underline-offset-2"
          style={{ color: 'var(--lantern)' }}
        >
          Back to notes
        </Link>
      </p>
    )
  if (view.isError || !view.note)
    return (
      <p
        role="status"
        data-testid="note-failed"
        className="py-3 text-[13px]"
        style={MUTED}
      >
        Couldn&apos;t load this note{view.error ? `: ${view.error}` : ''}.{' '}
        <button
          type="button"
          className="inline-flex min-h-11 items-center underline underline-offset-2"
          style={{ color: 'var(--lantern)' }}
          onClick={view.refetch}
        >
          Try again
        </button>
      </p>
    )
  return (
    <Editor
      id={id}
      note={view.note}
      stale={
        view.isStale
          ? `Couldn't refresh. This is from ${formatAge(Date.now() - view.updatedAt)} ago.`
          : null
      }
    />
  )
}
