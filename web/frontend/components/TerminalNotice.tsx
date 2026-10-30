'use client'

import { useEffect, useState } from 'react'
import type { ConnectionStatus, HostAway } from '@/components/terminal.types'
import { hostNoticeCopy } from '../../../shared/host-notice'
import { SIZE_HOLDER_HINT } from '../../../shared/size-holder-copy'

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

/** Another device holds the one shared terminal size: the session shows at
 * that size, under a slim bar naming the device, with a way to take the size.
 * Looking never takes it; typing here or Use here does. On a phone the bar
 * is docked above the session so it never covers the prompt. */
export function SizeHolderNotice({
  holder,
  onUseHere,
  isMobile = false,
}: SizeHolderNoticeProps) {
  return (
    <div
      className={isMobile ? 'lantern-size-bar docked' : 'lantern-size-bar'}
      role="status"
      aria-live="polite"
      data-testid="size-holder-notice"
    >
      <p>
        Sized for {holder}
        {!isMobile && <span className="d">{SIZE_HOLDER_HINT}</span>}
      </p>
      <button
        type="button"
        className="lantern-btn small primary"
        onClick={onUseHere}
      >
        Use here
      </button>
    </div>
  )
}

interface HostNoticeProps {
  away: HostAway
  onReconnect: () => void
  /** Power the host on (it is off); rejects with the reason it didn't. */
  onPowerOn?: () => Promise<unknown>
}

/** A remote session's host can't be reached: say which host and why, keep
 * the session's last output covered, and offer Reconnect where it helps, or
 * Power on when the host is off. */
export function HostNotice({ away, onReconnect, onPowerOn }: HostNoticeProps) {
  const copy = hostNoticeCopy(away.host, away.state)
  const [powering, setPowering] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  // The host moved on (connecting, back, or off again): the button is fresh.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on a state change
  useEffect(() => {
    setPowering(false)
  }, [away.state])
  if (!copy) return null
  const powerOn = () => {
    if (!onPowerOn) return
    setPowering(true)
    setFailure(null)
    onPowerOn().catch((error: unknown) => {
      setPowering(false)
      setFailure(
        error instanceof Error && error.message
          ? error.message
          : `Couldn’t power on ${away.host}.`,
      )
    })
  }
  return (
    <div
      className="lantern-term-notice"
      role="status"
      aria-live="polite"
      data-testid="host-notice"
    >
      <p className="t">{copy.title}</p>
      <p className="d">{copy.detail}</p>
      {copy.reconnect && (
        <button
          type="button"
          className="lantern-btn primary"
          onClick={onReconnect}
        >
          Reconnect
        </button>
      )}
      {copy.powerOn && onPowerOn && (
        <button
          type="button"
          className="lantern-btn primary"
          disabled={powering}
          onClick={powerOn}
        >
          {powering ? 'Powering on…' : 'Power on'}
        </button>
      )}
      {failure && (
        <p className="d" role="alert">
          {failure}
        </p>
      )}
    </div>
  )
}
