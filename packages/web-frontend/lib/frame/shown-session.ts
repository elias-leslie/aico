'use client'

// The session on screen, as the top bar says it: its name, agent, connection,
// what the agent is doing and which device holds its size. The session view
// publishes it; the top bar (outside the view) reads it.

import { useSyncExternalStore } from 'react'
import type { ConnectionStatus } from '@/components/terminal.types'
import type { Attention } from '../attention'

export interface ShownSession {
  id: string
  name: string
  /** The agent's slug for its mark (`shell` for a plain shell). */
  agent: string
  /** The agent's name ("Claude Code"), or null when unknown. */
  agentName: string | null
  /** The live connection; null for a chat (no connection to show). */
  status: ConnectionStatus | null
  attention: Attention | null
  /** Another device holding the session's size, as it names itself. */
  holder: string | null
}

let shown: ShownSession | null = null
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

/** The view's part (everything but the size holder). Null: no session open. */
export function publishShownSession(next: Omit<ShownSession, 'holder'> | null) {
  if (next === null) {
    if (shown === null) return
    shown = null
    return emit()
  }
  const holder = shown?.id === next.id ? shown.holder : null
  const same =
    shown !== null &&
    shown.id === next.id &&
    shown.name === next.name &&
    shown.agent === next.agent &&
    shown.agentName === next.agentName &&
    shown.status === next.status &&
    shown.attention?.group === next.attention?.group &&
    shown.attention?.detail === next.attention?.detail
  if (same) return
  shown = { ...next, holder }
  emit()
}

/** Home with the session on screen: leaving a page comes back to it, not to
 * whatever home would pick on its own. */
export function homeHref(): string {
  return shown ? `/?session=${encodeURIComponent(shown.id)}` : '/'
}

/** Which device holds the open session's size (null: this one, or not heard yet). */
export function publishSizeHolder(sessionId: string, holder: string | null) {
  if (!shown || shown.id !== sessionId || shown.holder === holder) return
  shown = { ...shown, holder }
  emit()
}

export function useShownSession(): ShownSession | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => shown,
    () => null,
  )
}

/** The top bar's line under the name: state first, then the agent's activity,
 * then the size. A phone leaves the size to the bar above the session, which
 * says it with Use here beside it (`withSize` false). */
export function shownSessionLine(
  session: ShownSession,
  withSize = true,
): string {
  const parts: string[] = []
  const status = session.status
  if (status === 'connected') parts.push('Live')
  else if (status === 'connecting') parts.push('Connecting')
  else if (status === 'session_dead') parts.push('Ended')
  else if (status) parts.push('Disconnected')
  const group = session.attention?.group
  if (status !== 'session_dead') {
    if (group === 'needs-you') parts.push('needs you')
    else if (group === 'working') parts.push('working')
    else if (group === 'finished') parts.push('finished')
    else if (group === 'idle')
      parts.push(
        session.attention?.age ? `idle ${session.attention.age}` : 'idle',
      )
  }
  if (withSize && session.holder && status === 'connected')
    parts.push(`sized for ${session.holder}`)
  return parts.join(' · ')
}
