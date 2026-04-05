import type { ProjectATerm } from '@/lib/hooks/use-project-aterms'
import type { ATermPane } from '@/lib/hooks/use-aterm-panes'
import {
  generateAdHocPaneName,
  generateProjectPaneName,
  findSessionByMode,
  waitForTmuxInit,
} from './aterm-handler-utils'

/**
 * Add a new ad-hoc aterm pane
 */
export async function addAdHocPaneAction(
  panes: ATermPane[],
  panesAtLimit: boolean,
  createAdHocPane: (paneName: string, workingDir?: string) => Promise<ATermPane>,
  navigateToSession: (sessionId: string) => void,
): Promise<void> {
  if (panesAtLimit) return

  try {
    const paneName = generateAdHocPaneName(panes)
    const newPane = await createAdHocPane(paneName)
    const shellSession = findSessionByMode(newPane, 'shell')
    if (shellSession) {
      navigateToSession(shellSession.id)
    }
  } catch (error) {
    // eslint-disable-next-line no-console -- action error boundary
    console.error('Failed to create ad-hoc pane:', error)
  }
}

/**
 * Add a new project aterm pane
 */
export async function addProjectPaneAction(
  targetProjectId: string,
  mode: string | null | undefined,
  rootPath: string | null | undefined,
  projectATerms: ProjectATerm[],
  panes: ATermPane[],
  panesAtLimit: boolean,
  createProjectPane: (
    paneName: string,
    projectId: string,
    workingDir?: string,
    agentToolSlug?: string,
  ) => Promise<ATermPane>,
  navigateToSession: (sessionId: string) => void,
  startAgent: (sessionId: string) => Promise<boolean>,
): Promise<void> {
  if (panesAtLimit) return
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

/**
 * Close all aterm panes and create a new ad-hoc aterm
 */
export async function closeAllPanesAction(
  panes: ATermPane[],
  removePane: (paneId: string) => Promise<void>,
  createAdHocPane: (paneName: string, workingDir?: string) => Promise<ATermPane>,
  navigateToSession: (sessionId: string) => void,
): Promise<void> {
  for (const pane of panes) {
    await removePane(pane.id)
  }

  try {
    const newPane = await createAdHocPane('Ad-Hoc A-Term')
    const shellSession = findSessionByMode(newPane, 'shell')
    if (shellSession) {
      navigateToSession(shellSession.id)
    }
  } catch (error) {
    // eslint-disable-next-line no-console -- action error boundary
    console.error('Failed to create ad-hoc pane after close all:', error)
  }
}
