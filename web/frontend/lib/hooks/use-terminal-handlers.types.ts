import type { ConnectionStatus, TerminalHandle } from '@/components/Terminal'
import type { ProjectTerminal } from './use-project-terminals'
import type { TerminalPane } from './use-terminal-panes'
import type {
  TerminalSession,
  useTerminalSessions,
} from './use-terminal-sessions'

export interface UseTerminalHandlersProps {
  projectTerminals: ProjectTerminal[]
  activeSessionId: string | null
  terminalRefs: React.MutableRefObject<Map<string, TerminalHandle>>
  projectTabRefs: React.MutableRefObject<Map<string, HTMLDivElement>>
  setTerminalStatuses: React.Dispatch<
    React.SetStateAction<Map<string, ConnectionStatus>>
  >
  panes: TerminalPane[]
  createProjectPane: (
    paneName: string,
    projectId: string,
    workingDir?: string,
    agentToolSlug?: string,
    options?: { host?: string },
  ) => Promise<TerminalPane>
  setActiveMode: (paneId: string, mode: string) => Promise<TerminalPane>
}

export interface UseTerminalHandlersReturn {
  handleStatusChange: (sessionId: string, status: ConnectionStatus) => void
  handleKeyboardInput: (data: string) => void
  handleComposeInput: (
    sessionId: string,
    text: string,
    action: 'insert' | 'send',
  ) => Promise<boolean>
  handleReconnect: () => void
  handleNewTerminalForProject: (
    projectId: string,
    mode?: string,
    rootPath?: string | null,
    host?: string,
  ) => Promise<void>
  handleProjectModeChange: (
    projectId: string,
    newMode: string,
    projectSessions: TerminalSession[],
    paneId?: string,
    pane?: TerminalPane,
  ) => Promise<void>
  setTerminalRef: (sessionId: string, handle: TerminalHandle | null) => void
  navigateToSession: (sessionId: string) => void
  update: ReturnType<typeof useTerminalSessions>['update']
  remove: ReturnType<typeof useTerminalSessions>['remove']
  reset: ReturnType<typeof useTerminalSessions>['reset']
  sessionsLoading: boolean
  projectsLoading: boolean
}
