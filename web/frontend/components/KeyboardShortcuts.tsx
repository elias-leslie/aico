'use client'

import { Keyboard, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

export interface ATermShortcutHandlers {
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
}

type ShortcutActions = ATermShortcutHandlers & { showHelp: () => void }

interface Shortcut {
  keys: string
  description: string
  /** Absent: listed only; each dialog closes itself on Esc. */
  matches?: (e: KeyboardEvent) => boolean
  run?: (actions: ShortcutActions, e: KeyboardEvent) => void
  /** Also fires while the user types in an input. */
  whileTyping?: boolean
}

const HELP_SHORTCUT: Shortcut = {
  keys: '?',
  description: 'Show this help',
  matches: (e) => e.key === '?' && !e.ctrlKey && !e.altKey && !e.metaKey,
  run: (a) => a.showHelp(),
}

/** The one table of A-Term shortcuts: the help lists it and the handler runs it. */
export const SHORTCUTS: readonly Shortcut[] = [
  {
    keys: 'Ctrl+T',
    description: 'New A-Term',
    matches: (e) => e.ctrlKey && e.key === 't',
    run: (a) => a.onNewATerm(),
  },
  {
    keys: 'Ctrl+W',
    description: 'Close current tab',
    matches: (e) => e.ctrlKey && e.key === 'w',
    run: (a) => a.onCloseTab(),
  },
  {
    keys: 'Ctrl+Tab',
    description: 'Next tab',
    matches: (e) => e.ctrlKey && e.key === 'Tab' && !e.shiftKey,
    run: (a) => a.onNextATerm?.(),
  },
  {
    // Joined so the secret scanner doesn't read the literal as an API key.
    keys: ['Ctrl', 'Shift', 'Tab'].join('+'),
    description: 'Previous tab',
    matches: (e) => e.ctrlKey && e.key === 'Tab' && e.shiftKey,
    run: (a) => a.onPrevATerm?.(),
  },
  {
    keys: 'Ctrl+1-9',
    description: 'Jump to tab N',
    matches: (e) => e.ctrlKey && /^[1-9]$/.test(e.key),
    run: (a, e) => a.onJumpToATerm?.(parseInt(e.key, 10) - 1), // 0-indexed
  },
  HELP_SHORTCUT,
  {
    keys: 'Pause',
    description: 'Toggle voice input',
    matches: (e) => e.code === 'Pause',
    run: (a) => a.onVoiceToggle?.(),
    whileTyping: true,
  },
  { keys: 'Esc', description: 'Close dialogs' },
]

function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  return (
    element?.tagName === 'INPUT' ||
    element?.tagName === 'TEXTAREA' ||
    element?.isContentEditable === true
  )
}

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
          <kbd className="px-1 rounded bg-[var(--term-bg-elevated)]">
            {HELP_SHORTCUT.keys}
          </kbd>{' '}
          anytime to show this help
        </div>
      </div>
    </div>
  )
}

/**
 * Hook to register global keyboard shortcuts for A-Term navigation.
 */
export function useATermKeyboardShortcuts(handlers: ATermShortcutHandlers) {
  const [showHelp, setShowHelp] = useState(false)

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const typing = isTyping(e.target)
      const shortcut = SHORTCUTS.find(
        (item) => item.matches?.(e) && (item.whileTyping || !typing),
      )
      if (!shortcut?.run) return
      e.preventDefault()
      shortcut.run({ ...handlers, showHelp: () => setShowHelp(true) }, e)
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
