'use client'

import type { ConnectionStatus } from '@/components/terminal.types'

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
  /** Phone: Live is the dot alone, leaving the room to the session name;
   * every other state keeps its word. */
  compact?: boolean
}

/** The session's connection state in the session bar. After a dropped
 * connection the terminal area offers Reconnect. On a narrow bar the word
 * truncates down to the dot once the title and host chip are at their
 * minimum, rather than running over them. */
export function PaneStatusBadge({
  status,
  compact = false,
}: PaneStatusBadgeProps) {
  if (!status) return null
  const meta = STATUS_META[status]
  if (!meta) return null

  return (
    <span
      role="status"
      data-testid="connection-status"
      className="inline-flex min-w-1.5 items-center gap-[5px] overflow-hidden whitespace-nowrap text-xs"
      style={{ color: 'var(--mist)' }}
      title={`Connection: ${meta.label}`}
      aria-label={`Connection: ${meta.label}`}
    >
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 flex-none rounded-full"
        style={{ backgroundColor: meta.dot }}
      />
      {!(compact && status === 'connected') && (
        <span className="truncate">{meta.label}</span>
      )}
    </span>
  )
}
