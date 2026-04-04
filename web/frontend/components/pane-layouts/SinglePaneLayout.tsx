'use client'

import type { PaneSlot, TerminalSlot } from '@/lib/utils/slot'

interface SinglePaneLayoutProps {
  containerRef: React.RefObject<HTMLDivElement | null>
  slot: TerminalSlot | PaneSlot
  renderPane: (slot: TerminalSlot | PaneSlot, index: number) => React.ReactNode
}

/**
 * Single pane layout (no resize handles).
 */
export function SinglePaneLayout({
  containerRef,
  slot,
  renderPane,
}: SinglePaneLayoutProps) {
  return (
    <div
      ref={containerRef}
      className="w-full h-full p-1"
      style={{ backgroundColor: 'var(--term-bg-deep)' }}
    >
      {renderPane(slot, 0)}
    </div>
  )
}
