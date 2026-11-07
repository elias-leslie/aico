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
    // The task (the name without its project), never the project-prefixed name.
    const running = owner
      ? sessions.find((candidate) => candidate.id === owner.session)
      : undefined
    const name = running?.task || running?.name || undefined
    return sessionLabel(session, name)
  }
}
