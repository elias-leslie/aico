'use client'

import type { ATermTheme } from '../lib/constants/a-term'
import { useScrollbackATerm } from '../lib/hooks/use-scrollback-a-term'
import { useScrollbackGestures } from '../lib/hooks/use-scrollback-gestures'

interface ScrollbackOverlayProps {
  isActive: boolean
  lines: string[]
  totalLines: number
  isLoading: boolean
  initialScrollLineDelta: number
  searchQuery: string
  searchActiveIndex: number
  onDismiss: () => void
  theme: ATermTheme
  fontFamily?: string
  fontSize?: number
}

export function ScrollbackOverlay({
  isActive,
  lines,
  totalLines,
  isLoading,
  initialScrollLineDelta,
  searchQuery,
  searchActiveIndex,
  onDismiss,
  theme,
  fontFamily = "'JetBrains Mono', monospace",
  fontSize = 14,
}: ScrollbackOverlayProps) {
  const { containerRef, xtermRef, flushPendingLines } = useScrollbackATerm({
    isActive,
    lines,
    initialScrollLineDelta,
    searchQuery,
    searchActiveIndex,
    theme,
    fontFamily,
    fontSize,
  })

  useScrollbackGestures({
    containerRef,
    isActive,
    xtermRef,
    flushPendingLines,
    onDismiss,
  })

  if (!isActive) return null

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 10,
        display: 'flex',
        flexDirection: 'column',
        background: theme.background,
      }}
    >
      {/* Info bar */}
      {lines.length > 0 && totalLines > lines.length && (
        <div
          style={{
            padding: '4px 12px',
            background: theme.background,
            color: theme.brightBlack,
            fontSize: '11px',
            textAlign: 'center',
            borderBottom: `1px solid ${theme.brightBlack}40`,
            flexShrink: 0,
          }}
        >
          Showing {lines.length} of {totalLines} lines
        </div>
      )}

      {/* Loading state */}
      {isLoading && (
        <div
          style={{
            padding: '12px',
            color: theme.brightBlack,
            fontStyle: 'italic',
            textAlign: 'center',
            fontFamily,
            fontSize,
          }}
        >
          Loading scrollback...
        </div>
      )}

      {/* xterm.js overlay a-term */}
      <div
        ref={containerRef}
        style={{
          flex: 1,
          minHeight: 0,
          overscrollBehavior: 'none',
          touchAction: 'none',
        }}
      />

      {/* Dismiss button */}
      {lines.length > 0 && (
        <div
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            display: 'flex',
            justifyContent: 'center',
            padding: '8px',
            background: `linear-gradient(transparent, ${theme.background})`,
            pointerEvents: 'none',
            zIndex: 1,
          }}
        >
          <button
            type="button"
            onClick={onDismiss}
            style={{
              pointerEvents: 'auto',
              background: 'rgba(0,255,159,0.12)',
              color: theme.green,
              border: '1px solid rgba(0,255,159,0.3)',
              borderRadius: '4px',
              padding: '6px 16px',
              cursor: 'pointer',
              fontSize: '12px',
              fontFamily,
            }}
          >
            ↓ Back to live
          </button>
        </div>
      )}
    </div>
  )
}
