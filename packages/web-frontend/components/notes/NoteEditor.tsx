'use client'

import { ago } from '@aico/shared/time'
import { useQueryClient } from '@tanstack/react-query'
import { clsx } from 'clsx'
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
import {
  createNote,
  deleteNote,
  type NoteDetail,
  type NoteKind,
  type NotePatch,
  notesHref,
} from '@/lib/api/notes'
import { formatWhen } from '@/lib/capture-format'
import { type SaveState, useAutosave } from '@/lib/hooks/use-autosave'
import {
  type EnsureNote,
  NOTES_KEY,
  useDeleteNote,
  useNote,
  useNoteActions,
} from '@/lib/hooks/use-notes'
import { ConfirmationDialog } from '../ConfirmationDialog'
import { NoteAttachments } from './NoteAttachments'
import { NoteHistory } from './NoteHistory'
import { type NoteActions, NoteItems } from './NoteItems'
import { NoteReminder } from './NoteReminder'
import { ProjectPicker } from './NoteScope'

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

/** Nothing in it at all: a New note opened and left. Lists you keep (Groceries)
 * have a source and are never left out this way. */
export function isBlankNote(
  note: NoteDetail,
  draft: { title: string; body: string },
): boolean {
  return (
    note.source === null &&
    !note.pinned &&
    draft.title.trim() === '' &&
    draft.body.trim() === '' &&
    note.items.length === 0 &&
    note.attachments.length === 0 &&
    note.labels.length === 0 &&
    note.remindAt === null
  )
}

/** Deletes waiting one tick, so a remount of the same note (React's dev
 * double mount) cancels them. */
const blankDeletes = new Map<string, ReturnType<typeof setTimeout>>()

/** Notes opened in another window: leaving them here must not delete them
 * as blank, since the other window has them open now. */
const handedOff = new Set<string>()
export const handOffNote = (id: string) => void handedOff.add(id)

/** Keys for the note screen: a New note keeps its key once it is made (and
 * its link becomes the note's), so typing goes on in the same boxes. */
let draftSerial = 0
const madeFromDraft = new Map<string, string>()
export const noteScreenKey = (id: string | null) =>
  id === null ? `new-${draftSerial}` : (madeFromDraft.get(id) ?? id)

const counted = (n: number, word: string) =>
  n === 1 ? `its ${word}` : `its ${n} ${word}s`

/** What deleting takes with it and what stays, naming only what this note has. */
export function deleteWarning(note: NoteDetail): string {
  const own = note.attachments.filter((file) => !file.captureId).length
  const gone = [
    note.items.length ? counted(note.items.length, 'item') : '',
    own ? counted(own, 'file') : '',
  ].filter(Boolean)
  const kept = note.attachments.length > own
  return [
    `${note.title || 'This note'} will be removed`,
    gone.length ? `, with ${gone.join(' and ')},` : '',
    ' and can’t be brought back.',
    kept ? ' Photos and files from Captures stay there.' : '',
  ].join('')
}

function Editor({
  id,
  note,
  stale,
  ensure,
  onDraftKind,
  onDraftProject,
  listHref,
}: {
  /** null: a New note, made on its first change. */
  id: string | null
  note: NoteDetail
  stale: string | null
  ensure?: EnsureNote
  onDraftKind?: (kind: NoteKind) => void
  onDraftProject?: (project: string | null) => void
  /** Where Back and a deleted note go: the list, in the scope this note was opened from. */
  listHref: string
}) {
  const router = useRouter()
  const actions = useNoteActions(id, ensure)
  const draft = id === null
  const remove = useDeleteNote()
  const [history, setHistory] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bodyBox = useRef<HTMLTextAreaElement>(null)
  const editorBox = useRef<HTMLDivElement>(null)
  // A note just made starts with the cursor in its title.
  const [fresh] = useState(() => isBlankNote(note, note))

  // Set by Restore: the next save asks the server to keep what it replaces.
  const restoring = useRef(false)
  const auto = useAutosave({
    base: { title: note.title, body: note.body },
    save: (patch) => {
      const keepRevision = restoring.current
      restoring.current = false
      return actions.save(keepRevision ? { ...patch, keepRevision } : patch)
    },
  })
  const { draft: text } = auto
  const client = useQueryClient()

  // A note left with nothing in it is deleted, so New note then Back leaves
  // no untitled card behind.
  const latest = useRef({ note, draft: text })
  latest.current = { note, draft: text }
  useEffect(() => {
    if (id === null) return // a New note not made yet: nothing to remove
    clearTimeout(blankDeletes.get(id))
    blankDeletes.delete(id)
    return () => {
      const { note: last, draft: lastDraft } = latest.current
      if (handedOff.delete(id) || !isBlankNote(last, lastDraft)) return
      blankDeletes.set(
        id,
        setTimeout(() => {
          blankDeletes.delete(id)
          void deleteNote(id)
            .then(() => {
              client.removeQueries({ queryKey: [...NOTES_KEY, 'one', id] })
              return client.invalidateQueries({
                queryKey: [...NOTES_KEY, 'list'],
              })
            })
            .catch((failure) => console.warn('blank note not removed', failure))
        }, 0),
      )
    }
  }, [id, client])

  // The text box grows with its text.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the text changes
  useEffect(() => {
    const box = bodyBox.current
    if (!box) return
    box.style.height = 'auto'
    box.style.height = `${box.scrollHeight}px`
  }, [text.body])

  const change = (patch: NotePatch) => {
    setError(null)
    // A New note's kind is only a choice until something is in it.
    if (draft && onDraftKind && patch.kind && Object.keys(patch).length === 1)
      return onDraftKind(patch.kind)
    if (
      draft &&
      onDraftProject &&
      'project' in patch &&
      Object.keys(patch).length === 1
    )
      return onDraftProject(patch.project ?? null)
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
  const showBody = !isList || text.body !== ''
  const kinds: [NoteKind, string][] = [
    ['note', 'Note'],
    ['list', 'List'],
  ]

  return (
    <div
      ref={editorBox}
      className="flex flex-col gap-3"
      data-testid="note-editor"
    >
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
        {draft && auto.state === 'saved' ? (
          <p
            role="status"
            data-testid="note-save-state"
            data-state="new"
            className="min-h-11 min-w-0 flex-1 content-center text-[12px]"
            style={MUTED}
          >
            Saves once you type
          </p>
        ) : (
          <SaveStatus state={auto.state} onRetry={auto.retry} />
        )}
        {!draft && (
          <>
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
                <ArchiveRestore
                  className="h-[18px] w-[18px]"
                  strokeWidth={1.7}
                />
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
          </>
        )}
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
        // biome-ignore lint/a11y/noAutofocus: only a note just made, which the owner opened to type in
        autoFocus={fresh}
        value={text.title}
        onChange={(event) => auto.edit({ title: event.target.value })}
        onKeyDown={(event) => {
          // Enter goes on to the text, or to the add box of a list.
          if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
          event.preventDefault()
          const next = showBody
            ? bodyBox.current
            : editorBox.current?.querySelector<HTMLInputElement>(
                'input[aria-label="Add an item"]',
              )
          next?.focus()
        }}
      />

      <div className="flex items-center gap-2" role="group" aria-label="Kind">
        {kinds.map(([kind, label]) => (
          <button
            key={kind}
            type="button"
            className={clsx(
              'lantern-btn small min-h-9',
              note.kind === kind && 'primary',
            )}
            aria-pressed={note.kind === kind}
            onClick={() => note.kind !== kind && change({ kind })}
          >
            {label}
          </button>
        ))}
      </div>

      <ProjectPicker
        project={note.project}
        onChange={(project) => change({ project })}
      />

      <Labels note={note} actions={actions} onError={setError} />

      <NoteReminder
        key={note.remindAt === null ? 'none' : 'set'}
        remindAt={note.remindAt}
        remindedAt={note.remindedAt}
        onChange={(remindAt) => change({ remindAt })}
      />

      {showBody && (
        <textarea
          ref={bodyBox}
          aria-label="Text"
          placeholder={isList ? 'Text' : 'Write a note'}
          rows={isList ? 2 : 6}
          maxLength={200000}
          className="w-full resize-none bg-transparent py-1 text-[15px] leading-relaxed outline-none placeholder:text-[var(--mist)]"
          style={{ color: 'var(--bone)' }}
          value={text.body}
          onChange={(event) => auto.edit({ body: event.target.value })}
        />
      )}

      {showItems && <NoteItems note={note} actions={actions} />}

      <NoteAttachments
        noteId={id}
        ensureNote={actions.noteId}
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
      {!draft && (
        <p className="text-[12px]" style={MUTED}>
          Edited {formatWhen(note.editedAt)}
        </p>
      )}

      {history && id && (
        <NoteHistory
          noteId={id}
          onOpenChange={setHistory}
          onRestore={(field, text) => {
            restoring.current = true
            auto.edit({ [field]: text })
          }}
        />
      )}
      <ConfirmationDialog
        isOpen={confirming}
        title="Delete this note?"
        message={deleteWarning(note)}
        confirmText="Delete"
        pendingText="Deleting…"
        isPending={remove.isPending}
        error={remove.isError ? remove.error.message : null}
        onCancel={() => setConfirming(false)}
        onConfirm={() =>
          remove.mutate(note.id, {
            onSuccess: () => {
              handOffNote(note.id) // deleted already: leaving needs no blank delete
              router.replace(listHref)
            },
          })
        }
      />
    </div>
  )
}

/** A note screen with nothing saved yet: what the editor shows for a New note. */
const blankNote = (kind: NoteKind, project: string | null): NoteDetail => ({
  id: '',
  kind,
  project,
  title: '',
  pinned: false,
  archived: false,
  source: null,
  createdAt: 0,
  editedAt: 0,
  updatedAt: 0,
  labels: [],
  unchecked: 0,
  checked: 0,
  remindAt: null,
  remindedAt: null,
  body: '',
  items: [],
  attachments: [],
})

/** One note: loading, gone, failed and stale states around the editor. With
 * `id` null it is a New note of `kind`: nothing is saved until the first
 * keystroke, paste, label, item or photo, and leaving it empty leaves nothing. */
export function NoteEditor({
  id: given,
  kind: newKind = 'note',
  project: newProject = null,
  listHref = notesHref(),
  onMade,
}: {
  id: string | null
  kind?: NoteKind
  /** A New note starts in this project (the one Notes was opened for); the owner can change it. */
  project?: string | null
  /** The list Back returns to, keeping the scope it was opened in. */
  listHref?: string
  /** The New note was made: its link can become the note's. */
  onMade?: (id: string) => void
}) {
  const client = useQueryClient()
  const [made, setMade] = useState<string | null>(null)
  const [kind, setKind] = useState<NoteKind>(newKind)
  const id = given ?? made
  const making = useRef<Promise<string> | null>(null)
  const kindNow = useRef(kind)
  kindNow.current = kind
  const [project, setProject] = useState<string | null>(newProject)
  const projectNow = useRef(project)
  projectNow.current = project
  const onMadeNow = useRef(onMade)
  onMadeNow.current = onMade
  const shown = useRef(true)
  useEffect(() => {
    shown.current = true
    return () => {
      shown.current = false
    }
  }, [])

  const ensure: EnsureNote = async (seed = {}) => {
    if (making.current) return { id: await making.current, seeded: false }
    const key = draftSerial
    making.current = createNote({
      ...seed,
      kind: kindNow.current,
      ...(projectNow.current ? { project: projectNow.current } : {}),
    }).then((note) => {
      client.setQueryData([...NOTES_KEY, 'one', note.id], note)
      void client.invalidateQueries({ queryKey: [...NOTES_KEY, 'list'] })
      madeFromDraft.set(note.id, `new-${key}`)
      draftSerial = key + 1
      // Left already (Back while the first words were saving): stay gone.
      if (shown.current) {
        setMade(note.id)
        onMadeNow.current?.(note.id)
      }
      return note.id
    })
    making.current.catch(() => {
      making.current = null
    })
    return { id: await making.current, seeded: true }
  }

  const view = useNote(id)
  if (id === null)
    return (
      <Editor
        id={null}
        note={blankNote(kind, project)}
        stale={null}
        ensure={ensure}
        onDraftKind={setKind}
        onDraftProject={setProject}
        listHref={listHref}
      />
    )
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
          href={listHref}
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
      listHref={listHref}
      note={view.note}
      stale={
        view.isStale
          ? `Couldn't refresh. This is from ${ago(view.updatedAt, Date.now())}.`
          : null
      }
    />
  )
}
