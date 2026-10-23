import type { ATermPane } from '@/lib/hooks/use-a-term-panes'
import type { ProjectATerm } from '@/lib/hooks/use-project-a-terms'
import {
  findSessionByMode,
  generateProjectPaneName,
  waitForTmuxInit,
} from './a-term-handler-utils'

/**
 * Add a new project a-term pane
 */
export async function addProjectPaneAction(
  targetProjectId: string,
  mode: string | null | undefined,
  rootPath: string | null | undefined,
  projectATerms: ProjectATerm[],
  panes: ATermPane[],
  createProjectPane: (
    paneName: string,
    projectId: string,
    workingDir?: string,
    agentToolSlug?: string,
  ) => Promise<ATermPane>,
  navigateToSession: (sessionId: string) => void,
  startAgent: (sessionId: string) => Promise<boolean>,
): Promise<void> {
  const requestedMode = mode ?? undefined

  // Resolve working directory
  let workingDir = rootPath
  if (workingDir === undefined) {
    const project = projectATerms.find((p) => p.projectId === targetProjectId)
    if (!project) return
    workingDir = project.rootPath
  }

  try {
    const paneName = generateProjectPaneName(targetProjectId, panes)
    const newPane = await createProjectPane(
      paneName,
      targetProjectId,
      workingDir ?? undefined,
      requestedMode && requestedMode !== 'shell' ? requestedMode : undefined,
    )
    const targetMode = requestedMode ?? newPane.active_mode

    const targetSession = findSessionByMode(newPane, targetMode)
    if (!targetSession) {
      // eslint-disable-next-line no-console -- action error boundary
      console.error('New pane missing session for mode:', targetMode)
      return
    }

    navigateToSession(targetSession.id)

    if (targetMode !== 'shell') {
      await waitForTmuxInit()
      await startAgent(targetSession.id)
    }
  } catch (error) {
    // eslint-disable-next-line no-console -- action error boundary
    console.error('Failed to create project pane:', error)
  }
}
