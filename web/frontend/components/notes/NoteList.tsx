'use client'

import { clsx } from 'clsx'
import {
  Archive,
  ListChecks,
  Paperclip,
  Pin,
  Plus,
  Search,
  ShoppingBasket,
} from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import {
  createNote,
  GROCERIES_ID,
  GROCERIES_SOURCE,
  type NoteKind,
  type NoteSummary,
  noteHref,
} from '@/lib/api/notes'
import { formatAge } from '@/lib/attention'
import { useNotes } from '@/lib/hooks/use-notes'

const MUTED = { color: 'var(--mist)' } as const

function Message({
  children,
  tone = 'mist',
  testId,
}: {
  children: React.ReactNode
  tone?: 'mist' | 'beacon'
  testId?: string
}) {
  return (
    <p
      role="status"
      data-testid={testId}
      className="px-1 py-3 text-[13px]"
      style={{ color: tone === 'beacon' ? 'var(--beacon)' : 'var(--mist)' }}
    >
      {children}
    </p>
  )
}

const TextButton = ({
  onClick,
  children,
}: {
  onClick: () => void
  children: React.ReactNode
}) => (
  <button
    type="button"
    className="inline-flex min-h-11 items-center underline underline-offset-2 md:min-h-0"
    style={{ color: 'var(--lantern)' }}
    onClick={onClick}
  >
    {children}
  </button>
)

export const counts = (note: { unchecked: number; checked: number }) =>
  [
    note.unchecked > 0 ? `${note.unchecked} open` : null,
    note.checked > 0 ? `${note.checked} done` : null,
  ]
    .filter(Boolean)
    .join(' · ')

function Labels({ labels }: { labels: string[] }) {
  if (labels.length === 0) return null
  return (
    <span className="flex flex-wrap gap-1">
      {labels.map((label) => (
        <span
          key={label}
          className="rounded-full px-2 py-px text-[11px]"
          style={{ background: 'var(--paper-veil)', color: 'var(--mist)' }}
        >
          {label}
        </span>
      ))}
    </span>
  )
}

function Card({ note }: { note: NoteSummary }) {
  const isList = note.kind === 'list' || note.unchecked + note.checked > 0
  const count = counts(note)
  return (
    <li>
      <Link
        href={noteHref(note.id)}
        data-testid="note-card"
        className="flex flex-col gap-1 rounded-lg px-3 py-2.5 outline-none focus-visible:outline-2 focus-visible:outline-[var(--lantern)]"
        style={{ background: 'var(--paper)', color: 'var(--bone)' }}
      >
        <span className="flex items-center gap-2">
          {isList ? (
            <ListChecks
              className="h-4 w-4 flex-none"
              strokeWidth={1.7}
              style={MUTED}
              aria-hidden="true"
            />
          ) : null}
          <span className="min-w-0 flex-1 truncate text-[15px] font-medium">
            {note.title || 'Untitled'}
          </span>
          {note.pinned && (
            <Pin
              className="h-3.5 w-3.5 flex-none"
              strokeWidth={1.7}
              style={{ color: 'var(--lantern)' }}
              aria-label="Pinned"
            />
          )}
        </span>
        {note.snippet ? (
          <span className="line-clamp-2 text-[13px]" style={MUTED}>
            {note.snippet}
          </span>
        ) : null}
        {note.preview.length > 0 && (
          <span className="flex flex-col text-[13px]" style={MUTED}>
            {note.preview.slice(0, 3).map((item) => (
              <span key={item.id} className="truncate">
                ☐ {item.text}
              </span>
            ))}
            {note.unchecked > 3 && <span>+{note.unchecked - 3} more</span>}
          </span>
        )}
        <span
          className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]"
          style={MUTED}
        >
          {count && <span>{count}</span>}
          {note.attachmentCount > 0 && (
            <span className="inline-flex items-center gap-1">
              <Paperclip className="h-3 w-3" strokeWidth={1.7} aria-hidden />
              {note.attachmentCount}
            </span>
          )}
          <Labels labels={note.labels} />
        </span>
      </Link>
    </li>
  )
}

/** Groceries, always first: a list the capture router fills from photos. */
function GroceriesShortcut({
  note,
  known,
}: {
  note: NoteSummary | null
  known: boolean
}) {
  const text = !known
    ? ''
    : note && note.unchecked + note.checked > 0
      ? counts(note)
      : 'Nothing on it yet'
  return (
    <Link
      href={noteHref(GROCERIES_ID)}
      data-testid="groceries-shortcut"
      className="flex items-center gap-3 rounded-lg px-3 py-3 outline-none focus-visible:outline-2 focus-visible:outline-[var(--lantern)]"
      style={{
        background: 'var(--paper)',
        border: '1px solid var(--paper-veil)',
      }}
    >
      <ShoppingBasket
        className="h-5 w-5 flex-none"
        strokeWidth={1.7}
        style={{ color: 'var(--lantern)' }}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1">
        <span
          className="block text-[15px] font-medium"
          style={{ color: 'var(--bone)' }}
        >
          Groceries
        </span>
        {text && (
          <span className="block text-[12px]" style={MUTED}>
            {text}
          </span>
        )}
      </span>
    </Link>
  )
}

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled
}

/** Notes, pinned first and then by latest activity, with search, a label
 * filter, the archive, and Groceries on top. */
export function NoteList() {
  const router = useRouter()
  const [text, setText] = useState('')
  const [archived, setArchived] = useState(false)
  const [label, setLabel] = useState<string | null>(null)
  const [making, setMaking] = useState<NoteKind | null>(null)
  const [makeError, setMakeError] = useState<string | null>(null)
  const q = useDebounced(text.trim(), 250)
  const list = useNotes(q, archived)

  const make = async (kind: NoteKind) => {
    setMaking(kind)
    setMakeError(null)
    try {
      const note = await createNote({ kind })
      router.push(noteHref(note.id))
    } catch (error) {
      setMakeError(error instanceof Error ? error.message : "Couldn't make it")
      setMaking(null)
    }
  }

  const labels = [...new Set(list.notes.flatMap((note) => note.labels))].sort()
  const filtering = q !== '' || archived || label !== null
  const groceries =
    list.notes.find((note) => note.source === GROCERIES_SOURCE) ?? null
  const shown = list.notes.filter(
    (note) =>
      (label === null || note.labels.includes(label)) &&
      (filtering || note !== groceries),
  )
  const pinned = shown.filter((note) => note.pinned)
  const others = shown.filter((note) => !note.pinned)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <button
          type="button"
          className="lantern-btn primary min-h-11 flex-1"
          disabled={making !== null}
          onClick={() => void make('note')}
        >
          <Plus className="h-4 w-4" strokeWidth={1.7} aria-hidden="true" />
          {making === 'note' ? 'Making…' : 'New note'}
        </button>
        <button
          type="button"
          className="lantern-btn min-h-11 flex-1"
          disabled={making !== null}
          onClick={() => void make('list')}
        >
          <ListChecks
            className="h-4 w-4"
            strokeWidth={1.7}
            aria-hidden="true"
          />
          {making === 'list' ? 'Making…' : 'New list'}
        </button>
      </div>
      {makeError && (
        <Message tone="beacon" testId="note-make-failed">
          {makeError}
        </Message>
      )}

      {!filtering && <GroceriesShortcut note={groceries} known={list.loaded} />}

      <div className="flex gap-2">
        <label className="lantern-field min-w-0 flex-1" style={{ height: 44 }}>
          <Search
            className="h-4 w-4 flex-none"
            strokeWidth={1.7}
            aria-hidden="true"
          />
          <input
            type="search"
            aria-label="Search notes"
            placeholder="Search notes"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        <button
          type="button"
          className={clsx('lantern-btn min-h-11', archived && 'primary')}
          aria-pressed={archived}
          onClick={() => setArchived((now) => !now)}
        >
          <Archive className="h-4 w-4" strokeWidth={1.7} aria-hidden="true" />
          Archived
        </button>
      </div>

      {labels.length > 0 && (
        <div
          className="flex gap-1.5 overflow-x-auto pb-1"
          role="group"
          aria-label="Filter by label"
        >
          {labels.map((name) => (
            <button
              key={name}
              type="button"
              aria-pressed={label === name}
              className="min-h-9 flex-none rounded-full px-3 text-[13px]"
              style={
                label === name
                  ? {
                      background: 'rgb(var(--lantern-rgb) / 0.14)',
                      border: '1px solid var(--lantern)',
                      color: 'var(--lantern)',
                    }
                  : {
                      background: 'var(--paper-veil)',
                      border: '1px solid transparent',
                      color: 'var(--bone)',
                    }
              }
              onClick={() => setLabel((now) => (now === name ? null : name))}
            >
              {name}
            </button>
          ))}
        </div>
      )}

      {list.isLoading ? (
        <Message>Loading notes…</Message>
      ) : list.isError ? (
        <Message testId="notes-failed">
          Couldn&apos;t load notes{list.error ? `: ${list.error}` : ''}.{' '}
          <TextButton onClick={list.refetch}>Try again</TextButton>
        </Message>
      ) : (
        <>
          {list.isStale && (
            <Message tone="beacon" testId="notes-stale">
              Couldn&apos;t refresh. This is the list from{' '}
              {formatAge(Date.now() - list.updatedAt)} ago.{' '}
              <TextButton onClick={list.refetch}>Try again</TextButton>
            </Message>
          )}
          {shown.length === 0 ? (
            <Message testId="notes-empty">
              {q
                ? `Nothing matches "${q}".`
                : label
                  ? `No notes labelled ${label}.`
                  : archived
                    ? 'Nothing archived.'
                    : 'No notes yet. Tap New note or New list.'}
            </Message>
          ) : (
            <>
              {pinned.length > 0 && (
                <section
                  aria-label="Pinned notes"
                  className="flex flex-col gap-1.5"
                >
                  <h2 className="lantern-sec">Pinned</h2>
                  <ul className="flex flex-col gap-2">
                    {pinned.map((note) => (
                      <Card key={note.id} note={note} />
                    ))}
                  </ul>
                </section>
              )}
              {others.length > 0 && (
                <section aria-label="Notes" className="flex flex-col gap-1.5">
                  {pinned.length > 0 && <h2 className="lantern-sec">Others</h2>}
                  <ul className="flex flex-col gap-2">
                    {others.map((note) => (
                      <Card key={note.id} note={note} />
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}
