import type { ATermHandle, ConnectionStatus } from '@/components/ATerm'
import type { KeyboardSizePreset } from '@/components/keyboard/types'
import type { LayoutMode } from '@/lib/constants/a-term'
import type { ATermPane } from './use-a-term-panes'
import type { ATermSession, useATermSessions } from './use-a-term-sessions'
import type { ProjectATerm, useProjectATerms } from './use-project-a-terms'

export interface UseATermHandlersProps {
  projectATerms: ProjectATerm[]
  activeSessionId: string | null
  aTermRefs: React.MutableRefObject<Map<string, ATermHandle>>
  projectTabRefs: React.MutableRefObject<Map<string, HTMLDivElement>>
  setATermStatuses: React.Dispatch<
    React.SetStateAction<Map<string, ConnectionStatus>>
  >
  setLayoutMode: (mode: LayoutMode) => void
  setKeyboardSize: (size: KeyboardSizePreset) => void
  panes: ATermPane[]
  panesAtLimit: boolean
  createProjectPane: (
    paneName: string,
    projectId: string,
    workingDir?: string,
    agentToolSlug?: string,
  ) => Promise<ATermPane>
  createAdHocPane: (paneName: string, workingDir?: string) => Promise<ATermPane>
  setActiveMode: (paneId: string, mode: string) => Promise<ATermPane>
  removePane: (paneId: string) => Promise<void>
}

export interface UseATermHandlersReturn {
  handleKeyboardSizeChange: (size: KeyboardSizePreset) => void
  handleStatusChange: (sessionId: string, status: ConnectionStatus) => void
  handleKeyboardInput: (data: string) => void
  handleReconnect: () => void
  handleLayoutModeChange: (mode: LayoutMode) => Promise<void>
  handleAddTab: () => Promise<void>
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
  ) => Promise<void>
  handleCloseAll: () => Promise<void>
  setATermRef: (sessionId: string, handle: ATermHandle | null) => void
  navigateToSession: (sessionId: string) => void
  update: ReturnType<typeof useATermSessions>['update']
  remove: ReturnType<typeof useATermSessions>['remove']
  reset: ReturnType<typeof useATermSessions>['reset']
  resetAll: ReturnType<typeof useATermSessions>['resetAll']
  resetProject: ReturnType<typeof useProjectATerms>['resetProject']
  disableProject: ReturnType<typeof useProjectATerms>['disableProject']
  sessionsLoading: boolean
  projectsLoading: boolean
}
