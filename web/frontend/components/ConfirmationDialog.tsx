'use client'

import * as Dialog from '@radix-ui/react-dialog'
import { AlertTriangle } from 'lucide-react'
import { useId, useRef } from 'react'

interface ConfirmationDialogProps {
  isOpen: boolean
  title: string
  message: string
  confirmText?: string
  /** A second way to confirm, between Cancel and the main button. */
  secondaryText?: string
  onSecondary?: () => void
  cancelText?: string
  variant?: 'danger' | 'warning'
  isPending?: boolean
  error?: string | null
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
  secondaryText,
  onSecondary,
  cancelText = 'Cancel',
  variant = 'danger',
  isPending = false,
  error = null,
  onConfirm,
  onCancel,
}: ConfirmationDialogProps) {
  const titleId = useId()
  const messageId = useId()
  const confirmButtonRef = useRef<HTMLButtonElement>(null)
  const accentColor = variant === 'danger' ? 'var(--ember)' : 'var(--beacon)'

  return (
    <Dialog.Root
      open={isOpen}
      onOpenChange={(open) => {
        if (!open && !isPending) onCancel()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-[10000]"
          style={{ backgroundColor: 'var(--scrim)' }}
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
          <div className="lantern-sheet lantern-enter w-full max-w-sm rounded-xl p-5">
            <div className="flex items-start gap-3">
              <AlertTriangle
                className="mt-0.5 h-5 w-5 flex-shrink-0"
                strokeWidth={1.7}
                style={{ color: accentColor }}
              />
              <div className="min-w-0">
                <Dialog.Title
                  id={titleId}
                  style={{
                    font: '500 17px/1.25 var(--font-display)',
                    color: 'var(--bone)',
                  }}
                >
                  {title}
                </Dialog.Title>
                <Dialog.Description
                  id={messageId}
                  className="mt-1.5 text-[13px] leading-normal"
                  style={{ color: 'var(--mist)' }}
                >
                  {message}
                </Dialog.Description>
                {error && (
                  <p
                    role="alert"
                    className="mt-3 text-[13px]"
                    style={{ color: 'var(--bone)' }}
                  >
                    {error}
                  </p>
                )}
              </div>
            </div>

            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                data-testid="confirm-dialog-cancel"
                onClick={onCancel}
                disabled={isPending}
                className="lantern-btn ghost"
              >
                {cancelText}
              </button>
              {secondaryText && onSecondary && (
                <button
                  type="button"
                  data-testid="confirm-dialog-secondary"
                  onClick={onSecondary}
                  disabled={isPending}
                  className="lantern-btn"
                >
                  {secondaryText}
                </button>
              )}
              <button
                type="button"
                ref={confirmButtonRef}
                data-testid="confirm-dialog-confirm"
                onClick={onConfirm}
                disabled={isPending}
                aria-busy={isPending}
                className="lantern-btn"
                style={{
                  borderColor: accentColor,
                  backgroundColor: `color-mix(in srgb, ${accentColor} 16%, transparent)`,
                }}
              >
                {isPending ? 'Ending session…' : confirmText}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
