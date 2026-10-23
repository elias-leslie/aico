'use client'

import { AlertTriangle, X } from 'lucide-react'

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
