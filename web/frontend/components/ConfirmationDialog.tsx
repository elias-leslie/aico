'use client'

import { AlertTriangle } from 'lucide-react'
import { useCallback, useEffect, useRef } from 'react'

interface ConfirmationDialogProps {
  isOpen: boolean
  title: string
  message: string
  confirmText?: string
  cancelText?: string
  variant?: 'danger' | 'warning'
  onConfirm: () => void
  onCancel: () => void
}

/**
 * Confirmation dialog for destructive actions.
 * Supports keyboard navigation (Enter to confirm, Escape to cancel).
 */
export function ConfirmationDialog({
  isOpen,
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  variant = 'danger',
  onConfirm,
  onCancel,
}: ConfirmationDialogProps) {
  const confirmButtonRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  // Focus confirm button when dialog opens
  useEffect(() => {
    if (isOpen) {
      // Small delay to ensure dialog is rendered
      const timer = setTimeout(() => {
        confirmButtonRef.current?.focus()
      }, 10)
      return () => clearTimeout(timer)
    }
  }, [isOpen])

  // Handle keyboard events
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!isOpen) return

      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        onConfirm()
      }
    },
    [isOpen, onCancel, onConfirm],
  )

  useEffect(() => {
    if (!isOpen) return
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, handleKeyDown])

  if (!isOpen) return null

  const accentColor =
    variant === 'danger' ? 'var(--term-error)' : 'var(--term-warning, #f59e0b)'

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center"
      style={{
        backgroundColor: 'var(--term-overlay-backdrop)',
        backdropFilter: 'blur(4px)',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div
        ref={dialogRef}
        data-testid="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-message"
        className="rounded-lg overflow-hidden animate-in fade-in zoom-in-95 duration-150 max-w-md w-full mx-4"
        style={{
          backgroundColor: 'var(--term-bg-elevated)',
          border: `1px solid ${accentColor}`,
          boxShadow: 'var(--term-shadow-modal)',
        }}
      >
        {/* Header */}
        <div
          className="px-4 py-3 flex items-center gap-3"
          style={{
            backgroundColor:
              variant === 'danger'
                ? 'var(--term-danger-soft)'
                : 'color-mix(in srgb, var(--term-warning) 15%, transparent)',
            borderBottom:
              variant === 'danger'
                ? '1px solid var(--term-danger-border)'
                : '1px solid color-mix(in srgb, var(--term-warning) 36%, transparent)',
          }}
        >
          <AlertTriangle
            className="w-5 h-5 flex-shrink-0"
            style={{ color: accentColor }}
          />
          <h2
            id="confirm-dialog-title"
            className="text-sm font-medium"
            style={{
              color: 'var(--term-text-primary)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {title}
          </h2>
        </div>

        {/* Body */}
        <div className="px-4 py-4">
          <p
            id="confirm-dialog-message"
            className="text-sm"
            style={{
              color: 'var(--term-text-muted)',
              fontFamily: 'var(--font-mono)',
              lineHeight: 1.5,
            }}
          >
            {message}
          </p>
        </div>

        {/* Actions */}
        <div
          className="px-4 py-3 flex justify-end gap-2"
          style={{
            backgroundColor: 'var(--term-bg-elevated)',
            borderTop: '1px solid var(--term-border)',
          }}
        >
          <button
            data-testid="confirm-dialog-cancel"
            onClick={onCancel}
            className="px-4 py-2 text-xs rounded-md transition-colors"
            style={{
              backgroundColor: 'transparent',
              color: 'var(--term-text-muted)',
              border: '1px solid var(--term-border)',
              fontFamily: 'var(--font-mono)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = 'var(--term-bg-surface)'
              e.currentTarget.style.color = 'var(--term-text-primary)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'transparent'
              e.currentTarget.style.color = 'var(--term-text-muted)'
            }}
          >
            {cancelText}
          </button>
          <button
            ref={confirmButtonRef}
            data-testid="confirm-dialog-confirm"
            onClick={onConfirm}
            className="px-4 py-2 text-xs rounded-md transition-colors"
            style={{
              backgroundColor: accentColor,
              color: 'var(--term-accent-foreground)',
              border: 'none',
              fontFamily: 'var(--font-mono)',
              fontWeight: 500,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.filter = 'brightness(1.1)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.filter = 'brightness(1)'
            }}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}
