'use client'

import { FileText, ImagePlus, X } from 'lucide-react'
import { useState } from 'react'
import {
  attachmentThumbSource,
  attachmentUrl,
  type NoteAttachment,
  removeAttachment,
} from '@/lib/api/notes'
import { formatBytes } from '@/lib/capture-format'
import { useCaptureLimits } from '@/lib/hooks/use-captures'
import { addFileToNote } from '@/lib/note-attach'
import { CapturePicker } from '../capture/CapturePicker'

interface Upload {
  key: string
  file: File
  state: 'sending' | 'failed'
  progress: number
  error: string | null
}

function Tile({
  attachment,
  onRemove,
}: {
  attachment: NoteAttachment
  onRemove: () => void
}) {
  const source = attachmentThumbSource(attachment)
  const [broken, setBroken] = useState(false)
  return (
    <li className="relative" data-testid="note-attachment">
      <a
        href={attachmentUrl(attachment.noteId, attachment.id, 'file')}
        target="_blank"
        rel="noreferrer"
        title={`${attachment.name} · ${formatBytes(attachment.size)}`}
        className="grid h-24 w-24 place-items-center overflow-hidden rounded-md outline-none focus-visible:outline-2 focus-visible:outline-[var(--lantern)]"
        style={{ background: 'var(--paper)', color: 'var(--mist)' }}
      >
        {source && !broken ? (
          // biome-ignore lint/performance/noImgElement: the server's small picture, already sized
          <img
            src={source}
            alt={attachment.name}
            loading="lazy"
            className="h-full w-full object-cover"
            onError={() => setBroken(true)}
          />
        ) : (
          <span className="flex flex-col items-center gap-1 px-1 text-center text-[11px]">
            <FileText
              className="h-5 w-5"
              strokeWidth={1.5}
              aria-hidden="true"
            />
            <span className="line-clamp-2 break-all">{attachment.name}</span>
          </span>
        )}
      </a>
      <button
        type="button"
        className="absolute -top-2 -right-2 grid h-7 w-7 place-items-center rounded-full"
        style={{ background: 'var(--paper-veil)', color: 'var(--bone)' }}
        aria-label={`Remove ${attachment.name} from this note`}
        onClick={onRemove}
      >
        <X className="h-3.5 w-3.5" strokeWidth={2} />
      </button>
    </li>
  )
}

/** Pictures and files on the note: tap one for full size; add more with the
 * same picker as Capture. */
export function NoteAttachments({
  noteId,
  ensureNote,
  attachments,
  onChanged,
}: {
  /** null on a New note not made yet: the first photo makes it (`ensureNote`). */
  noteId: string | null
  ensureNote?: () => Promise<string>
  attachments: NoteAttachment[]
  onChanged: () => void
}) {
  const { limits } = useCaptureLimits()
  const [picking, setPicking] = useState(false)
  const [uploads, setUploads] = useState<Upload[]>([])
  const [error, setError] = useState<string | null>(null)

  const patch = (key: string, change: Partial<Upload>) =>
    setUploads((now) =>
      now.map((entry) => (entry.key === key ? { ...entry, ...change } : entry)),
    )

  const send = async (key: string, file: File) => {
    patch(key, { state: 'sending', progress: 0, error: null })
    try {
      const target = noteId ?? (await ensureNote?.())
      if (!target) throw new Error("Couldn't make the note. Try again.")
      await addFileToNote(target, file, {
        clientId: key,
        onProgress: (progress) => patch(key, { progress }),
      })
      setUploads((now) => now.filter((entry) => entry.key !== key))
      onChanged()
    } catch (failure) {
      patch(key, {
        state: 'failed',
        error: failure instanceof Error ? failure.message : "Couldn't send it",
      })
    }
  }

  const add = (files: File[]) => {
    const entries = files.map((file) => ({
      key: crypto.randomUUID(),
      file,
      state: 'sending' as const,
      progress: 0,
      error: null,
    }))
    setUploads((now) => [...now, ...entries])
    setPicking(false)
    for (const entry of entries) void send(entry.key, entry.file)
  }

  const remove = async (attachment: NoteAttachment) => {
    setError(null)
    try {
      await removeAttachment(noteId ?? attachment.noteId, attachment.id)
      onChanged()
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Couldn't remove it",
      )
    }
  }

  return (
    <section aria-label="Photos and files" className="flex flex-col gap-2">
      {(attachments.length > 0 || uploads.length > 0) && (
        <ul className="flex flex-wrap gap-3">
          {attachments.map((attachment) => (
            <Tile
              key={attachment.id}
              attachment={attachment}
              onRemove={() => void remove(attachment)}
            />
          ))}
        </ul>
      )}
      {uploads.map((entry) => (
        <p
          key={entry.key}
          role="status"
          data-testid="note-upload"
          className="text-[13px]"
          style={{
            color:
              entry.state === 'failed'
                ? 'var(--term-error-text)'
                : 'var(--mist)',
          }}
        >
          {entry.file.name}:{' '}
          {entry.state === 'failed'
            ? (entry.error ?? "Couldn't send it")
            : entry.progress >= 100
              ? 'Saving…'
              : `Sending ${entry.progress}%`}{' '}
          {entry.state === 'failed' && (
            <>
              <button
                type="button"
                className="min-h-11 underline underline-offset-2"
                style={{ color: 'var(--lantern)' }}
                onClick={() => void send(entry.key, entry.file)}
              >
                Try again
              </button>{' '}
              <button
                type="button"
                className="min-h-11 underline underline-offset-2"
                style={{ color: 'var(--mist)' }}
                onClick={() =>
                  setUploads((now) => now.filter((x) => x.key !== entry.key))
                }
              >
                Dismiss
              </button>
            </>
          )}
        </p>
      ))}
      {error && (
        <p
          role="alert"
          className="text-[12px]"
          style={{ color: 'var(--term-error-text)' }}
        >
          {error}
        </p>
      )}
      {picking ? <CapturePicker accept={limits?.accept} onFiles={add} /> : null}
      <button
        type="button"
        className="lantern-btn min-h-11 self-start"
        aria-expanded={picking}
        onClick={() => setPicking((now) => !now)}
      >
        <ImagePlus className="h-4 w-4" strokeWidth={1.7} aria-hidden="true" />
        {picking ? 'Cancel' : 'Add photo or file'}
      </button>
    </section>
  )
}
