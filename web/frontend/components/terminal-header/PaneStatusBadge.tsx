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
}

/** The session's connection state in the session bar. After a dropped
 * connection the terminal area offers Reconnect. */
export function PaneStatusBadge({ status }: PaneStatusBadgeProps) {
  if (!status) return null
  const meta = STATUS_META[status]
  if (!meta) return null

  return (
    <span
      role="status"
      data-testid="connection-status"
      className="inline-flex flex-none items-center gap-[5px] whitespace-nowrap text-xs"
      style={{ color: 'var(--mist)' }}
      title={`Connection: ${meta.label}`}
    >
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: meta.dot }}
      />
      {meta.label}
    </span>
  )
}
