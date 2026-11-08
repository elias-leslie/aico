'use client'

import { clsx } from 'clsx'
import {
  Archive,
  Bell,
  ListChecks,
  Paperclip,
  Pin,
  Plus,
  Search,
  ShoppingBasket,
} from 'lucide-react'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import {
  GROCERIES_ID,
  GROCERIES_SOURCE,
  NO_SCOPE,
  type NoteSummary,
  type NotesScope,
} from '@/lib/api/notes'
import { formatAge } from '@/lib/attention'
import { formatWhen } from '@/lib/capture-format'
import { useNoteProjects } from '@/lib/hooks/use-note-projects'
import { useNoteLabels, useNotes } from '@/lib/hooks/use-notes'
import { NoteScope, ProjectTag } from './NoteScope'
import { useNoteLinks } from './note-links'

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

function Chip({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      className="inline-flex min-h-9 flex-none items-center gap-1.5 rounded-full px-3 text-[13px]"
      style={
        pressed
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
      onClick={onClick}
    >
      {children}
    </button>
  )
}

const counts = (note: { unchecked: number; checked: number }) =>
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

/** When the reminder is (or was): amber until it has gone out, then quiet. */
function Due({ note }: { note: NoteSummary }) {
  const at = note.remindAt as number
  return (
    <span
      className="inline-flex items-center gap-1"
      data-testid="note-due"
      style={{
        color: note.remindedAt === null ? 'var(--lantern)' : 'var(--mist)',
      }}
    >
      <Bell className="h-3 w-3" strokeWidth={1.7} aria-hidden />
      {note.remindedAt === null
        ? formatWhen(at)
        : `Sent ${formatWhen(note.remindedAt)}`}
    </span>
  )
}

function Card({
  note,
  scope,
  showProject,
}: {
  note: NoteSummary
  scope: NotesScope
  /** The list is All: say which project each note belongs to. */
  showProject: boolean
}) {
  const links = useNoteLinks()
  const isList = note.kind === 'list' || note.unchecked + note.checked > 0
  const count = counts(note)
  return (
    <li>
      <Link
        href={links.note(note.id, scope)}
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
          {showProject && note.project && <ProjectTag project={note.project} />}
          <Labels labels={note.labels} />
          {note.remindAt !== null && <Due note={note} />}
        </span>
      </Link>
    </li>
  )
}

/** Groceries, always first: a list the capture router fills from photos. */
function GroceriesShortcut({
  note,
  known,
  scope,
}: {
  note: NoteSummary | null
  known: boolean
  scope: NotesScope
}) {
  const links = useNoteLinks()
  const photos = note?.attachmentCount ?? 0
  const text = !known
    ? ''
    : note && note.unchecked + note.checked > 0
      ? counts(note)
      : photos > 0
        ? `No items yet · ${photos} ${photos === 1 ? 'photo' : 'photos'}`
        : 'Nothing on it yet'
  return (
    <Link
      href={links.note(GROCERIES_ID, scope)}
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

/** Notes, pinned first and then by latest activity, with the scope switch (this project or
 * All), search, a label filter, the archive, and Groceries on top. `scope` is what the page was
 * opened for; `onScope` widens it to All or narrows it back. */
export function NoteList({
  scope = NO_SCOPE,
  onScope = () => {},
}: {
  scope?: NotesScope
  onScope?: (all: boolean) => void
}) {
  const links = useNoteLinks()
  const [text, setText] = useState('')
  const [archived, setArchived] = useState(false)
  const [label, setLabel] = useState<string | null>(null)
  const [reminders, setReminders] = useState(false)
  const q = useDebounced(text.trim(), 250)
  // The project the list is narrowed to; undefined: every note.
  const project = scope.project && !scope.all ? scope.project : undefined
  const { nameOf } = useNoteProjects()
  const where = project ? nameOf(project) : null
  const list = useNotes(q, archived, reminders, project)
  const allLabels = useNoteLabels(reminders ? 'all' : archived, project)

  // Every label in use (the server's list), else the ones on the notes loaded;
  // the chosen label stays a chip even where no note has it, so the filter can
  // always be turned off.
  const labels = [
    ...new Map(
      [
        ...(allLabels ?? list.notes.flatMap((note) => note.labels)),
        ...(label === null ? [] : [label]),
      ].map((name) => [name.toLowerCase(), name]),
    ).values(),
  ].sort()
  const hasLabel = (note: NoteSummary, name: string) =>
    note.labels.some((have) => have.toLowerCase() === name.toLowerCase())
  const filtering = q !== '' || archived || label !== null || reminders
  const groceries =
    list.notes.find((note) => note.source === GROCERIES_SOURCE) ?? null
  const shown = list.notes.filter(
    (note) =>
      (label === null || hasLabel(note, label)) &&
      (filtering || note !== groceries),
  )
  // The reminders view is in time order: what has come due first, then what is coming.
  const nowMs = Date.now()
  const dueNow = reminders
    ? shown.filter((note) => (note.remindAt as number) <= nowMs)
    : []
  const coming = reminders
    ? shown.filter((note) => (note.remindAt as number) > nowMs)
    : []
  const pinned = reminders ? [] : shown.filter((note) => note.pinned)
  const others = reminders ? [] : shown.filter((note) => !note.pinned)

  return (
    <div className="flex flex-col gap-3">
      <NoteScope scope={scope} onChange={onScope} />
      <div className="flex gap-2">
        {/* Nothing is saved until something is put in it. */}
        <Link
          href={links.fresh('note', scope)}
          className="lantern-btn primary min-h-11 flex-1"
          data-testid="new-note"
        >
          <Plus className="h-4 w-4" strokeWidth={1.7} aria-hidden="true" />
          New note
        </Link>
        <Link
          href={links.fresh('list', scope)}
          className="lantern-btn min-h-11 flex-1"
          data-testid="new-list"
        >
          <ListChecks
            className="h-4 w-4"
            strokeWidth={1.7}
            aria-hidden="true"
          />
          New list
        </Link>
      </div>

      {!filtering && (
        <GroceriesShortcut
          note={groceries}
          known={list.loaded && project === undefined}
          scope={scope}
        />
      )}

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

      <div
        className="flex gap-1.5 overflow-x-auto pb-1"
        role="group"
        aria-label="Filter notes"
      >
        <Chip pressed={reminders} onClick={() => setReminders((now) => !now)}>
          <Bell className="h-3.5 w-3.5" strokeWidth={1.7} aria-hidden="true" />
          Reminders
        </Chip>
        {labels.map((name) => (
          <Chip
            key={name}
            pressed={label === name}
            onClick={() => setLabel((now) => (now === name ? null : name))}
          >
            {name}
          </Chip>
        ))}
      </div>

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
                ? `Nothing${where ? ` in ${where}` : ''} matches "${q}".`
                : label
                  ? `No notes labelled ${label}${where ? ` in ${where}` : ''}.`
                  : reminders
                    ? `No reminders${where ? ` in ${where}` : ''}. Open a note and tap Remind me.`
                    : archived
                      ? `Nothing archived${where ? ` in ${where}` : ''}.`
                      : where
                        ? `No notes in ${where} yet. Tap New note or New list.`
                        : 'No notes yet. Tap New note or New list.'}
              {where && (
                <>
                  {' '}
                  <TextButton onClick={() => onScope(true)}>
                    Show all notes
                  </TextButton>
                </>
              )}
            </Message>
          ) : (
            <>
              {dueNow.length > 0 && (
                <section aria-label="Due" className="flex flex-col gap-1.5">
                  <h2 className="lantern-sec">Due</h2>
                  <ul className="flex flex-col gap-2">
                    {dueNow.map((note) => (
                      <Card
                        key={note.id}
                        note={note}
                        scope={scope}
                        showProject={project === undefined}
                      />
                    ))}
                  </ul>
                </section>
              )}
              {coming.length > 0 && (
                <section
                  aria-label="Coming up"
                  className="flex flex-col gap-1.5"
                >
                  <h2 className="lantern-sec">Coming up</h2>
                  <ul className="flex flex-col gap-2">
                    {coming.map((note) => (
                      <Card
                        key={note.id}
                        note={note}
                        scope={scope}
                        showProject={project === undefined}
                      />
                    ))}
                  </ul>
                </section>
              )}
              {pinned.length > 0 && (
                <section
                  aria-label="Pinned notes"
                  className="flex flex-col gap-1.5"
                >
                  <h2 className="lantern-sec">Pinned</h2>
                  <ul className="flex flex-col gap-2">
                    {pinned.map((note) => (
                      <Card
                        key={note.id}
                        note={note}
                        scope={scope}
                        showProject={project === undefined}
                      />
                    ))}
                  </ul>
                </section>
              )}
              {others.length > 0 && (
                <section aria-label="Notes" className="flex flex-col gap-1.5">
                  {pinned.length > 0 && <h2 className="lantern-sec">Others</h2>}
                  <ul className="flex flex-col gap-2">
                    {others.map((note) => (
                      <Card
                        key={note.id}
                        note={note}
                        scope={scope}
                        showProject={project === undefined}
                      />
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
