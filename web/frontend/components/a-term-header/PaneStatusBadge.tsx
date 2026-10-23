'use client'

import type { ConnectionStatus } from '@/components/a-term.types'

const RECONNECTABLE: Set<ConnectionStatus> = new Set([
  'disconnected',
  'error',
  'timeout',
])

/** Each state as a dot and a word; only Live is green. */
const STATUS_META: Record<ConnectionStatus, { label: string; dot: string }> = {
  connected: { label: 'Live', dot: 'var(--jade)' },
  connecting: { label: 'Connecting', dot: 'var(--mist)' },
  disconnected: { label: 'Disconnected', dot: 'var(--ember)' },
  error: { label: 'Connection error', dot: 'var(--ember)' },
  session_dead: { label: 'Ended', dot: 'var(--mist)' },
  timeout: { label: 'Timed out', dot: 'var(--ember)' },
}

interface PaneStatusBadgeProps {
  status?: ConnectionStatus
  onReconnect?: () => void
}

/** The session's connection state in the session bar; a transient failure
 * offers Reconnect. The one place the phone shows it. */
export function PaneStatusBadge({ status, onReconnect }: PaneStatusBadgeProps) {
  if (!status) return null
  const meta = STATUS_META[status]
  if (!meta) return null

  const canReconnect = RECONNECTABLE.has(status) && onReconnect !== undefined
  return (
    <span className="inline-flex flex-none items-center gap-2">
      <span
        role="status"
        data-testid="connection-status"
        className="inline-flex items-center gap-[5px] whitespace-nowrap text-xs"
        style={{ color: 'var(--mist)' }}
        title={`Connection: ${meta.label}`}
      >
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 rounded-full"
          style={{ backgroundColor: meta.dot }}
        />
        {/* Next to Reconnect a narrow bar keeps only the dot. */}
        <span className={canReconnect ? 'max-sm:sr-only' : undefined}>
          {meta.label}
        </span>
      </span>
      {canReconnect && (
        <button
          type="button"
          onClick={onReconnect}
          className="lantern-btn primary flex-none"
          style={{ height: 28, padding: '0 10px', fontSize: 12 }}
          aria-label="Reconnect session"
        >
          Reconnect
        </button>
      )}
    </span>
  )
}
