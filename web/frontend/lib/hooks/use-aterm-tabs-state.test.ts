import { act, renderHook, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useATermTabsState } from './use-aterm-tabs-state'

const mockUseActiveSession = vi.fn()
const mockUseATermPanes = vi.fn()
const mockUseATermSettings = vi.fn()
const mockUseATermHandlers = vi.fn()
const mockUseLocalStorageState = vi.fn()
const mockUseTabEditing = vi.fn()
const mockUseAvailableLayouts = vi.fn()
const mockUsePaneCapacity = vi.fn()
const mockUseMediaQuery = vi.fn()
const mockUseAutoCreatePane = vi.fn()

vi.mock('@/lib/hooks/use-active-session', () => ({
  useActiveSession: () => mockUseActiveSession(),
}))

vi.mock('@/lib/hooks/use-aterm-panes', () => ({
  useATermPanes: () => mockUseATermPanes(),
}))

vi.mock('@/lib/hooks/use-aterm-settings', () => ({
  useATermSettings: (projectId?: string) => mockUseATermSettings(projectId),
}))

vi.mock('@/lib/hooks/use-aterm-handlers', () => ({
  useATermHandlers: (params: unknown) => mockUseATermHandlers(params),
}))

vi.mock('@/lib/hooks/use-local-storage-state', () => ({
  useLocalStorageState: <T,>(key: string, defaultValue: T) =>
    mockUseLocalStorageState(key, defaultValue),
}))

vi.mock('@/lib/hooks/use-tab-editing', () => ({
  useTabEditing: (params: unknown) => mockUseTabEditing(params),
}))

vi.mock('@/lib/hooks/use-available-layouts', () => ({
  useAvailableLayouts: (paneCount: number) => mockUseAvailableLayouts(paneCount),
  usePaneCapacity: () => mockUsePaneCapacity(),
}))

vi.mock('@/lib/hooks/use-media-query', () => ({
  useMediaQuery: (query: string) => mockUseMediaQuery(query),
}))

vi.mock('@/lib/hooks/use-auto-create-pane', () => ({
  useAutoCreatePane: (params: unknown) => mockUseAutoCreatePane(params),
}))

function buildActiveSessionState(overrides: Partial<ReturnType<typeof mockUseActiveSession>> = {}) {
  const sessions = [
    {
      id: 'session-project-a',
      name: 'Project A Shell',
      user_id: null,
      project_id: 'project-a',
      working_dir: '/workspace/project-a',
      mode: 'shell',
      display_order: 0,
      is_alive: true,
      created_at: '2026-03-06T00:00:00Z',
      last_accessed_at: '2026-03-06T00:00:00Z',
    },
    {
      id: 'session-project-b',
      name: 'Project B Shell',
      user_id: null,
      project_id: 'project-b',
      working_dir: '/workspace/project-b',
      mode: 'shell',
      display_order: 1,
      is_alive: true,
      created_at: '2026-03-06T00:00:00Z',
      last_accessed_at: '2026-03-06T00:00:00Z',
    },
    {
      id: 'session-adhoc',
      name: 'Ad-Hoc A-Term',
      user_id: null,
      project_id: null,
      working_dir: '/tmp',
      mode: 'shell',
      display_order: 2,
      is_alive: true,
      created_at: '2026-03-06T00:00:00Z',
      last_accessed_at: '2026-03-06T00:00:00Z',
    },
  ]

  const activeSessionId = 'session-project-a'
  return {
    activeSessionId,
    activeSession: sessions[0],
    switchToSession: vi.fn(),
    sessions,
    projectATerms: [],
    adHocSessions: [sessions[2]],
    externalSessions: [],
    isLoading: false,
    ...overrides,
  }
}

describe('useATermTabsState', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    mockUseATermPanes.mockReturnValue({
      panes: [],
      atLimit: false,
      isLoading: false,
      hasLoadedOnce: true,
      swapPanePositions: vi.fn(),
      removePane: vi.fn(),
      setActiveMode: vi.fn(),
      createAdHocPane: vi.fn(),
      createProjectPane: vi.fn(),
      isCreating: false,
      saveLayouts: vi.fn(),
      maxPanes: 6,
    })

    mockUseATermHandlers.mockReturnValue({
      handleKeyboardSizeChange: vi.fn(),
      handleStatusChange: vi.fn(),
      handleKeyboardInput: vi.fn(),
      handleReconnect: vi.fn(),
      handleLayoutModeChange: vi.fn(),
      handleAddTab: vi.fn(),
      handleNewATermForProject: vi.fn(),
      handleProjectModeChange: vi.fn(),
      handleCloseAll: vi.fn(),
      setATermRef: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      reset: vi.fn(),
      resetAll: vi.fn(),
      resetProject: vi.fn(),
      disableProject: vi.fn(),
      sessionsLoading: false,
      projectsLoading: false,
    })

    mockUseLocalStorageState.mockImplementation((_key: string, defaultValue: unknown) =>
      useState(defaultValue),
    )
    mockUseTabEditing.mockReturnValue({
      editingSessionId: null,
      editingValue: '',
      startEditing: vi.fn(),
      cancelEditing: vi.fn(),
      saveEditing: vi.fn(),
      setEditingValue: vi.fn(),
    })
    mockUseAvailableLayouts.mockReturnValue(['split-horizontal'])
    mockUsePaneCapacity.mockReturnValue(4)
    mockUseMediaQuery.mockReturnValue(false)
    mockUseAutoCreatePane.mockReturnValue(undefined)
    mockUseATermSettings.mockImplementation((projectId?: string) => ({
      fontId: 'jetbrains-mono',
      fontSize: 14,
      fontFamily: "'JetBrains Mono', monospace",
      scrollback: 10000,
      cursorStyle: 'block',
      cursorBlink: true,
      themeId:
        projectId === 'project-a'
          ? 'dracula'
          : projectId === 'project-b'
            ? 'tokyo-night'
            : 'phosphor',
      theme: {},
      setFontId: vi.fn(),
      setFontSize: vi.fn(),
      setScrollback: vi.fn(),
      setCursorStyle: vi.fn(),
      setCursorBlink: vi.fn(),
      setThemeId: vi.fn(),
    }))
  })

  it('recomputes scoped settings when the resolved active session falls back to a different context', () => {
    let activeSessionState = buildActiveSessionState()
    mockUseActiveSession.mockImplementation(() => activeSessionState)

    const { result, rerender } = renderHook(() =>
      useATermTabsState({ projectId: undefined, projectPath: undefined }),
    )

    expect(result.current.activeSessionId).toBe('session-project-a')
    expect(result.current.themeId).toBe('dracula')
    expect(mockUseATermSettings).toHaveBeenLastCalledWith('project-a')

    activeSessionState = buildActiveSessionState({
      activeSessionId: 'session-project-b',
      activeSession: {
        id: 'session-project-b',
        name: 'Project B Shell',
        user_id: null,
        project_id: 'project-b',
        working_dir: '/workspace/project-b',
        mode: 'shell',
        display_order: 1,
        is_alive: true,
        created_at: '2026-03-06T00:00:00Z',
        last_accessed_at: '2026-03-06T00:00:00Z',
      },
    })

    rerender()

    expect(result.current.activeSessionId).toBe('session-project-b')
    expect(result.current.themeId).toBe('tokyo-night')
    expect(mockUseATermSettings).toHaveBeenLastCalledWith('project-b')

    activeSessionState = buildActiveSessionState({
      activeSessionId: 'session-adhoc',
      activeSession: {
        id: 'session-adhoc',
        name: 'Ad-Hoc A-Term',
        user_id: null,
        project_id: null,
        working_dir: '/tmp',
        mode: 'shell',
        display_order: 2,
        is_alive: true,
        created_at: '2026-03-06T00:00:00Z',
        last_accessed_at: '2026-03-06T00:00:00Z',
      },
    })

    rerender()

    expect(result.current.activeSessionId).toBe('session-adhoc')
    expect(result.current.themeId).toBe('phosphor')
    expect(mockUseATermSettings).toHaveBeenLastCalledWith(undefined)
  })

  it('creates and focuses a project pane when a project deep link is provided', async () => {
    const switchToSession = vi.fn()
    const createProjectPane = vi.fn().mockResolvedValue({
      id: 'pane-project-a',
      pane_type: 'project',
      project_id: 'project-a',
      pane_order: 0,
      pane_name: 'Project A',
      active_mode: 'shell',
      created_at: '2026-03-06T00:00:00Z',
      sessions: [
        {
          id: 'session-created-shell',
          name: 'Project A Shell',
          mode: 'shell',
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

    mockUseActiveSession.mockReturnValue(
      buildActiveSessionState({
        activeSessionId: null,
        activeSession: null,
        switchToSession,
        projectATerms: [],
        sessions: [],
        adHocSessions: [],
      }),
    )
    mockUseATermPanes.mockReturnValue({
      panes: [],
      atLimit: false,
      isLoading: false,
      hasLoadedOnce: true,
      swapPanePositions: vi.fn(),
      removePane: vi.fn(),
      setActiveMode: vi.fn(),
      createAdHocPane: vi.fn(),
      createProjectPane,
      isCreating: false,
      saveLayouts: vi.fn(),
      maxPanes: 6,
    })

    renderHook(() =>
      useATermTabsState({
        projectId: 'project-a',
        projectPath: '/workspace/project-a',
      }),
    )

    await waitFor(() => {
      expect(createProjectPane).toHaveBeenCalledWith(
        'Project-a',
        'project-a',
        '/workspace/project-a',
      )
      expect(switchToSession).toHaveBeenCalledWith('session-created-shell')
    })
  })

  it('focuses the created shell session during startup project launch', async () => {
    const switchToSession = vi.fn()
    const createProjectPane = vi.fn().mockResolvedValue({
      id: 'pane-project-c',
      pane_type: 'project',
      project_id: 'project-c',
      pane_order: 0,
      pane_name: 'Project C',
      active_mode: 'shell',
      created_at: '2026-03-06T00:00:00Z',
      sessions: [
        {
          id: 'session-created-shell',
          name: 'Project C Shell',
          mode: 'shell',
          session_number: 1,
          is_alive: true,
          working_dir: '/workspace/project-c',
          claude_state: 'not_started',
        },
        {
          id: 'session-created-claude',
          name: 'Project C Claude',
          mode: 'claude',
          session_number: 1,
          is_alive: true,
          working_dir: '/workspace/project-c',
          claude_state: 'starting',
        },
      ],
      width_percent: 100,
      height_percent: 100,
      grid_row: 0,
      grid_col: 0,
    })

    mockUseActiveSession.mockReturnValue(
      buildActiveSessionState({
        activeSessionId: null,
        activeSession: null,
        switchToSession,
        projectATerms: [],
        sessions: [],
        adHocSessions: [],
      }),
    )
    mockUseATermPanes.mockReturnValue({
      panes: [],
      atLimit: false,
      isLoading: false,
      hasLoadedOnce: true,
      swapPanePositions: vi.fn(),
      removePane: vi.fn(),
      setActiveMode: vi.fn(),
      createAdHocPane: vi.fn(),
      createProjectPane,
      isCreating: false,
      saveLayouts: vi.fn(),
      maxPanes: 6,
    })

    renderHook(() =>
      useATermTabsState({
        projectId: 'project-c',
        projectPath: '/workspace/project-c',
      }),
    )

    await waitFor(() => {
      expect(createProjectPane).toHaveBeenCalledWith(
        'Project-c',
        'project-c',
        '/workspace/project-c',
      )
      expect(switchToSession).toHaveBeenCalledWith('session-created-shell')
    })
  })

  it('focuses an existing project session instead of creating a duplicate deep-link pane', () => {
    const switchToSession = vi.fn()
    const createProjectPane = vi.fn()

    mockUseActiveSession.mockReturnValue(
      buildActiveSessionState({
        activeSessionId: null,
        activeSession: null,
        switchToSession,
        sessions: [
          {
            id: 'session-project-a',
            name: 'Project A Shell',
            user_id: null,
            project_id: 'project-a',
            working_dir: '/workspace/project-a',
            mode: 'shell',
            display_order: 0,
            is_alive: true,
            created_at: '2026-03-06T00:00:00Z',
            last_accessed_at: '2026-03-06T00:00:00Z',
          },
        ],
        projectATerms: [
          {
            projectId: 'project-a',
            projectName: 'Project A',
            rootPath: '/workspace/project-a',
            activeMode: 'shell',
            sessions: [
              {
                badge: 1,
                session: {
                  id: 'session-project-a',
                  name: 'Project A Shell',
                  user_id: null,
                  project_id: 'project-a',
                  working_dir: '/workspace/project-a',
                  mode: 'shell',
                  display_order: 0,
                  is_alive: true,
                  created_at: '2026-03-06T00:00:00Z',
                  last_accessed_at: '2026-03-06T00:00:00Z',
                },
              },
            ],
            activeSession: {
              id: 'session-project-a',
              name: 'Project A Shell',
              user_id: null,
              project_id: 'project-a',
              working_dir: '/workspace/project-a',
              mode: 'shell',
              display_order: 0,
              is_alive: true,
              created_at: '2026-03-06T00:00:00Z',
              last_accessed_at: '2026-03-06T00:00:00Z',
            },
            activeSessionId: 'session-project-a',
            sessionBadge: 1,
          },
        ],
        adHocSessions: [],
      }),
    )
    mockUseATermPanes.mockReturnValue({
      panes: [],
      atLimit: false,
      isLoading: false,
      hasLoadedOnce: true,
      swapPanePositions: vi.fn(),
      removePane: vi.fn(),
      setActiveMode: vi.fn(),
      createAdHocPane: vi.fn(),
      createProjectPane,
      isCreating: false,
      saveLayouts: vi.fn(),
      maxPanes: 6,
    })

    renderHook(() =>
      useATermTabsState({
        projectId: 'project-a',
        projectPath: '/workspace/project-a',
      }),
    )

    expect(createProjectPane).not.toHaveBeenCalled()
    expect(switchToSession).toHaveBeenCalledWith('session-project-a')
  })

  it('adds and removes attached external sessions as separate slots', () => {
    mockUseActiveSession.mockReturnValue(
      buildActiveSessionState({
        externalSessions: [
          {
            id: 'external-codex',
            name: 'codex-aterm',
            user_id: null,
            project_id: 'project-a',
            working_dir: '/workspace/project-a',
            mode: 'codex',
            display_order: 3,
            is_alive: true,
            created_at: '2026-03-06T00:00:00Z',
            last_accessed_at: '2026-03-06T00:00:00Z',
            is_external: true,
            source: 'tmux_external',
          },
        ],
      }),
    )
    mockUseATermPanes.mockReturnValue({
      panes: [
        {
          id: 'pane-project-a',
          pane_type: 'project',
          project_id: 'project-a',
          pane_order: 0,
          pane_name: 'Project A',
          active_mode: 'shell',
          created_at: '2026-03-06T00:00:00Z',
          sessions: [
            {
              id: 'session-project-a',
              name: 'Project A Shell',
              mode: 'shell',
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
        },
      ],
      atLimit: false,
      isLoading: false,
      hasLoadedOnce: true,
      swapPanePositions: vi.fn(),
      removePane: vi.fn(),
      setActiveMode: vi.fn(),
      createAdHocPane: vi.fn(),
      createProjectPane: vi.fn(),
      isCreating: false,
      saveLayouts: vi.fn(),
      maxPanes: 6,
    })

    const { result } = renderHook(() =>
      useATermTabsState({ projectId: undefined, projectPath: undefined }),
    )

    expect(result.current.atermSlots).toHaveLength(1)

    act(() => {
      result.current.attachExternalSession('external-codex')
    })
    expect(result.current.atermSlots).toHaveLength(2)
    expect(result.current.orderedIds).toEqual(['pane-pane-project-a', 'adhoc-external-codex'])

    act(() => {
      result.current.detachExternalSession('external-codex')
    })
    expect(result.current.atermSlots).toHaveLength(1)
  })

  it('swaps externally attached panes in the visible slot order', async () => {
    const swapPanePositions = vi.fn()
    mockUseLocalStorageState.mockImplementation((_key: string, defaultValue: unknown) =>
      useState(defaultValue),
    )
    mockUseActiveSession.mockReturnValue(
      buildActiveSessionState({
        externalSessions: [
          {
            id: 'external-codex',
            name: 'codex-aterm',
            user_id: null,
            project_id: 'project-a',
            working_dir: '/workspace/project-a',
            mode: 'codex',
            display_order: 3,
            is_alive: true,
            created_at: '2026-03-06T00:00:00Z',
            last_accessed_at: '2026-03-06T00:00:00Z',
            is_external: true,
            source: 'tmux_external',
          },
          {
            id: 'external-claude',
            name: 'claude-aterm',
            user_id: null,
            project_id: 'project-b',
            working_dir: '/workspace/project-b',
            mode: 'claude',
            display_order: 4,
            is_alive: true,
            created_at: '2026-03-06T00:00:00Z',
            last_accessed_at: '2026-03-06T00:00:00Z',
            is_external: true,
            source: 'tmux_external',
          },
        ],
      }),
    )
    mockUseATermPanes.mockReturnValue({
      panes: [],
      atLimit: false,
      isLoading: false,
      hasLoadedOnce: true,
      swapPanePositions,
      removePane: vi.fn(),
      setActiveMode: vi.fn(),
      createAdHocPane: vi.fn(),
      createProjectPane: vi.fn(),
      isCreating: false,
      saveLayouts: vi.fn(),
      maxPanes: 6,
    })

    const { result } = renderHook(() =>
      useATermTabsState({ projectId: undefined, projectPath: undefined }),
    )

    act(() => {
      result.current.attachExternalSession('external-codex')
      result.current.attachExternalSession('external-claude')
    })

    expect(result.current.orderedIds).toEqual([
      'adhoc-external-codex',
      'adhoc-external-claude',
    ])

    await act(async () => {
      await result.current.swapPanes('adhoc-external-codex', 'adhoc-external-claude')
    })

    expect(result.current.orderedIds).toEqual([
      'adhoc-external-claude',
      'adhoc-external-codex',
    ])
    expect(swapPanePositions).not.toHaveBeenCalled()
  })

  it('restores persisted attached external panes and keeps the persisted layout after refresh', () => {
    let activeSessionState = buildActiveSessionState({
      externalSessions: [],
      isLoading: true,
    })
    const persistedState: Record<string, unknown> = {
      'aterm-layout-mode': 'split-vertical',
      'aterm-slot-order': ['pane-pane-project-a', 'adhoc-external-codex'],
      'aterm-attached-external-session-ids': ['external-codex'],
    }

    mockUseActiveSession.mockImplementation(() => activeSessionState)
    mockUseLocalStorageState.mockImplementation((key: string, defaultValue: unknown) =>
      useState((persistedState[key] ?? defaultValue) as typeof defaultValue),
    )
    mockUseAvailableLayouts.mockImplementation((paneCount: number) =>
      paneCount > 1 ? ['split-horizontal', 'split-vertical'] : ['split-horizontal'],
    )
    mockUseATermPanes.mockReturnValue({
      panes: [
        {
          id: 'pane-project-a',
          pane_type: 'project',
          project_id: 'project-a',
          pane_order: 0,
          pane_name: 'Project A',
          active_mode: 'shell',
          created_at: '2026-03-06T00:00:00Z',
          sessions: [
            {
              id: 'session-project-a',
              name: 'Project A Shell',
              mode: 'shell',
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
        },
      ],
      atLimit: false,
      isLoading: false,
      hasLoadedOnce: true,
      swapPanePositions: vi.fn(),
      removePane: vi.fn(),
      setActiveMode: vi.fn(),
      createAdHocPane: vi.fn(),
      createProjectPane: vi.fn(),
      isCreating: false,
      saveLayouts: vi.fn(),
      maxPanes: 6,
    })

    const { result, rerender } = renderHook(() =>
      useATermTabsState({ projectId: undefined, projectPath: undefined }),
    )

    expect(result.current.layoutMode).toBe('split-vertical')
    expect(result.current.atermSlots).toHaveLength(1)

    activeSessionState = buildActiveSessionState({
      externalSessions: [
        {
          id: 'external-codex',
          name: 'codex-agent-hub',
          user_id: null,
          project_id: 'project-a',
          working_dir: '/workspace/project-a',
          mode: 'codex',
          display_order: 3,
          is_alive: true,
          created_at: '2026-03-06T00:00:00Z',
          last_accessed_at: '2026-03-06T00:00:00Z',
          is_external: true,
          source: 'tmux_external',
        },
      ],
      isLoading: false,
    })

    rerender()

    expect(result.current.layoutMode).toBe('split-vertical')
    expect(result.current.orderedIds).toEqual([
      'pane-pane-project-a',
      'adhoc-external-codex',
    ])
    expect(result.current.atermSlots).toHaveLength(2)
  })
})
