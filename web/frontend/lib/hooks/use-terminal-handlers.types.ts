import type { LayoutMode } from '@/lib/constants/terminal'
import type { KeyboardSizePreset } from '@/components/keyboard/types'
import type { ConnectionStatus, TerminalHandle } from '@/components/Terminal'
import type {
  ProjectTerminal,
  useProjectTerminals,
} from './use-project-terminals'
import type { TerminalPane } from './use-terminal-panes'
import type { TerminalSession, useTerminalSessions } from './use-terminal-sessions'

export interface UseTerminalHandlersProps {
  projectTerminals: ProjectTerminal[]
  activeSessionId: string | null
  terminalRefs: React.MutableRefObject<Map<string, TerminalHandle>>
  projectTabRefs: React.MutableRefObject<Map<string, HTMLDivElement>>
  setTerminalStatuses: React.Dispatch<
    React.SetStateAction<Map<string, ConnectionStatus>>
  >
  setLayoutMode: (mode: LayoutMode) => void
  setKeyboardSize: (size: KeyboardSizePreset) => void
  panes: TerminalPane[]
  panesAtLimit: boolean
  createProjectPane: (
    paneName: string,
    projectId: string,
    workingDir?: string,
    agentToolSlug?: string,
  ) => Promise<TerminalPane>
  createAdHocPane: (paneName: string, workingDir?: string) => Promise<TerminalPane>
  setActiveMode: (
    paneId: string,
    mode: string,
  ) => Promise<TerminalPane>
  removePane: (paneId: string) => Promise<void>
}

export interface UseTerminalHandlersReturn {
  handleKeyboardSizeChange: (size: KeyboardSizePreset) => void
  handleStatusChange: (sessionId: string, status: ConnectionStatus) => void
  handleKeyboardInput: (data: string) => void
  handleReconnect: () => void
  handleLayoutModeChange: (mode: LayoutMode) => Promise<void>
  handleAddTab: () => Promise<void>
  handleNewTerminalForProject: (
    projectId: string,
    mode?: string,
    rootPath?: string | null,
  ) => Promise<void>
  handleProjectModeChange: (
    projectId: string,
    newMode: string,
    projectSessions: TerminalSession[],
    paneId?: string,
  ) => Promise<void>
  handleCloseAll: () => Promise<void>
  setTerminalRef: (sessionId: string, handle: TerminalHandle | null) => void
  navigateToSession: (sessionId: string) => void
  update: ReturnType<typeof useTerminalSessions>['update']
  remove: ReturnType<typeof useTerminalSessions>['remove']
  reset: ReturnType<typeof useTerminalSessions>['reset']
  resetAll: ReturnType<typeof useTerminalSessions>['resetAll']
  resetProject: ReturnType<typeof useProjectTerminals>['resetProject']
  disableProject: ReturnType<typeof useProjectTerminals>['disableProject']
  sessionsLoading: boolean
  projectsLoading: boolean
}
