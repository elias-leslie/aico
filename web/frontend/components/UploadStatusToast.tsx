'use client'

import { AlertTriangle, X } from 'lucide-react'
import { useEffect } from 'react'
import type { UploadDone } from '@/lib/hooks/use-terminal-action-handlers'

const TOAST_BASE_CLASSES =
  'lantern-sheet lantern-enter absolute top-14 left-1/2 z-50 w-[calc(100%-20px)] max-w-md -translate-x-1/2 rounded-xl px-3.5 py-2.5'

interface UploadProgressToastProps {
  progress: number
}

export function UploadProgressToast({ progress }: UploadProgressToastProps) {
  return (
    <div
      data-testid="upload-progress-toast"
      role="status"
      aria-label={`Uploading file: ${progress}%`}
      className={TOAST_BASE_CLASSES}
    >
      <div className="flex items-center justify-between gap-2 text-[13px]">
        <span>Uploading</span>
        <span style={{ color: 'var(--mist)', fontFamily: 'var(--font-mono)' }}>
          {progress}%
        </span>
      </div>
      <div
        className="mt-2 h-1 overflow-hidden rounded-full"
        style={{ backgroundColor: 'var(--paper-veil)' }}
      >
        <div
          className="h-full rounded-full transition-[width] duration-200 ease-out"
          style={{ width: `${progress}%`, backgroundColor: 'var(--lantern)' }}
        />
      </div>
    </div>
  )
}

interface UploadErrorToastProps {
  message: string
  onDismiss?: () => void
}

export function UploadErrorToast({
  message,
  onDismiss,
}: UploadErrorToastProps) {
  return (
    <div
      data-testid="upload-error-toast"
      role="alert"
      className={TOAST_BASE_CLASSES}
    >
      <div className="flex items-center gap-2.5">
        {/* Ember text on umber is under 4.5:1: the icon carries it. */}
        <AlertTriangle
          aria-hidden="true"
          className="h-4 w-4 flex-none"
          strokeWidth={1.7}
          style={{ color: 'var(--ember)' }}
        />
        <span className="flex-1 text-[13px]">{message}</span>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className="lantern-icon-btn compact -my-1.5 -mr-1.5"
            aria-label="Dismiss error"
          >
            <X className="h-4 w-4" strokeWidth={1.7} />
          </button>
        )}
      </div>
    </div>
  )
}

/** How long the confirmation stays before it goes by itself. */
export const UPLOAD_DONE_MS = 6000

/** Where a finished upload landed: its name, the host, and the path the session reads. */
export function UploadDoneToast({
  upload,
  onDismiss,
}: {
  upload: UploadDone
  onDismiss: () => void
}) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, UPLOAD_DONE_MS)
    return () => clearTimeout(timer)
  }, [onDismiss])
  return (
    <div
      data-testid="upload-done-toast"
      role="status"
      className={TOAST_BASE_CLASSES}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 text-[13px]">
          <p className="m-0 break-words" dir="auto">
            {upload.host
              ? `Sent ${upload.name} to ${upload.host}`
              : `Uploaded ${upload.name}`}
          </p>
          <p
            className="m-0 mt-1 break-all text-xs"
            style={{ color: 'var(--mist)', fontFamily: 'var(--font-mono)' }}
          >
            {upload.path}
          </p>
          {upload.typed && (
            <p className="m-0 mt-1 text-xs" style={{ color: 'var(--mist)' }}>
              Path typed into the session, not sent.
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="lantern-icon-btn compact -my-1.5 -mr-1.5"
          aria-label="Dismiss"
        >
          <X className="h-4 w-4" strokeWidth={1.7} />
        </button>
      </div>
    </div>
  )
}
