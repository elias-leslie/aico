import { useSessionShortcuts } from './use-session-shortcuts'
import { useTerminalActionHandlers } from './use-terminal-action-handlers'
import { useTerminalModals } from './use-terminal-modals'
import { useTerminalSlotHandlers } from './use-terminal-slot-handlers'
import { useTerminalTabsState } from './use-terminal-tabs-state'

interface UseTerminalOrchestrationProps {
  projectId?: string
  projectPath?: string
}

/**
 * Orchestrates all terminal state, handlers, and modals
 * This is the central hook that coordinates everything for TerminalTabs
 */
export function useTerminalOrchestration({
  projectId,
  projectPath,
}: UseTerminalOrchestrationProps) {
  const terminalState = useTerminalTabsState({ projectId, projectPath })
  const {
    activeSessionId,
    switchToSession,
    clearActiveSession,
    sessions,
    terminalSlots,
    terminalRefs,
    reset,
    remove,
    handleProjectModeChange,
    setShowTerminalManager,
  } = terminalState

  const modalHandlers = useTerminalModals({ setShowTerminalManager })

  const slotHandlers = useTerminalSlotHandlers({
    switchToSession,
    clearActiveSession,
    activeSessionId,
    reset,
    remove,
    sessions,
    handleProjectModeChange,
  })

  useSessionShortcuts(
    terminalSlots,
    activeSessionId,
    slotHandlers.handleSlotSwitch,
  )

  // File upload
  const actionHandlers = useTerminalActionHandlers({
    terminalRefs,
    activeSessionId,
  })

  return {
    ...terminalState,
    ...modalHandlers,
    ...slotHandlers,
    ...actionHandlers,
  }
}
