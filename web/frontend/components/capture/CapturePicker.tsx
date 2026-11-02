'use client'

import { clsx } from 'clsx'
import { Camera, FilePlus2 } from 'lucide-react'
import { type DragEvent, useEffect, useRef, useState } from 'react'
import { useMediaQuery } from '@/lib/hooks/use-media-query'

/** A real picker, not a button that clicks a hidden one: the file input sits
 * inside its label, so it opens on a tap, takes focus from the keyboard and
 * works the same in Safari. */
function PickerControl({
  label,
  icon,
  disabled,
  onFiles,
  multiple,
  accept,
  capture,
}: {
  label: string
  icon: React.ReactNode
  disabled: boolean
  onFiles: (files: File[]) => void
  multiple?: boolean
  accept?: string
  capture?: 'environment'
}) {
  return (
    <label
      className={clsx(
        'lantern-btn min-h-11 flex-1 cursor-pointer has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--lantern)]',
        disabled && 'pointer-events-none opacity-50',
      )}
    >
      {icon}
      {label}
      <input
        type="file"
        className="sr-only"
        disabled={disabled}
        multiple={multiple}
        accept={accept}
        capture={capture}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          // Cleared, so choosing the same file again still counts.
          event.target.value = ''
          if (files.length > 0) onFiles(files)
        }}
      />
    </label>
  )
}

/** Files pasted from the clipboard (a screenshot, a copied file). */
function pastedFiles(event: ClipboardEvent): File[] {
  return Array.from(event.clipboardData?.files ?? [])
}

/**
 * The two ways in, equal: Take photo (on a touch screen) and Choose files
 * (a multi-select of library photos, PDFs and documents). A computer also
 * takes dropped and pasted files. Shared by the Capture sheet and the ask
 * cards that want files.
 */
export function CapturePicker({
  accept,
  disabled = false,
  onFiles,
  className,
}: {
  /** From the server's table (`GET /api/captures/limits`); unset until it loads. */
  accept?: string
  disabled?: boolean
  onFiles: (files: File[]) => void
  className?: string
}) {
  const touch = useMediaQuery('(any-pointer: coarse)')
  const [dragging, setDragging] = useState(false)
  const onFilesRef = useRef(onFiles)
  onFilesRef.current = onFiles

  useEffect(() => {
    if (disabled) return
    const paste = (event: ClipboardEvent) => {
      const files = pastedFiles(event)
      if (files.length === 0) return
      event.preventDefault()
      onFilesRef.current(files)
    }
    window.addEventListener('paste', paste)
    return () => window.removeEventListener('paste', paste)
  }, [disabled])

  const drop = (event: DragEvent) => {
    event.preventDefault()
    setDragging(false)
    if (disabled) return
    const files = Array.from(event.dataTransfer.files)
    if (files.length > 0) onFiles(files)
  }

  return (
    <section
      aria-label="Add photos or files"
      data-testid="capture-picker"
      data-dragging={dragging || undefined}
      className={clsx('flex flex-col gap-2', className)}
      onDragOver={(event) => {
        event.preventDefault()
        if (!disabled) setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={drop}
    >
      <div className="flex gap-2">
        {touch && (
          <PickerControl
            label="Take photo"
            icon={
              <Camera
                className="h-4 w-4"
                strokeWidth={1.7}
                aria-hidden="true"
              />
            }
            disabled={disabled}
            accept="image/*"
            capture="environment"
            onFiles={onFiles}
          />
        )}
        <PickerControl
          label="Choose files"
          icon={
            <FilePlus2
              className="h-4 w-4"
              strokeWidth={1.7}
              aria-hidden="true"
            />
          }
          disabled={disabled}
          multiple
          accept={accept}
          onFiles={onFiles}
        />
      </div>
      {!touch && (
        <p
          className="rounded-md px-3 py-2 text-center text-[12px]"
          style={{
            color: 'var(--mist)',
            border: `1px dashed ${dragging ? 'var(--lantern)' : 'var(--paper-veil)'}`,
          }}
        >
          Or drop files here, or paste an image
        </p>
      )}
    </section>
  )
}
