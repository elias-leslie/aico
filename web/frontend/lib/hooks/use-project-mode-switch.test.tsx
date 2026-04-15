import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectModeSwitch } from './use-project-mode-switch'

const mockPush = vi.fn()
const mockStartAgent = vi.fn()
const mockSearchParams = new URLSearchParams()

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
  useSearchParams: () => mockSearchParams,
}))

vi.mock('./use-agent-polling', () => ({
  useAgentPolling: () => ({
    startAgent: mockStartAgent,
    isPolling: false,
  }),
}))

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
      },
    },
  })

  return function Wrapper({ children }: { children: React.ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children)
  }
}

describe('useProjectModeSwitch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mockStartAgent.mockResolvedValue(true)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts the replacement agent session after switching agent tools', async () => {
    const switchMode = vi.fn()
    const setActiveMode = vi.fn()
    const switchAgentTool = vi.fn().mockResolvedValue({
      id: 'pane-a',
      pane_type: 'project',
      project_id: 'project-a',
      pane_order: 0,
      pane_name: 'Project A',
      active_mode: 'codex',
      created_at: '2026-03-13T00:00:00Z',
      sessions: [
        {
          id: 'session-shell',
          name: 'Shell',
          mode: 'shell',
          session_number: 1,
          is_alive: true,
          working_dir: '/workspace/project-a',
          claude_state: 'not_started',
        },
        {
          id: 'session-codex',
          name: 'Codex',
          mode: 'codex',
          session_number: 1,
          is_alive: true,
          working_dir: '/workspace/project-a',
          claude_state: 'not_started',
        },
      ],
      width_percent: 100,
      height_percent: 100,
      grid_row: 0,
      grid_col: 0,
    })
    const tabElement = document.createElement('div')
    tabElement.scrollIntoView = vi.fn()
    const projectTabRefs = {
      current: new Map([['project-a', tabElement]]),
    }
    const panes = [
      {
        id: 'pane-a',
        pane_type: 'project' as const,
        project_id: 'project-a',
        pane_order: 0,
        pane_name: 'Project A',
        active_mode: 'claude',
        is_detached: false,
        created_at: '2026-03-13T00:00:00Z',
        sessions: [
          {
            id: 'session-shell',
            name: 'Shell',
            mode: 'shell',
            session_number: 1,
            is_alive: true,
            working_dir: '/workspace/project-a',
            claude_state: 'not_started' as const,
          },
          {
            id: 'session-claude',
            name: 'Claude',
            mode: 'claude',
            session_number: 1,
            is_alive: true,
            working_dir: '/workspace/project-a',
            claude_state: 'running' as const,
          },
        ],
        width_percent: 100,
        height_percent: 100,
        grid_row: 0,
        grid_col: 0,
      },
    ]

    const { result } = renderHook(
      () =>
        useProjectModeSwitch({
          switchMode,
          projectTabRefs,
          panes,
          setActiveMode,
          switchAgentTool,
        }),
      { wrapper: createWrapper() },
    )

    await act(async () => {
      await result.current.switchProjectMode({
        projectId: 'project-a',
        mode: 'codex',
        projectSessions: [
          {
            id: 'session-shell',
            name: 'Shell',
            user_id: null,
            project_id: 'project-a',
            working_dir: '/workspace/project-a',
            mode: 'shell',
            display_order: 0,
            is_alive: true,
            created_at: '2026-03-13T00:00:00Z',
            last_accessed_at: '2026-03-13T00:00:00Z',
            claude_state: 'not_started',
          },
          {
            id: 'session-claude',
            name: 'Claude',
            user_id: null,
            project_id: 'project-a',
            working_dir: '/workspace/project-a',
            mode: 'claude',
            display_order: 1,
            is_alive: true,
            created_at: '2026-03-13T00:00:00Z',
            last_accessed_at: '2026-03-13T00:00:00Z',
            claude_state: 'running',
          },
        ],
        paneId: 'pane-a',
      })
    })

    expect(switchAgentTool).toHaveBeenCalledWith('pane-a', 'codex')
    expect(setActiveMode).not.toHaveBeenCalled()
    expect(mockStartAgent).toHaveBeenCalledWith('session-codex')
    expect(mockPush).toHaveBeenCalledWith('?session=session-codex', {
      scroll: false,
    })

    act(() => {
      vi.runAllTimers()
    })

    expect(tabElement.scrollIntoView).toHaveBeenCalled()
  })

  it('uses provided pane snapshot when the pane is not yet in cache', async () => {
    const switchMode = vi.fn()
    const setActiveMode = vi.fn()
    const switchAgentTool = vi.fn().mockResolvedValue({
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
          name: 'Shell',
          mode: 'shell',
          session_number: 1,
          is_alive: true,
          working_dir: '/workspace/project-b',
          claude_state: 'not_started',
        },
        {
          id: 'session-b-codex',
          name: 'Codex',
          mode: 'codex',
          session_number: 1,
          is_alive: true,
          working_dir: '/workspace/project-b',
          claude_state: 'not_started',
        },
      ],
      width_percent: 100,
      height_percent: 100,
      grid_row: 0,
      grid_col: 0,
    })
    const paneSnapshot = {
      id: 'pane-b',
      pane_type: 'project' as const,
      project_id: 'project-b',
      pane_order: 1,
      pane_name: 'Project B',
      active_mode: 'claude',
      is_detached: false,
      created_at: '2026-04-15T00:00:00Z',
      sessions: [
        {
          id: 'session-b-shell',
          name: 'Shell',
          mode: 'shell',
          session_number: 1,
          is_alive: true,
          working_dir: '/workspace/project-b',
          claude_state: 'not_started' as const,
        },
        {
          id: 'session-b-claude',
          name: 'Claude',
          mode: 'claude',
          session_number: 1,
          is_alive: true,
          working_dir: '/workspace/project-b',
          claude_state: 'running' as const,
        },
      ],
      width_percent: 100,
      height_percent: 100,
      grid_row: 0,
      grid_col: 0,
    }
    const { result } = renderHook(
      () =>
        useProjectModeSwitch({
          switchMode,
          projectTabRefs: { current: new Map() },
          panes: [],
          setActiveMode,
          switchAgentTool,
        }),
      { wrapper: createWrapper() },
    )

    await act(async () => {
      await result.current.switchProjectMode({
        projectId: 'project-b',
        mode: 'codex',
        projectSessions: [
          {
            id: 'session-b-shell',
            name: 'Shell',
            user_id: null,
            project_id: 'project-b',
            working_dir: '/workspace/project-b',
            mode: 'shell',
            display_order: 0,
            is_alive: true,
            created_at: '2026-04-15T00:00:00Z',
            last_accessed_at: '2026-04-15T00:00:00Z',
            claude_state: 'not_started',
          },
          {
            id: 'session-b-claude',
            name: 'Claude',
            user_id: null,
            project_id: 'project-b',
            working_dir: '/workspace/project-b',
            mode: 'claude',
            display_order: 1,
            is_alive: true,
            created_at: '2026-04-15T00:00:00Z',
            last_accessed_at: '2026-04-15T00:00:00Z',
            claude_state: 'running',
          },
        ],
        paneId: 'pane-b',
        pane: paneSnapshot,
      })
    })

    expect(switchAgentTool).toHaveBeenCalledWith('pane-b', 'codex')
    expect(setActiveMode).not.toHaveBeenCalled()
    expect(switchMode).not.toHaveBeenCalled()
    expect(mockStartAgent).toHaveBeenCalledWith('session-b-codex')
    expect(mockPush).toHaveBeenCalledWith('?session=session-b-codex', {
      scroll: false,
    })
  })
})
