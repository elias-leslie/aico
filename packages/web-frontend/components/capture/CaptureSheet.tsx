'use client'

import * as Dialog from '@radix-ui/react-dialog'
import { clsx } from 'clsx'
import { Check, Mic, RotateCw, X } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useId, useRef, useState } from 'react'
import { formatBytes } from '@/lib/capture-format'
import {
  addCaptureFiles,
  captureQueueLeft,
  type QueueItem,
  removeCaptureFile,
  resetCaptureQueue,
  sendCaptureQueue,
  setCaptureCaption,
  useCaptureQueue,
} from '@/lib/capture-queue'
import { useCaptureLimits, useRefreshCaptures } from '@/lib/hooks/use-captures'
import { useMediaQuery } from '@/lib/hooks/use-media-query'
import { SheetHandle } from '../SheetChrome'
import { CapturePicker } from './CapturePicker'
import { FileThumb } from './CaptureThumb'

const CAPTION_MAX = 4000

interface Recognition {
  lang: string
  interimResults: boolean
  continuous: boolean
  onresult:
    | ((event: {
        results: ArrayLike<ArrayLike<{ transcript: string }>> & {
          length: number
        }
      }) => void)
    | null
  onend: (() => void) | null
  onerror: (() => void) | null
  start: () => void
  stop: () => void
}
type RecognitionCtor = new () => Recognition

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null
  const scope = window as unknown as {
    SpeechRecognition?: RecognitionCtor
    webkitSpeechRecognition?: RecognitionCtor
  }
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null
}

/** Dictation into the caption where the browser offers it. The phone
 * keyboard's own dictation works regardless. */
function DictationButton({ onText }: { onText: (text: string) => void }) {
  const [listening, setListening] = useState(false)
  const [available, setAvailable] = useState(false)
  const active = useRef<Recognition | null>(null)
  useEffect(() => {
    setAvailable(recognitionCtor() !== null)
    return () => active.current?.stop()
  }, [])
  if (!available) return null
  const toggle = () => {
    if (active.current) {
      active.current.stop()
      return
    }
    const Ctor = recognitionCtor()
    if (!Ctor) return
    const recognition = new Ctor()
    recognition.lang = navigator.language || 'en-US'
    recognition.interimResults = false
    recognition.continuous = false
    recognition.onresult = (event) => {
      const parts: string[] = []
      for (let i = 0; i < event.results.length; i += 1)
        parts.push(event.results[i][0].transcript)
      onText(parts.join(' ').trim())
    }
    const done = () => {
      active.current = null
      setListening(false)
    }
    recognition.onend = done
    recognition.onerror = done
    active.current = recognition
    setListening(true)
    recognition.start()
  }
  return (
    <button
      type="button"
      className="lantern-icon-btn compact"
      aria-pressed={listening}
      aria-label={listening ? 'Stop dictating' : 'Dictate the caption'}
      title={listening ? 'Stop dictating' : 'Dictate the caption'}
      onClick={toggle}
      style={listening ? { color: 'var(--lantern)' } : undefined}
    >
      <Mic className="h-[18px] w-[18px]" strokeWidth={1.7} />
    </button>
  )
}

function Row({ item, locked }: { item: QueueItem; locked: boolean }) {
  const status =
    item.state === 'queued'
      ? 'Waiting'
      : item.state === 'sending'
        ? item.progress >= 100
          ? 'Saving…'
          : `Sending ${item.progress}%`
        : item.state === 'sent'
          ? 'Sent'
          : (item.error ?? "Couldn't send it")
  return (
    <li
      className="flex items-center gap-3 py-2"
      data-testid="capture-row"
      data-state={item.state}
    >
      <FileThumb file={item.file} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px]" style={{ color: 'var(--bone)' }}>
          {item.file.name}
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
          {formatBytes(item.file.size)} · {status}
        </p>
        {item.state === 'sending' && (
          <progress
            className="mt-1 h-1 w-full accent-[var(--lantern)]"
            max={100}
            value={item.progress}
            aria-label={`Sending ${item.file.name}`}
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
          onClick={() => void sendCaptureQueue(item.key)}
          aria-label={`Retry ${item.file.name}`}
        >
          <RotateCw
            className="h-3.5 w-3.5"
            strokeWidth={1.7}
            aria-hidden="true"
          />
          Retry
        </button>
      )}
      {(item.state === 'queued' || item.state === 'failed') && (
        <button
          type="button"
          className="lantern-icon-btn compact"
          disabled={locked}
          onClick={() => removeCaptureFile(item.key)}
          aria-label={`Remove ${item.file.name}`}
          title="Remove"
        >
          <X className="h-4 w-4" strokeWidth={1.7} />
        </button>
      )}
    </li>
  )
}

/** Take a photo or choose files, add a caption, send. The queue lives outside
 * the sheet, so closing it keeps the draft and any send in progress. */
export function CaptureSheet({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const isMobile = useMediaQuery('(max-width: 767px)')
  const captionId = useId()
  const { items, caption, notice, sending } = useCaptureQueue()
  const { limits, isError: limitsFailed } = useCaptureLimits()
  const refresh = useRefreshCaptures()

  // The list behind the sheet reloads when a send finishes.
  const wasSending = useRef(false)
  useEffect(() => {
    if (wasSending.current && !sending) void refresh()
    wasSending.current = sending
  }, [sending, refresh])

  const left = captureQueueLeft(items)
  const sent = items.filter((item) => item.state === 'sent').length
  const failed = items.filter((item) => item.state === 'failed').length
  const allSent = items.length > 0 && left === 0

  let summary: string | null = null
  if (!sending && sent > 0 && !allSent)
    summary = `${sent} of ${items.length} sent.${failed ? ` ${failed} failed.` : ''}`
  else if (!sending && allSent)
    summary = items.length === 1 ? 'Sent.' : `All ${items.length} sent.`

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-[10000]"
          style={{ backgroundColor: 'var(--scrim)' }}
        />
        <Dialog.Content
          data-testid="capture-sheet"
          aria-describedby={undefined}
          className={clsx(
            'lantern-sheet fixed z-[10001] flex flex-col overflow-hidden outline-none',
            isMobile
              ? 'lantern-rise inset-x-0 bottom-0 max-h-[92dvh] rounded-t-[14px]'
              : 'lantern-enter top-1/2 left-1/2 max-h-[min(90dvh,720px)] w-[min(94vw,520px)] -translate-x-1/2 -translate-y-1/2 rounded-xl',
          )}
          style={{ color: 'var(--bone)' }}
        >
          {isMobile && <SheetHandle />}
          <div className="flex items-center gap-3 pt-3.5 pr-2 pb-2 pl-[18px]">
            <Dialog.Title style={{ font: '500 18px/1.2 var(--font-display)' }}>
              Capture
            </Dialog.Title>
            <Link
              href="/captures"
              className="min-w-0 flex-1 text-[12px] underline underline-offset-2"
              style={{ color: 'var(--mist)' }}
              onClick={() => onOpenChange(false)}
            >
              See captures
            </Link>
            <Dialog.Close aria-label="Close" className="lantern-icon-btn">
              <X className="h-[18px] w-[18px]" strokeWidth={1.7} />
            </Dialog.Close>
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-[18px] pb-[18px]">
            <CapturePicker
              accept={limits?.accept}
              disabled={sending}
              onFiles={addCaptureFiles}
            />
            {limitsFailed && (
              <p className="text-[12px]" style={{ color: 'var(--mist)' }}>
                Couldn&apos;t read Aico&apos;s file limits. Files are still
                checked when they are sent.
              </p>
            )}
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
                aria-label="Files to send"
                className="divide-y"
                style={{ borderColor: 'var(--paper-veil)' }}
              >
                {items.map((item) => (
                  <Row key={item.key} item={item} locked={sending} />
                ))}
              </ul>
            )}

            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <label
                  htmlFor={captionId}
                  className="text-[12px]"
                  style={{ color: 'var(--mist)' }}
                >
                  Caption (optional
                  {items.length > 1 ? ', added to each file' : ''})
                </label>
                <DictationButton
                  onText={(text) =>
                    setCaptureCaption(`${caption}${caption ? ' ' : ''}${text}`)
                  }
                />
              </div>
              <textarea
                id={captionId}
                rows={3}
                maxLength={CAPTION_MAX}
                value={caption}
                disabled={sending}
                onChange={(event) => setCaptureCaption(event.target.value)}
                className="w-full resize-none rounded-md px-3 py-2 text-[14px] outline-none focus-visible:border-[var(--lantern)] disabled:opacity-50"
                style={{
                  background: 'rgb(var(--ink-rgb) / 0.86)',
                  border: '1px solid var(--paper-veil)',
                  color: 'var(--bone)',
                }}
              />
            </div>

            <div className="flex items-center gap-3">
              <p
                role="status"
                className="min-w-0 flex-1 text-[12px]"
                style={{
                  color: failed ? 'var(--term-error-text)' : 'var(--mist)',
                }}
              >
                {sending
                  ? `Sending ${left} ${left === 1 ? 'file' : 'files'}…`
                  : summary}
              </p>
              {allSent ? (
                <button
                  type="button"
                  className="lantern-btn min-h-11"
                  onClick={resetCaptureQueue}
                >
                  Add more
                </button>
              ) : (
                <button
                  type="button"
                  className="lantern-btn primary min-h-11"
                  disabled={sending || left === 0}
                  onClick={() => void sendCaptureQueue()}
                >
                  {left > 1 ? `Send ${left} files` : 'Send'}
                </button>
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
