'use client'

import { Terminal } from 'lucide-react'

interface EmptyPaneStateProps {
  containerRef: React.RefObject<HTMLDivElement | null>
  onOpenModal?: () => void
}

/**
 * Empty state when no panes are displayed.
 */
export function EmptyPaneState({
  containerRef,
  onOpenModal,
}: EmptyPaneStateProps) {
  return (
    <div
      ref={containerRef}
      className="w-full h-full flex items-center justify-center p-4"
      style={{ backgroundColor: 'var(--term-bg-deep)' }}
    >
      <button
        type="button"
        onClick={onOpenModal}
        aria-label="Open terminal manager to create a new terminal"
        className="flex flex-col items-center gap-4 p-8 rounded-lg cursor-pointer transition-all duration-200 hover:scale-[1.02]"
        style={{
          backgroundColor: 'var(--term-bg-surface)',
          border: '1px dashed var(--term-border-active)',
        }}
      >
        <div
          className="flex items-center justify-center w-14 h-14 rounded-full"
          style={{
            backgroundColor: 'var(--term-bg-elevated)',
            border: '1px solid var(--term-border)',
          }}
        >
          <Terminal
            className="w-6 h-6"
            style={{ color: 'var(--term-accent)' }}
          />
        </div>
        <div className="text-center">
          <span
            className="block text-sm font-medium mb-1"
            style={{ color: 'var(--term-text-primary)' }}
          >
            Open a terminal
          </span>
          <span
            className="block text-xs"
            style={{ color: 'var(--term-text-muted)' }}
          >
            Create or attach to a session
          </span>
        </div>
      </button>
    </div>
  )
}
