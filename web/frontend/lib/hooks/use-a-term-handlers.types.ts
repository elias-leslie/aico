import type { ATermHandle, ConnectionStatus } from '@/components/ATerm'
import type { ATermPane } from './use-a-term-panes'
import type { ATermSession, useATermSessions } from './use-a-term-sessions'
import type { ProjectATerm } from './use-project-a-terms'

export interface UseATermHandlersProps {
  projectATerms: ProjectATerm[]
  activeSessionId: string | null
  aTermRefs: React.MutableRefObject<Map<string, ATermHandle>>
  projectTabRefs: React.MutableRefObject<Map<string, HTMLDivElement>>
  setATermStatuses: React.Dispatch<
    React.SetStateAction<Map<string, ConnectionStatus>>
  >
  panes: ATermPane[]
  createProjectPane: (
    paneName: string,
    projectId: string,
    workingDir?: string,
    agentToolSlug?: string,
  ) => Promise<ATermPane>
  setActiveMode: (paneId: string, mode: string) => Promise<ATermPane>
}

export interface UseATermHandlersReturn {
  handleStatusChange: (sessionId: string, status: ConnectionStatus) => void
  handleKeyboardInput: (data: string) => void
  handleComposeInput: (
    sessionId: string,
    text: string,
    action: 'insert' | 'send',
  ) => Promise<boolean>
  handleReconnect: () => void
  handleNewATermForProject: (
    projectId: string,
    mode?: string,
    rootPath?: string | null,
  ) => Promise<void>
  handleProjectModeChange: (
    projectId: string,
    newMode: string,
    projectSessions: ATermSession[],
    paneId?: string,
    pane?: ATermPane,
  ) => Promise<void>
  setATermRef: (sessionId: string, handle: ATermHandle | null) => void
  navigateToSession: (sessionId: string) => void
  update: ReturnType<typeof useATermSessions>['update']
  remove: ReturnType<typeof useATermSessions>['remove']
  reset: ReturnType<typeof useATermSessions>['reset']
  sessionsLoading: boolean
  projectsLoading: boolean
}
