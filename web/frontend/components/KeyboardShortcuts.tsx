'use client'

import { Keyboard, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

interface Shortcut {
  keys: string
  description: string
}

const SHORTCUTS: Shortcut[] = [
  { keys: 'Ctrl+T', description: 'New A-Term' },
  { keys: 'Ctrl+W', description: 'Close current tab' },
  { keys: 'Ctrl+Tab', description: 'Next tab' },
  { keys: 'Ctrl+Shift+Tab', description: 'Previous tab' },
  { keys: 'Ctrl+1-9', description: 'Jump to tab N' },
  { keys: '?', description: 'Show this help' },
  { keys: 'Pause', description: 'Toggle voice input' },
  { keys: 'Esc', description: 'Close dialogs' },
]

interface KeyboardShortcutsProps {
  isOpen: boolean
  onClose: () => void
}

export function KeyboardShortcuts({ isOpen, onClose }: KeyboardShortcutsProps) {
  // Close on escape
  useEffect(() => {
    if (!isOpen) return

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center"
      style={{
        backgroundColor: 'var(--term-overlay-backdrop)',
        backdropFilter: 'blur(4px)',
      }}
      onClick={onClose}
    >
      <div
        data-testid="keyboard-shortcuts-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="keyboard-shortcuts-title"
        className="w-full max-w-md mx-4 rounded-lg overflow-hidden shadow-2xl"
        style={{
          backgroundColor: 'var(--term-bg-surface)',
          border: '1px solid var(--term-border)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-4 py-3"
          style={{
            backgroundColor: 'var(--term-bg-elevated)',
            borderBottom: '1px solid var(--term-border)',
          }}
        >
          <div className="flex items-center gap-2">
            <Keyboard
              className="w-5 h-5"
              style={{ color: 'var(--term-accent)' }}
            />
            <span
              id="keyboard-shortcuts-title"
              className="font-medium"
              style={{ color: 'var(--term-text-primary)' }}
            >
              Keyboard Shortcuts
            </span>
          </div>
          <button
            data-testid="keyboard-shortcuts-modal-close"
            onClick={onClose}
            className="p-1.5 rounded hover:bg-[var(--term-bg-deep)] transition-colors"
            style={{ color: 'var(--term-text-muted)' }}
            aria-label="Close keyboard shortcuts"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Shortcuts list */}
        <div className="p-4 space-y-1">
          {SHORTCUTS.map((shortcut) => (
            <div
              key={shortcut.keys}
              className="flex items-center justify-between py-2 px-2 rounded-md"
              style={{ transition: 'background-color 0.1s ease' }}
            >
              <span
                className="text-sm"
                style={{ color: 'var(--term-text-muted)' }}
              >
                {shortcut.description}
              </span>
              <kbd
                className="px-2.5 py-1 text-xs font-mono rounded-md ml-4 flex-shrink-0"
                style={{
                  backgroundColor: 'var(--term-bg-deep)',
                  border: '1px solid var(--term-border)',
                  color: 'var(--term-text-primary)',
                  boxShadow: 'var(--term-kbd-shadow)',
                }}
              >
                {shortcut.keys}
              </kbd>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div
          className="px-4 py-2 text-xs text-center"
          style={{
            backgroundColor: 'var(--term-bg-deep)',
            color: 'var(--term-text-muted)',
          }}
        >
          Press{' '}
          <kbd className="px-1 rounded bg-[var(--term-bg-elevated)]">?</kbd>{' '}
          anytime to show this help
        </div>
      </div>
    </div>
  )
}

/**
 * Hook to register global keyboard shortcuts for A-Term navigation.
 */
export function useATermKeyboardShortcuts(handlers: {
  onNewATerm: () => void
  onCloseTab: () => void
  /** Switch to next A-Term (Ctrl+Tab) */
  onNextATerm?: () => void
  /** Switch to previous A-Term (Ctrl+Shift+Tab) */
  onPrevATerm?: () => void
  /** Jump to A-Term at position (Ctrl+1-9) */
  onJumpToATerm?: (index: number) => void
  /** Toggle voice input (Pause key) */
  onVoiceToggle?: () => void
}) {
  const [showHelp, setShowHelp] = useState(false)

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Pause key toggles voice input — works regardless of focus
      if (e.code === 'Pause') {
        e.preventDefault()
        handlers.onVoiceToggle?.()
        return
      }

      // Don't trigger other shortcuts if user is typing in an input
      const target = e.target as HTMLElement
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      ) {
        return
      }

      // ? to show help (only without modifiers)
      if (e.key === '?' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault()
        setShowHelp(true)
        return
      }

      // Ctrl+T for new A-Term
      if (e.ctrlKey && e.key === 't') {
        e.preventDefault()
        handlers.onNewATerm()
        return
      }

      // Ctrl+W to close tab
      if (e.ctrlKey && e.key === 'w') {
        e.preventDefault()
        handlers.onCloseTab()
        return
      }

      // Ctrl+Tab for next A-Term
      if (e.ctrlKey && e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault()
        handlers.onNextATerm?.()
        return
      }

      // Ctrl+Shift+Tab for previous A-Term
      if (e.ctrlKey && e.key === 'Tab' && e.shiftKey) {
        e.preventDefault()
        handlers.onPrevATerm?.()
        return
      }

      // Ctrl+1-9 to jump to A-Term at position
      if (e.ctrlKey && /^[1-9]$/.test(e.key)) {
        e.preventDefault()
        handlers.onJumpToATerm?.(parseInt(e.key, 10) - 1) // 0-indexed
        return
      }
    },
    [handlers],
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  return {
    showHelp,
    setShowHelp,
    closeHelp: () => setShowHelp(false),
  }
}
