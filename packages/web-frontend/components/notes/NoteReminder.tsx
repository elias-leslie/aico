'use client'

import { Bell, X } from 'lucide-react'
import { useState } from 'react'
import { formatWhen } from '@/lib/capture-format'
import { fromLocalInput, toLocalInput } from '@/lib/note-reminder'

const MUTED = { color: 'var(--mist)' } as const

/** A note's reminder: a time Aico sends a phone notice at, once. Saves when a
 * complete time is picked; Remove takes it off. */
export function NoteReminder({
  remindAt,
  remindedAt,
  onChange,
}: {
  remindAt: number | null
  remindedAt: number | null
  onChange: (remindAt: number | null) => void
}) {
  const [adding, setAdding] = useState(false)

  if (remindAt === null && !adding)
    return (
      <div>
        <button
          type="button"
          className="lantern-btn small min-h-9"
          data-testid="note-remind"
          onClick={() => setAdding(true)}
        >
          <Bell className="h-3.5 w-3.5" strokeWidth={1.7} aria-hidden="true" />
          Remind me
        </button>
      </div>
    )

  const status =
    remindedAt !== null
      ? `Sent ${formatWhen(remindedAt)}`
      : remindAt !== null && remindAt <= Date.now()
        ? 'Sending soon'
        : null
  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1"
      data-testid="note-reminder"
    >
      <Bell
        className="h-4 w-4 flex-none"
        strokeWidth={1.7}
        style={{
          color: remindedAt === null ? 'var(--lantern)' : 'var(--mist)',
        }}
        aria-hidden="true"
      />
      <input
        type="datetime-local"
        aria-label="Reminder time"
        value={remindAt === null ? '' : toLocalInput(remindAt)}
        onChange={(event) => {
          const at = fromLocalInput(event.target.value)
          if (at !== null && at !== remindAt) onChange(at)
        }}
        className="lantern-field min-w-0 text-[13px]"
        style={{ height: 38, color: 'var(--bone)', colorScheme: 'dark' }}
      />
      <button
        type="button"
        className="lantern-icon-btn"
        aria-label="Remove reminder"
        title="Remove reminder"
        onClick={() => {
          setAdding(false)
          if (remindAt !== null) onChange(null)
        }}
      >
        <X className="h-[18px] w-[18px]" strokeWidth={1.7} />
      </button>
      {status && (
        <span className="text-[12px]" style={MUTED} role="status">
          {status}
        </span>
      )}
    </div>
  )
}
