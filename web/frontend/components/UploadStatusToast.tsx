'use client'

import { Loader2, X } from 'lucide-react'

const TOAST_BASE_CLASSES =
  'absolute top-10 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-md shadow-lg'

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
      style={{
        backgroundColor: 'var(--term-bg-elevated)',
        border: '1px solid var(--term-border)',
      }}
    >
      <div className="flex items-center gap-2">
        <Loader2
          className="w-4 h-4 animate-spin"
          style={{ color: 'var(--term-accent)' }}
        />
        <span className="text-sm" style={{ color: 'var(--term-text-primary)' }}>
          Uploading... {progress}%
        </span>
      </div>
      {/* Progress bar */}
      <div
        className="mt-1.5 h-1 rounded-full overflow-hidden"
        style={{ backgroundColor: 'var(--term-bg-deep)' }}
      >
        <div
          className="h-full rounded-full transition-all duration-300 ease-out"
          style={{
            width: `${progress}%`,
            backgroundColor: 'var(--term-accent)',
          }}
        />
      </div>
    </div>
  )
}

interface UploadErrorToastProps {
  message: string
  onDismiss?: () => void
}

export function UploadErrorToast({ message, onDismiss }: UploadErrorToastProps) {
  return (
    <div
      data-testid="upload-error-toast"
      role="alert"
      className={TOAST_BASE_CLASSES}
      style={{
        backgroundColor: 'var(--term-bg-elevated)',
        border: '1px solid var(--term-error)',
      }}
    >
      <div className="flex items-center gap-2">
        <span className="text-sm flex-1" style={{ color: 'var(--term-error)' }}>
          {message}
        </span>
        {onDismiss && (
          <button
            onClick={onDismiss}
            className="flex-shrink-0 p-0.5 rounded transition-colors hover:bg-white/5"
            style={{ color: 'var(--term-text-muted)' }}
            aria-label="Dismiss error"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}
