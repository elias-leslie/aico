'use client'

import { Upload } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'

interface FileUploadDropzoneProps {
  children: React.ReactNode
  onFileSelect: (file: File) => void
  disabled?: boolean
  className?: string
}

function isFileDragEvent(event: React.DragEvent): boolean {
  const types = Array.from(event.dataTransfer?.types ?? [])
  if (types.includes('Files')) {
    return true
  }

  return Array.from(event.dataTransfer?.items ?? []).some(
    (item) => item.kind === 'file',
  )
}

/**
 * Wraps content with drag-and-drop file upload support.
 * Shows overlay when dragging files over the drop zone.
 */
export function FileUploadDropzone({
  children,
  onFileSelect,
  disabled = false,
  className = '',
}: FileUploadDropzoneProps) {
  const [isDragging, setIsDragging] = useState(false)
  const dragCounter = useRef(0)

  const handleDragEnter = useCallback(
    (e: React.DragEvent) => {
      if (disabled) return
      if (!isFileDragEvent(e)) return

      e.preventDefault()
      e.stopPropagation()

      dragCounter.current++
      if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
        setIsDragging(true)
      }
    },
    [disabled],
  )

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (dragCounter.current === 0) return

    e.preventDefault()
    e.stopPropagation()

    dragCounter.current--
    if (dragCounter.current === 0) {
      setIsDragging(false)
    }
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!isFileDragEvent(e)) return

    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      if (e.defaultPrevented || !isFileDragEvent(e)) return

      e.preventDefault()
      e.stopPropagation()

      setIsDragging(false)
      dragCounter.current = 0

      if (disabled) return

      const files = e.dataTransfer.files
      if (files && files.length > 0) {
        // Only handle first file
        onFileSelect(files[0])
      }
    },
    [disabled, onFileSelect],
  )

  return (
    <div
      className={`relative ${className}`}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {children}

      {/* Drag overlay: the terminal notice look, with an amber edge */}
      {isDragging && (
        <div
          className="lantern-term-notice"
          style={{ boxShadow: 'inset 0 0 0 1px var(--lantern)', zIndex: 50 }}
          role="status"
        >
          <Upload
            aria-hidden="true"
            className="mb-1 h-6 w-6"
            strokeWidth={1.7}
            style={{ color: 'var(--lantern)' }}
          />
          <p className="t">Drop a file to upload it</p>
          <p className="d">Its path goes into the session.</p>
        </div>
      )}
    </div>
  )
}
