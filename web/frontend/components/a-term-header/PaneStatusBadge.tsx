'use client'

import type { ConnectionStatus } from '@/components/a-term.types'

const RECONNECTABLE: Set<ConnectionStatus> = new Set([
  'disconnected',
  'error',
  'timeout',
])

const STATUS_META: Record<
  ConnectionStatus,
  { label: string; tone: string; glow: string }
> = {
  connected: {
    label: 'Live',
    tone: 'var(--term-success)',
    glow: 'color-mix(in srgb, var(--term-success) 28%, transparent)',
  },
  connecting: {
    label: 'Connecting',
    tone: 'var(--term-warning)',
    glow: 'color-mix(in srgb, var(--term-warning) 24%, transparent)',
  },
  disconnected: {
    label: 'Disconnected',
    tone: 'var(--term-danger)',
    glow: 'color-mix(in srgb, var(--term-danger) 22%, transparent)',
  },
  error: {
    label: 'Error',
    tone: 'var(--term-danger)',
    glow: 'color-mix(in srgb, var(--term-danger) 22%, transparent)',
  },
  session_dead: {
    label: 'Ended',
    tone: 'var(--term-warning)',
    glow: 'color-mix(in srgb, var(--term-warning) 22%, transparent)',
  },
  timeout: {
    label: 'Timed out',
    tone: 'var(--term-danger)',
    glow: 'color-mix(in srgb, var(--term-danger) 22%, transparent)',
  },
}

interface PaneStatusBadgeProps {
  status?: ConnectionStatus
  onReconnect?: () => void
}

export function shouldShowPaneStatus(status?: ConnectionStatus): boolean {
  return status !== undefined && status !== 'connected'
}

export function PaneStatusBadge({ status, onReconnect }: PaneStatusBadgeProps) {
  if (!status || !shouldShowPaneStatus(status)) return null

  const meta = STATUS_META[status]
  if (!meta) return null

  const canReconnect = RECONNECTABLE.has(status) && !!onReconnect

  const sharedStyle: React.CSSProperties = {
    color: meta.tone,
    backgroundColor: meta.glow,
    border: `1px solid ${meta.glow}`,
    fontFamily: 'var(--font-ui)',
  }

  const content = (
    <>
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{
          backgroundColor: meta.tone,
          ...(canReconnect
            ? { animation: 'agent-breathe 1.5s ease-in-out infinite' }
            : {}),
        }}
      />
      <span>{canReconnect ? 'Reconnect' : meta.label}</span>
    </>
  )

  if (canReconnect) {
    return (
      <button
        type="button"
        onClick={onReconnect}
        className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.16em] transition-all duration-150 active:scale-95"
        style={{
          ...sharedStyle,
          cursor: 'pointer',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.backgroundColor = `color-mix(in srgb, var(--term-danger) 35%, transparent)`
          e.currentTarget.style.borderColor = meta.tone
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = meta.glow
          e.currentTarget.style.borderColor = meta.glow
        }}
        title="Tap to reconnect"
        aria-label="Reconnect A-Term session"
      >
        {content}
      </button>
    )
  }

  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.16em]"
      style={sharedStyle}
      title={`Pane status: ${meta.label}`}
      aria-label={`Pane status: ${meta.label}`}
    >
      {content}
    </span>
  )
}
