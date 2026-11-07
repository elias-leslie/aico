'use client'

import { useLiveSessions } from '@/lib/frame/live'
import { type HistorySession, sessionLabel } from '@/lib/history'
import { useTerminalSessions } from './use-terminal-sessions'

/** The label for a Recent or Today row: its running session's name, else the tool and start time. */
export function useSessionLabels(): (session: HistorySession) => string {
  const live = useLiveSessions()
  const { sessions } = useTerminalSessions({ includeDetached: true })
  return (session) => {
    const owner = [...live.bySession.values()].find(
      (item) => item.conversation === session.id,
    )
    const name = owner
      ? sessions.find((candidate) => candidate.id === owner.session)?.name
      : undefined
    return sessionLabel(session, name)
  }
}
