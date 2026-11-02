'use client'

import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  GripVertical,
  Plus,
  X,
} from 'lucide-react'
import { useRef, useState } from 'react'
import { type NoteDetail, type NoteItem, positionAt } from '@/lib/api/notes'
import { useMediaQuery } from '@/lib/hooks/use-media-query'
import type { useNoteActions } from '@/lib/hooks/use-notes'

export type NoteActions = ReturnType<typeof useNoteActions>

const MUTED = { color: 'var(--mist)' } as const

const sentence = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback

function ItemRow({
  item,
  actions,
  onError,
  onEnter,
  order,
}: {
  item: NoteItem
  actions: NoteActions
  onError: (message: string) => void
  /** Enter in the text moves on to the add box. */
  onEnter: () => void
  /** Reordering controls; null for a done item. */
  order: {
    drag: boolean
    arrows: boolean
    first: boolean
    last: boolean
    move: (by: -1 | 1) => void
    onDragStart: () => void
    onDrop: () => void
  } | null
}) {
  const [text, setText] = useState(item.text)
  const [seen, setSeen] = useState(item.text)
  const focused = useRef(false)
  // What the server holds replaces the text unless it is being typed.
  if (item.text !== seen) {
    setSeen(item.text)
    if (!focused.current) setText(item.text)
  }

  const fail = (error: unknown) =>
    onError(sentence(error, "Couldn't save the item"))
  const commit = () => {
    focused.current = false
    const next = text.trim()
    if (!next) return setText(item.text)
    if (next !== item.text)
      void actions.setItem(item, { text: next }).catch(fail)
  }

  return (
    <li
      data-testid="note-item"
      data-checked={item.checked}
      className="flex flex-col"
      onDragOver={order?.drag ? (event) => event.preventDefault() : undefined}
      onDrop={order?.drag ? order.onDrop : undefined}
    >
      <div className="flex items-center">
        {order?.drag && (
          <span
            draggable
            onDragStart={order.onDragStart}
            className="flex min-h-11 w-6 flex-none cursor-grab items-center justify-center"
            style={MUTED}
            title="Drag to reorder"
          >
            <GripVertical
              className="h-4 w-4"
              strokeWidth={1.7}
              aria-hidden="true"
            />
          </span>
        )}
        <label className="flex min-h-11 w-11 flex-none cursor-pointer items-center justify-center">
          <input
            type="checkbox"
            className="h-5 w-5 cursor-pointer accent-[var(--lantern)]"
            checked={item.checked}
            aria-label={`${item.checked ? 'Uncheck' : 'Check'} ${item.text}`}
            onChange={(event) =>
              void actions
                .setItem(item, { checked: event.target.checked })
                .catch(fail)
            }
          />
        </label>
        <input
          type="text"
          aria-label="Item"
          maxLength={2000}
          className="min-h-11 min-w-0 flex-1 bg-transparent text-[15px] outline-none focus-visible:underline"
          style={{
            color: item.checked ? 'var(--mist)' : 'var(--bone)',
            textDecoration: item.checked ? 'line-through' : 'none',
          }}
          value={text}
          onFocus={() => {
            focused.current = true
          }}
          onChange={(event) => setText(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
            event.preventDefault()
            commit()
            onEnter()
          }}
        />
        {order?.arrows && (
          <>
            <button
              type="button"
              className="lantern-icon-btn"
              aria-label={`Move ${item.text} up`}
              disabled={order.first}
              onClick={() => order.move(-1)}
            >
              <ArrowUp className="h-4 w-4" strokeWidth={1.7} />
            </button>
            <button
              type="button"
              className="lantern-icon-btn"
              aria-label={`Move ${item.text} down`}
              disabled={order.last}
              onClick={() => order.move(1)}
            >
              <ArrowDown className="h-4 w-4" strokeWidth={1.7} />
            </button>
          </>
        )}
        <button
          type="button"
          className="lantern-icon-btn"
          aria-label={`Remove ${item.text}`}
          onClick={() => void actions.removeItem(item).catch(fail)}
        >
          <X className="h-4 w-4" strokeWidth={1.7} />
        </button>
      </div>
      {item.hint === 'struck' && !item.checked && (
        <p
          data-testid="struck-hint"
          className="-mt-1 mb-1 ml-11 flex flex-wrap items-center gap-x-2 text-[12px]"
          style={{ color: 'var(--beacon)' }}
        >
          Crossed out on the photo?
          <button
            type="button"
            className="inline-flex min-h-11 items-center underline underline-offset-2"
            style={{ color: 'var(--lantern)' }}
            onClick={() =>
              void actions.setItem(item, { checked: true }).catch(fail)
            }
          >
            Check it
          </button>
        </p>
      )}
    </li>
  )
}

/** The checklist: open items in order (add, edit, check, remove, reorder),
 * then the done ones with Clear checked. */
export function NoteItems({
  note,
  actions,
}: {
  note: NoteDetail
  actions: NoteActions
}) {
  const touch = useMediaQuery('(any-pointer: coarse)')
  const [input, setInput] = useState('')
  const [pending, setPending] = useState<{ key: number; text: string }[]>([])
  const [error, setError] = useState<string | null>(null)
  const [reorder, setReorder] = useState(false)
  const [clearing, setClearing] = useState(false)
  const dragging = useRef<string | null>(null)
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const counter = useRef(0)
  const addBox = useRef<HTMLInputElement>(null)

  const sorted = [...note.items].sort((a, b) => a.position - b.position)
  const open = sorted.filter((item) => !item.checked)
  const done = sorted.filter((item) => item.checked)

  const add = () => {
    const text = input.trim()
    if (!text) return
    setInput('')
    setError(null)
    counter.current += 1
    const key = counter.current
    setPending((now) => [...now, { key, text }])
    // One at a time, so the items land in the order they were typed.
    queue.current = queue.current.then(() =>
      actions
        .add(text)
        .catch((failure) => {
          setError(`Couldn't add "${text}": ${sentence(failure, 'try again')}`)
          setInput((now) => now || text)
        })
        .finally(() => setPending((now) => now.filter((p) => p.key !== key))),
    )
  }

  const moveTo = (item: NoteItem, index: number) => {
    const others = open.filter((other) => other.id !== item.id)
    const position = positionAt(
      others.map((other) => other.position),
      Math.max(0, Math.min(index, others.length)),
    )
    void actions
      .setItem(item, { position })
      .catch((failure) => setError(sentence(failure, "Couldn't move it")))
  }

  const clearChecked = async () => {
    setClearing(true)
    setError(null)
    try {
      for (const item of done) await actions.removeItem(item)
    } catch (failure) {
      setError(sentence(failure, "Couldn't clear them"))
      actions.refresh()
    }
    setClearing(false)
  }

  return (
    <section aria-label="Items" className="flex flex-col gap-1">
      {touch && open.length > 1 && (
        <button
          type="button"
          className="lantern-btn ghost small min-h-11 self-end"
          aria-pressed={reorder}
          onClick={() => setReorder((now) => !now)}
        >
          <ArrowUpDown
            className="h-4 w-4"
            strokeWidth={1.7}
            aria-hidden="true"
          />
          {reorder ? 'Done reordering' : 'Reorder'}
        </button>
      )}
      <ul>
        {open.map((item, index) => (
          <ItemRow
            key={item.id}
            item={item}
            actions={actions}
            onError={setError}
            onEnter={() => addBox.current?.focus()}
            order={{
              drag: !touch,
              arrows: touch && reorder,
              first: index === 0,
              last: index === open.length - 1,
              move: (by) => moveTo(item, index + by),
              onDragStart: () => {
                dragging.current = item.id
              },
              onDrop: () => {
                const moved = open.find(
                  (other) => other.id === dragging.current,
                )
                dragging.current = null
                if (moved && moved.id !== item.id) moveTo(moved, index)
              },
            }}
          />
        ))}
        {pending.map((entry) => (
          <li
            key={`pending-${entry.key}`}
            data-testid="note-item-pending"
            className="flex min-h-11 items-center gap-3 pl-3 text-[15px]"
            style={MUTED}
          >
            <span aria-hidden="true">☐</span>
            <span className="min-w-0 flex-1 truncate">{entry.text}</span>
            <span className="pr-3 text-[12px]">Adding…</span>
          </li>
        ))}
      </ul>

      <div className="flex items-center gap-1">
        <input
          ref={addBox}
          type="text"
          aria-label="Add an item"
          placeholder="Add an item"
          enterKeyHint="next"
          maxLength={2000}
          className="min-h-11 min-w-0 flex-1 rounded-md px-3 text-[15px] outline-none focus-visible:border-[var(--lantern)]"
          style={{
            background: 'rgb(var(--ink-rgb) / 0.86)',
            border: '1px solid var(--paper-veil)',
            color: 'var(--bone)',
          }}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
            event.preventDefault()
            add()
          }}
        />
        <button
          type="button"
          className="lantern-icon-btn"
          aria-label="Add item"
          disabled={!input.trim()}
          onClick={add}
        >
          <Plus className="h-[18px] w-[18px]" strokeWidth={1.7} />
        </button>
      </div>

      {error && (
        <p
          role="alert"
          className="text-[12px]"
          style={{ color: 'var(--term-error-text)' }}
        >
          {error}
        </p>
      )}
      {open.length === 0 && done.length === 0 && pending.length === 0 && (
        <p className="text-[13px]" style={MUTED}>
          Nothing on this list yet. Type an item above and press Enter.
        </p>
      )}

      {done.length > 0 && (
        <section aria-label="Done items" className="mt-2 flex flex-col">
          <div className="flex items-center justify-between">
            <h2 className="lantern-sec">Done · {done.length}</h2>
            <button
              type="button"
              className="lantern-btn ghost small min-h-11"
              disabled={clearing}
              onClick={() => void clearChecked()}
            >
              {clearing ? 'Clearing…' : 'Clear checked'}
            </button>
          </div>
          <ul>
            {done.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                actions={actions}
                onError={setError}
                onEnter={() => addBox.current?.focus()}
                order={null}
              />
            ))}
          </ul>
        </section>
      )}
    </section>
  )
}
