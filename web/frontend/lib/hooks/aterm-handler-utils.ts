import type { ATermPane, PaneSession } from '@/lib/hooks/use-aterm-panes'
import type { ATermSession } from '@/lib/hooks/use-aterm-sessions'

// Init delay for tmux session
export const TMUX_INIT_DELAY_MS = 300

/**
 * Generate a pane name with badge number if multiple panes exist
 */
export function generatePaneName(
  baseName: string,
  existingCount: number,
): string {
  return existingCount === 0 ? baseName : `${baseName} [${existingCount + 1}]`
}

/**
 * Generate an ad-hoc aterm name based on existing ad-hoc panes
 */
export function generateAdHocPaneName(panes: ATermPane[]): string {
  const adHocCount = panes.filter((p) => p.pane_type === 'adhoc').length
  return generatePaneName('Ad-Hoc A-Term', adHocCount)
}

/**
 * Generate a project pane name based on project ID and existing panes
 */
export function generateProjectPaneName(
  projectId: string,
  panes: ATermPane[],
): string {
  const existingPanesForProject = panes.filter(
    (p) => p.project_id === projectId,
  )
  const projectName = projectId.charAt(0).toUpperCase() + projectId.slice(1)
  return generatePaneName(projectName, existingPanesForProject.length)
}

/**
 * Find a session within a pane by mode
 */
export function findSessionByMode(
  pane: ATermPane,
  mode: string,
): PaneSession | undefined {
  return pane.sessions.find((s) => s.mode === mode)
}

/**
 * Check if agent should be started for a session
 */
export function shouldStartAgent(
  pane: ATermPane,
  targetSession: PaneSession,
  sessions: ATermSession[],
): boolean {
  return (
    pane.active_mode !== 'shell' &&
    targetSession.is_alive &&
    // Note: claude_state field name is intentional - it's the field returned by the backend for agent state
    !sessions.find((s) => s.id === targetSession.id && s.claude_state === 'running')
  )
}

/**
 * Delay for tmux initialization
 */
export async function waitForTmuxInit(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, TMUX_INIT_DELAY_MS))
}
