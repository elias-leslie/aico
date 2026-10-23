import type { ATermPane } from '@/lib/hooks/a-term-panes-types'
import type { ATermSession } from '@/lib/hooks/use-a-term-sessions'
import {
  type ATermSlot,
  type PaneSlot,
  panesToSlots,
  sessionToSlot,
} from '@/lib/utils/slot'

/**
 * Get active session's project_id for per-project settings
 */
export function getActiveSessionProjectId(
  activeSessionId: string | null | undefined,
  sessions: ATermSession[],
): string | undefined {
  if (!activeSessionId) return undefined
  const activeSession = sessions.find((s) => s.id === activeSessionId)
  return activeSession?.project_id ?? undefined
}

/**
 * Every session the switcher lists: the user's own panes, then each session
 * no pane shows (another app's or agent's session, or one whose pane is gone).
 */
export function buildSessionSlots(
  panes: ATermPane[],
  sessions: ATermSession[],
  projectNames: Map<string, string>,
): Array<ATermSlot | PaneSlot> {
  const paneSlots = panesToSlots(panes)
  const paneSessionIds = new Set(
    panes.flatMap((pane) => pane.sessions.map((session) => session.id)),
  )
  const sessionSlots = sessions
    .filter((session) => !paneSessionIds.has(session.id))
    .map((session) =>
      sessionToSlot(session, {
        as: session.project_id ? 'project' : 'adhoc',
        place: session.is_external ? 'free' : 'unloaded',
        projectName: session.project_id
          ? projectNames.get(session.project_id)
          : undefined,
        slotId: `session-${session.id}`,
      }),
    )
  return [...paneSlots, ...sessionSlots]
}
