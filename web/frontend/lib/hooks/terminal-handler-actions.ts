import type { ProjectTerminal } from '@/lib/hooks/use-project-terminals'
import type { TerminalPane } from '@/lib/hooks/use-terminal-panes'
import {
  findSessionByMode,
  generateProjectPaneName,
  waitForTmuxInit,
} from './terminal-handler-utils'

/**
 * Add a new project terminal pane
 */
export async function addProjectPaneAction(
  targetProjectId: string,
  mode: string | null | undefined,
  rootPath: string | null | undefined,
  projectTerminals: ProjectTerminal[],
  panes: TerminalPane[],
  createProjectPane: (
    paneName: string,
    projectId: string,
    workingDir?: string,
    agentToolSlug?: string,
    options?: { host?: string },
  ) => Promise<TerminalPane>,
  navigateToSession: (sessionId: string) => void,
  startAgent: (sessionId: string) => Promise<boolean>,
  host?: string,
): Promise<void> {
  const requestedMode = mode ?? undefined

  // Resolve working directory
  let workingDir = rootPath
  if (workingDir === undefined) {
    const project = projectTerminals.find(
      (p) => p.projectId === targetProjectId,
    )
    if (!project) return
    workingDir = project.rootPath
  }

  // A refused create (a host away, a project Tether won't start) reaches the
  // caller, which says why; what follows only logs.
  const paneName = generateProjectPaneName(targetProjectId, panes)
  // `shell` asks for a shell alone; no mode, for the project's default agent too.
  const toolSlug = requestedMode
  const newPane = host
    ? await createProjectPane(
        paneName,
        targetProjectId,
        workingDir ?? undefined,
        toolSlug,
        { host },
      )
    : await createProjectPane(
        paneName,
        targetProjectId,
        workingDir ?? undefined,
        toolSlug,
      )
  try {
    const targetMode = requestedMode ?? newPane.active_mode

    const targetSession = findSessionByMode(newPane, targetMode)
    if (!targetSession) {
      // eslint-disable-next-line no-console -- action error boundary
      console.error('New pane missing session for mode:', targetMode)
      return
    }

    navigateToSession(targetSession.id)

    // A chat is running from the start: nothing to wait for or start.
    if (targetMode !== 'shell' && targetSession.backend !== 'agent-hub') {
      await waitForTmuxInit()
      await startAgent(targetSession.id)
    }
  } catch (error) {
    // eslint-disable-next-line no-console -- action error boundary
    console.error('Failed to create project pane:', error)
  }
}
