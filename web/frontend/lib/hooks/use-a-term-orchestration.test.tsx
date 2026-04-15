import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { PaneSlot } from '@/lib/utils/slot'
import { useATermOrchestration } from './use-a-term-orchestration'

const mockUseDetachedPaneWindow = vi.fn()
const mockUseATermTabsState = vi.fn()

vi.mock('./use-detached-pane-window', () => ({
  useDetachedPaneWindow: (params: unknown) => mockUseDetachedPaneWindow(params),
}))

vi.mock('./use-a-term-tabs-state', () => ({
  useATermTabsState: (params: unknown) => mockUseATermTabsState(params),
}))

vi.mock('./use-a-term-modals', () => ({
  useATermModals: () => ({
    handleOpenATermManager: vi.fn(),
    handleCloseATermManager: vi.fn(),
    handleAttachExternalSession: vi.fn(),
    handleAttachDetachedPane: vi.fn(),
    handleCloseKeyboardHelp: vi.fn(),
  }),
}))

vi.mock('./use-a-term-slot-handlers', () => ({
  useATermSlotHandlers: () => ({
    handleSlotSwitch: vi.fn(),
    handleSlotReset: vi.fn(),
    handleSlotDetach: vi.fn(),
    handleSlotClose: vi.fn(),
    handleSlotCloseSession: vi.fn(),
    handleSlotClean: vi.fn(),
    handleSlotModeSwitch: vi.fn(),
    isModeSwitching: false,
  }),
}))

vi.mock('./use-layout-persistence', () => ({
  useLayoutPersistence: () => ({
    handleLayoutChange: vi.fn(),
  }),
}))

vi.mock('./use-a-term-navigation', () => ({
  useATermNavigation: () => ({
    handleCloseActive: vi.fn(),
    handleNextATerm: vi.fn(),
    handlePrevATerm: vi.fn(),
    handleJumpToATerm: vi.fn(),
  }),
}))

vi.mock('./use-prompt-cleaner', () => ({
  usePromptCleaner: () => ({
    cleanPrompt: vi.fn(),
    error: null,
    clearError: vi.fn(),
    isLoading: false,
  }),
}))

vi.mock('./use-a-term-action-handlers', () => ({
  useATermActionHandlers: () => ({
    handleVoiceSend: vi.fn(),
    handleVoiceCancel: vi.fn(),
    handleVoiceOpen: vi.fn(),
  }),
}))

vi.mock('@/components/KeyboardShortcuts', () => ({
  useATermKeyboardShortcuts: () => ({
    showHelp: false,
    setShowHelp: vi.fn(),
  }),
}))

vi.mock('@/lib/voice/use-transcription', () => ({
  useTranscription: () => ({
    startListening: vi.fn(),
    stopListening: vi.fn(),
    resetTranscript: vi.fn(),
    finalTranscript: '',
    interimTranscript: '',
    status: 'idle',
    error: null,
    isSupported: true,
  }),
}))

function makeProjectSlot(): PaneSlot {
  return {
    type: 'project',
    paneId: 'pane-a',
    projectId: 'project-a',
    projectName: 'Project A',
    rootPath: '/workspace/project-a',
    activeMode: 'codex',
    activeSessionId: 'session-a-codex',
    sessionBadge: null,
  }
}

describe('useATermOrchestration', () => {
  it('carries the current pane mode into the target project when switching projects', async () => {
    const detachPane = vi.fn().mockResolvedValue(undefined)
    const attachDetachedPane = vi.fn().mockResolvedValue({
      id: 'pane-b',
      pane_type: 'project',
      project_id: 'project-b',
      pane_order: 2,
      pane_name: 'Project B',
      active_mode: 'shell',
      is_detached: false,
      created_at: '2026-04-15T00:00:00Z',
      sessions: [
        {
          id: 'session-b-shell',
          name: 'Project B Shell',
          mode: 'shell',
          session_number: 1,
          is_alive: true,
          working_dir: '/workspace/project-b',
          claude_state: 'not_started',
          agent_state: 'not_started',
        },
        {
          id: 'session-b-claude',
          name: 'Project B Claude',
          mode: 'claude',
          session_number: 1,
          is_alive: true,
          working_dir: '/workspace/project-b',
          claude_state: 'running',
          agent_state: 'running',
        },
      ],
      width_percent: 60,
      height_percent: 40,
      grid_row: 0,
      grid_col: 1,
    })
    const handleProjectModeChange = vi.fn().mockResolvedValue(undefined)
    const switchToSession = vi.fn()

    mockUseDetachedPaneWindow.mockReturnValue({
      isDetachedPaneWindow: false,
      detachedWindowPaneIds: [],
      storageScopeId: null,
      addDetachedWindowPane: vi.fn(),
      setDetachedWindowPaneIds: vi.fn(),
      removeDetachedWindowPane: vi.fn(),
      replaceDetachedWindowPane: vi.fn(),
    })
    mockUseATermTabsState.mockReturnValue({
      activeSessionId: 'session-a-codex',
      switchToSession,
      sessions: [],
      aTermSlots: [makeProjectSlot()],
      orderedIds: ['pane-pane-a'],
      aTermRefs: { current: new Map() },
      panes: [
        {
          id: 'pane-a',
          pane_type: 'project',
          project_id: 'project-a',
          pane_order: 1,
          pane_name: 'Project A',
          active_mode: 'codex',
          is_detached: false,
          created_at: '2026-04-15T00:00:00Z',
          sessions: [],
          width_percent: 55,
          height_percent: 45,
          grid_row: 0,
          grid_col: 0,
        },
      ],
      reset: vi.fn(),
      disableProject: vi.fn(),
      remove: vi.fn(),
      removePane: vi.fn(),
      detachPane,
      handleProjectModeChange,
      attachExternalSession: vi.fn(),
      attachDetachedPane,
      detachExternalSession: vi.fn(),
      createProjectPane: vi.fn(),
      detachedPanes: [
        {
          id: 'pane-b',
          pane_type: 'project',
          project_id: 'project-b',
          pane_order: 2,
          pane_name: 'Project B',
          active_mode: 'shell',
          is_detached: true,
          created_at: '2026-04-15T00:00:00Z',
          sessions: [],
          width_percent: 60,
          height_percent: 40,
          grid_row: 0,
          grid_col: 1,
        },
      ],
      showATermManager: false,
      setShowATermManager: vi.fn(),
      saveLayouts: vi.fn(),
    })

    const { result } = renderHook(() => useATermOrchestration({}))

    await result.current.handleSlotProjectSwitch(
      makeProjectSlot(),
      'project-b',
      '/workspace/project-b',
    )

    expect(detachPane).toHaveBeenCalledWith('pane-a')
    expect(attachDetachedPane).toHaveBeenCalledWith('pane-b', {
      pane_order: 1,
      width_percent: 55,
      height_percent: 45,
      grid_row: 0,
      grid_col: 0,
    })
    expect(handleProjectModeChange).toHaveBeenCalledWith(
      'project-b',
      'codex',
      expect.any(Array),
      'pane-b',
      expect.objectContaining({
        id: 'pane-b',
        project_id: 'project-b',
        active_mode: 'shell',
      }),
    )
    expect(switchToSession).not.toHaveBeenCalled()
  })

  it('still runs project mode orchestration when a new target pane already matches the desired agent mode', async () => {
    const detachPane = vi.fn().mockResolvedValue(undefined)
    const createProjectPane = vi.fn().mockResolvedValue({
      id: 'pane-b',
      pane_type: 'project',
      project_id: 'project-b',
      pane_order: 1,
      pane_name: 'Project B',
      active_mode: 'codex',
      is_detached: false,
      created_at: '2026-04-15T00:00:00Z',
      sessions: [
        {
          id: 'session-b-shell',
          name: 'Project B Shell',
          mode: 'shell',
          session_number: 1,
          is_alive: true,
          working_dir: '/workspace/project-b',
          claude_state: 'not_started',
          agent_state: 'not_started',
        },
        {
          id: 'session-b-codex',
          name: 'Project B Codex',
          mode: 'codex',
          session_number: 1,
          is_alive: true,
          working_dir: '/workspace/project-b',
          claude_state: 'not_started',
          agent_state: 'not_started',
        },
      ],
      width_percent: 55,
      height_percent: 45,
      grid_row: 0,
      grid_col: 0,
    })
    const handleProjectModeChange = vi.fn().mockResolvedValue(undefined)
    const switchToSession = vi.fn()

    mockUseDetachedPaneWindow.mockReturnValue({
      isDetachedPaneWindow: false,
      detachedWindowPaneIds: [],
      detachedWindowScopeId: null,
      storageScopeId: null,
      addDetachedWindowPane: vi.fn(),
      setDetachedWindowPaneIds: vi.fn(),
      removeDetachedWindowPane: vi.fn(),
      replaceDetachedWindowPane: vi.fn(),
    })
    mockUseATermTabsState.mockReturnValue({
      activeSessionId: 'session-a-codex',
      switchToSession,
      sessions: [],
      aTermSlots: [makeProjectSlot()],
      orderedIds: ['pane-pane-a'],
      aTermRefs: { current: new Map() },
      panes: [
        {
          id: 'pane-a',
          pane_type: 'project',
          project_id: 'project-a',
          pane_order: 1,
          pane_name: 'Project A',
          active_mode: 'codex',
          is_detached: false,
          created_at: '2026-04-15T00:00:00Z',
          sessions: [],
          width_percent: 55,
          height_percent: 45,
          grid_row: 0,
          grid_col: 0,
        },
      ],
      reset: vi.fn(),
      disableProject: vi.fn(),
      remove: vi.fn(),
      removePane: vi.fn(),
      detachPane,
      handleProjectModeChange,
      attachExternalSession: vi.fn(),
      attachDetachedPane: vi.fn(),
      detachExternalSession: vi.fn(),
      createProjectPane,
      detachedPanes: [],
      showATermManager: false,
      setShowATermManager: vi.fn(),
      saveLayouts: vi.fn(),
    })

    const { result } = renderHook(() => useATermOrchestration({}))

    await result.current.handleSlotProjectSwitch(
      makeProjectSlot(),
      'project-b',
      '/workspace/project-b',
    )

    expect(createProjectPane).toHaveBeenCalled()
    expect(handleProjectModeChange).toHaveBeenCalledWith(
      'project-b',
      'codex',
      expect.any(Array),
      'pane-b',
      expect.objectContaining({
        id: 'pane-b',
        active_mode: 'codex',
      }),
    )
    expect(switchToSession).not.toHaveBeenCalled()
  })
})
