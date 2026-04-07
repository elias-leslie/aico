'use client'

import * as Dialog from '@radix-ui/react-dialog'
import { AlertTriangle } from 'lucide-react'
import { useId, useRef } from 'react'

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
 * Uses Radix Dialog for focus trapping and restore.
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
  const titleId = useId()
  const messageId = useId()
  const confirmButtonRef = useRef<HTMLButtonElement>(null)
  const accentColor =
    variant === 'danger' ? 'var(--term-error)' : 'var(--term-warning, #f59e0b)'

  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => { if (!open) onCancel() }}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-[10000]"
          style={{
            backgroundColor: 'var(--term-overlay-backdrop)',
            backdropFilter: 'blur(4px)',
          }}
        />
        <Dialog.Content
          data-testid="confirm-dialog"
          aria-labelledby={titleId}
          aria-describedby={messageId}
          className="fixed inset-0 z-[10001] flex items-center justify-center p-4 outline-none"
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            confirmButtonRef.current?.focus()
          }}
        >
          <div
            className="w-full max-w-md overflow-hidden rounded-lg animate-in fade-in zoom-in-95 duration-150"
            style={{
              backgroundColor: 'var(--term-bg-elevated)',
              border: `1px solid ${accentColor}`,
              boxShadow: 'var(--term-shadow-modal)',
            }}
          >
            <div
              className="flex items-center gap-3 px-4 py-3"
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
                className="h-5 w-5 flex-shrink-0"
                style={{ color: accentColor }}
              />
              <Dialog.Title
                id={titleId}
                className="text-sm font-medium"
                style={{
                  color: 'var(--term-text-primary)',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                {title}
              </Dialog.Title>
            </div>

            <div className="px-4 py-4">
              <Dialog.Description
                id={messageId}
                className="text-sm"
                style={{
                  color: 'var(--term-text-muted)',
                  fontFamily: 'var(--font-mono)',
                  lineHeight: 1.5,
                }}
              >
                {message}
              </Dialog.Description>
            </div>

            <div
              className="flex justify-end gap-2 px-4 py-3"
              style={{
                backgroundColor: 'var(--term-bg-elevated)',
                borderTop: '1px solid var(--term-border)',
              }}
            >
              <button
                type="button"
                data-testid="confirm-dialog-cancel"
                onClick={onCancel}
                className="rounded-md px-4 py-2 text-xs transition-colors"
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
                type="button"
                ref={confirmButtonRef}
                data-testid="confirm-dialog-confirm"
                onClick={onConfirm}
                className="rounded-md px-4 py-2 text-xs font-medium transition-colors"
                style={{
                  backgroundColor: accentColor,
                  color: 'var(--term-accent-foreground)',
                  border: 'none',
                  fontFamily: 'var(--font-mono)',
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
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
