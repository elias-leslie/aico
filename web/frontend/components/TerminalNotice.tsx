'use client'

import type { ConnectionStatus } from '@/components/a-term.types'

const LOST: Partial<Record<ConnectionStatus, string>> = {
  disconnected: 'Disconnected',
  error: 'Connection error',
  timeout: 'Timed out',
}

interface ConnectionNoticeProps {
  status?: ConnectionStatus
  /** The view has shown this session's output before. A first connect gets
   * a word on the empty terminal; a reconnect keeps the output in view and
   * leaves the state to the session bar. */
  hasConnected: boolean
  onReconnect?: () => void
  onNewSession?: () => void
}

/** What the terminal area says when it is not live: connecting, lost with
 * Reconnect, or ended. */
export function ConnectionNotice({
  status,
  hasConnected,
  onReconnect,
  onNewSession,
}: ConnectionNoticeProps) {
  if (status === 'connecting') {
    if (hasConnected) return null
    return (
      <div className="lantern-term-notice quiet" data-testid="terminal-notice">
        <p className="d">Connecting to the session</p>
      </div>
    )
  }

  const lost = status ? LOST[status] : undefined
  if (lost) {
    return (
      <div
        className="lantern-term-notice"
        role="status"
        aria-live="polite"
        data-testid="terminal-notice"
      >
        <p className="t">{lost}</p>
        <p className="d">
          {hasConnected
            ? 'This view stopped updating. The session keeps running.'
            : 'Couldn’t reach the session.'}
        </p>
        {onReconnect && (
          <button
            type="button"
            className="lantern-btn primary"
            onClick={onReconnect}
          >
            Reconnect
          </button>
        )}
      </div>
    )
  }

  if (status === 'session_dead') {
    return (
      <div
        className="lantern-term-notice"
        role="status"
        aria-live="polite"
        data-testid="terminal-notice"
      >
        <p className="t">Session ended</p>
        <p className="d">Its process has stopped.</p>
        {onNewSession && (
          <button
            type="button"
            className="lantern-btn primary"
            onClick={onNewSession}
          >
            New session
          </button>
        )}
      </div>
    )
  }

  return null
}

interface SizeHolderNoticeProps {
  /** The device holding the shared terminal size, as it names itself. */
  holder: string
  onUseHere: () => void
  isMobile?: boolean
}

/** Another device holds the one shared terminal size: name it and offer to
 * take it back, as the desktop's notice. */
export function SizeHolderNotice({
  holder,
  onUseHere,
  isMobile = false,
}: SizeHolderNoticeProps) {
  return (
    <div
      className="lantern-term-notice"
      role="status"
      aria-live="polite"
      data-testid="size-holder-notice"
    >
      <p className="t">Viewing on {holder}</p>
      <p className="d">
        {isMobile
          ? 'Sized for that screen. Tap Use here or start typing to size it for this phone.'
          : 'Sized for that screen. Click Use here or start typing to size it for this window.'}
      </p>
      <button type="button" className="lantern-btn primary" onClick={onUseHere}>
        Use here
      </button>
    </div>
  )
}
