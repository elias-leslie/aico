// The project of the session on screen: what Notes and Capture default to when they open from a
// session. The session list is the app's own cache of /api/sessions; `watchShownProject` points
// this at the app's query client once, from Providers.

import type { QueryClient } from '@tanstack/react-query'
import type { TerminalSession } from '../hooks/use-terminal-sessions'
import { shownSession } from './shown-session'

let client: QueryClient | null = null

/** Reads the session list from `queryClient`; returns how to stop. */
export function watchShownProject(queryClient: QueryClient): () => void {
  client = queryClient
  return () => {
    if (client === queryClient) client = null
  }
}

/** The project a session belongs to, from the cached session list; null: none, or not known. */
function projectOfSession(id: string): string | null {
  if (!client) return null
  for (const [, sessions] of client.getQueriesData<TerminalSession[]>({
    queryKey: ['terminal-sessions'],
  })) {
    const found = sessions?.find((session) => session.id === id)
    if (found) return found.project_id
  }
  return null
}

/** The open session's project; null when no session is open or it has no project. */
export function shownProject(): string | null {
  const id = shownSession()
  return id ? projectOfSession(id) : null
}
