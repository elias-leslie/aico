import type { PaneSession, TerminalPane } from '@/lib/hooks/use-terminal-panes'
import type { TerminalSession } from '@/lib/hooks/use-terminal-sessions'
import { getAgentState } from '@/lib/utils/agent-state'

// Init delay for tmux session
const TMUX_INIT_DELAY_MS = 300

/**
 * Generate a pane name with badge number if multiple panes exist
 */
function generatePaneName(baseName: string, existingCount: number): string {
  return existingCount === 0 ? baseName : `${baseName} [${existingCount + 1}]`
}

/**
 * Generate a project pane name based on project ID and existing panes
 */
export function generateProjectPaneName(
  projectId: string,
  panes: TerminalPane[],
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
  pane: TerminalPane,
  mode: string,
): PaneSession | undefined {
  return pane.sessions.find((s) => s.mode === mode)
}

/**
 * Delay for tmux initialization
 */
export async function waitForTmuxInit(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, TMUX_INIT_DELAY_MS))
}
