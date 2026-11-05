'use client'

import { Check, FileText, Image as ImageIcon, RotateCw, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import {
  captureFileUrl,
  capturePreviewUrl,
  captureThumbUrl,
} from '@/lib/api/captures'
import { formatBytes } from '@/lib/capture-format'
import {
  askCaptureQueue,
  type CaptureQueue,
  idleCaptureQueue,
  type QueueItem,
  useQueue,
} from '@/lib/capture-queue'
import type { AnswerFile, OwnerAsk, WantsFiles } from '@/lib/hooks/use-asks'
import { useCaptureLimits } from '@/lib/hooks/use-captures'
import { CapturePicker } from '../capture/CapturePicker'
import { FileThumb } from '../capture/CaptureThumb'

/** Where the card stands on the files it asked for. */
export interface AskFilesState {
  wants: WantsFiles | null
  queue: CaptureQueue
  items: QueueItem[]
  notice: string | null
  /** Saved and tagged to the ask: what Send sends. */
  saved: QueueItem[]
  /** Waiting or on their way. */
  waiting: number
  failed: number
  /** Saved and on their way: counted against the most the ask takes. */
  held: number
  full: boolean
  /** The ask's minimum is met by what is saved. */
  enough: boolean
}

/** The ask's own send queue. It outlives the card, so folding the card or
 * closing the drawer keeps the files. */
export function useAskFiles(ask: OwnerAsk): AskFilesState {
  const wants = ask.wantsFiles ?? null
  const queue = wants ? askCaptureQueue(ask.id) : idleCaptureQueue
  const { items, notice } = useQueue(queue)
  return useMemo(() => {
    const saved = items.filter((item) => item.state === 'sent' && item.capture)
    const waiting = items.filter(
      (item) => item.state === 'queued' || item.state === 'sending',
    ).length
    const held = saved.length + waiting
    return {
      wants,
      queue,
      items,
      notice,
      saved,
      waiting,
      failed: items.filter((item) => item.state === 'failed').length,
      held,
      full: wants !== null && held >= wants.max,
      enough: wants === null || saved.length >= wants.min,
    }
  }, [wants, queue, items, notice])
}

/** "0 of 1-3 files", and "3 of 3 files" at the most. */
function countText(held: number, wants: WantsFiles): string {
  const range =
    held >= wants.max || wants.min === wants.max
      ? `${wants.max}`
      : `${wants.min}-${wants.max}`
  return `${held} of ${range} ${wants.max === 1 ? 'file' : 'files'}`
}

/** What Send says while the ask's minimum is not met: "Add 2 more photos". */
export function addMoreText(wants: WantsFiles, saved: number): string {
  const noun = /photo|picture|image|screenshot/i.test(wants.hint ?? '')
    ? 'photo'
    : 'file'
  const missing = Math.max(1, wants.min - saved)
  return `Add ${missing} more ${noun}${missing === 1 ? '' : 's'}`
}

function Row({
  item,
  queue,
  locked,
}: {
  item: QueueItem
  queue: CaptureQueue
  locked: boolean
}) {
  const { file } = item
  const status =
    item.state === 'queued'
      ? 'Waiting'
      : item.state === 'sending'
        ? item.progress >= 100
          ? 'Saving…'
          : `Sending ${item.progress}%`
        : item.state === 'sent'
          ? 'Saved'
          : (item.error ?? "Couldn't send it")
  return (
    <li
      className="flex items-center gap-2.5 py-1.5"
      data-testid="ask-file-row"
      data-state={item.state}
    >
      <FileThumb file={file} size={36} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px]" style={{ color: 'var(--bone)' }}>
          {file.name}
        </p>
        <p
          className="text-[12px]"
          style={{
            color:
              item.state === 'failed'
                ? 'var(--term-error-text)'
                : item.state === 'sent'
                  ? 'var(--jade)'
                  : 'var(--mist)',
          }}
        >
          {formatBytes(file.size)} · {status}
        </p>
        {item.state === 'sending' && (
          <progress
            className="mt-1 h-1 w-full accent-[var(--lantern)]"
            max={100}
            value={item.progress}
            aria-label={`Sending ${file.name}`}
          />
        )}
      </div>
      {item.state === 'sent' && (
        <Check
          className="h-4 w-4 flex-none"
          strokeWidth={2}
          style={{ color: 'var(--jade)' }}
          aria-hidden="true"
        />
      )}
      {item.state === 'failed' && (
        <button
          type="button"
          className="lantern-btn small"
          disabled={locked}
          onClick={() => void queue.retry(item.key)}
          aria-label={`Retry ${file.name}`}
        >
          <RotateCw
            className="h-3.5 w-3.5"
            strokeWidth={1.7}
            aria-hidden="true"
          />
          Retry
        </button>
      )}
      {(item.state === 'queued' || item.state === 'sending') && (
        <button
          type="button"
          className="lantern-btn ghost small"
          onClick={() => queue.cancel(item.key)}
          aria-label={`Cancel ${file.name}`}
        >
          Cancel
        </button>
      )}
      {(item.state === 'sent' || item.state === 'failed') && (
        <button
          type="button"
          className="lantern-icon-btn compact"
          disabled={locked}
          onClick={() => void queue.remove(item.key)}
          aria-label={`Remove ${file.name}`}
          title="Remove"
        >
          <X className="h-4 w-4" strokeWidth={1.7} />
        </button>
      )}
    </li>
  )
}

/** The files block of a card that asks for photos or files: the shared
 * picker, one row per file, and where the count stands. */
export function AskFilesBlock({
  files,
  disabled,
}: {
  files: AskFilesState
  /** The answer is on its way: nothing can change now. */
  disabled: boolean
}) {
  const { wants, queue, items, notice, failed, held, full } = files
  const { limits } = useCaptureLimits()
  // Paste goes to the card being used, not every card on the page.
  const [active, setActive] = useState(false)
  if (!wants) return null
  return (
    <section
      aria-label="Files"
      data-testid="ask-files"
      className="mb-2 flex flex-col gap-2"
      onPointerEnter={() => setActive(true)}
      onPointerLeave={() => setActive(false)}
      onFocus={() => setActive(true)}
      onBlur={() => setActive(false)}
    >
      <p
        role="status"
        data-testid="ask-files-count"
        className="text-[13px]"
        style={{ color: 'var(--mist)' }}
      >
        <span style={{ color: 'var(--bone)' }}>{countText(held, wants)}</span>
        {wants.hint ? ` · ${wants.hint}` : ''}
      </p>
      <CapturePicker
        accept={limits?.accept}
        disabled={full || disabled}
        paste={active}
        onFiles={(picked) => {
          queue.add(picked, wants.max)
          void queue.send()
        }}
      />
      {notice && (
        <p
          role="status"
          className="text-[12px]"
          style={{ color: 'var(--beacon)' }}
        >
          {notice}
        </p>
      )}
      {items.length > 0 && (
        <ul
          aria-label="Files for this question"
          className="divide-y"
          style={{ borderColor: 'var(--paper-veil)' }}
        >
          {items.map((item) => (
            <Row key={item.key} item={item} queue={queue} locked={disabled} />
          ))}
        </ul>
      )}
      {failed > 0 && (
        <p
          role="alert"
          className="text-[12px]"
          style={{ color: 'var(--term-error-text)' }}
        >
          {failed === 1
            ? '1 file didn’t upload. Retry it or remove it.'
            : `${failed} files didn’t upload. Retry them or remove them.`}
        </p>
      )}
    </section>
  )
}

/** A file the owner sent, small: the thumbnail, else the preview, else an icon. */
function AnsweredFile({ file }: { file: AnswerFile }) {
  const [source, setSource] = useState<'thumb' | 'preview' | 'none'>(
    file.mime.startsWith('image/') ? 'thumb' : 'none',
  )
  return (
    <li
      className="flex w-[84px] flex-col items-center gap-1"
      data-testid="answered-file"
    >
      <a
        href={captureFileUrl(file.id)}
        target="_blank"
        rel="noreferrer noopener"
        className="grid h-14 w-14 place-items-center overflow-hidden rounded-md"
        style={{ background: 'var(--paper)', color: 'var(--mist)' }}
        aria-label={`Open ${file.name}`}
      >
        {source === 'none' ? (
          file.mime.startsWith('image/') ? (
            <ImageIcon
              className="h-5 w-5"
              strokeWidth={1.5}
              aria-hidden="true"
            />
          ) : (
            <FileText
              className="h-5 w-5"
              strokeWidth={1.5}
              aria-hidden="true"
            />
          )
        ) : (
          // biome-ignore lint/performance/noImgElement: the server's small picture, already sized
          <img
            src={
              source === 'thumb'
                ? captureThumbUrl(file.id)
                : capturePreviewUrl(file.id)
            }
            alt=""
            loading="lazy"
            className="h-full w-full object-cover"
            onError={() => setSource(source === 'thumb' ? 'preview' : 'none')}
          />
        )}
      </a>
      <span
        className="w-full truncate text-center text-[11px]"
        style={{ color: 'var(--mist)' }}
        title={file.name}
      >
        {file.name}
      </span>
    </li>
  )
}

/** The files an answered ask went out with. */
export function AnsweredFiles({ files }: { files: readonly AnswerFile[] }) {
  if (files.length === 0) return null
  return (
    <ul
      aria-label="Files you sent"
      className="mt-1.5 flex flex-wrap gap-2"
      data-testid="answered-files"
    >
      {files.map((file) => (
        <AnsweredFile key={file.id} file={file} />
      ))}
    </ul>
  )
}
