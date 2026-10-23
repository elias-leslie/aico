import { act, renderHook, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OWN_TMUX_CAN,
  ROOT_CAN,
  TETHER_CAN,
  TETHER_LEGACY_CAN,
} from '@/test-stubs/session-fixtures'
import { useATermTabsState } from './use-a-term-tabs-state'

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
const mockUseProjectSettings = vi.fn()
const TEST_WINDOW_SCOPE = 'test-window'

vi.mock('@/lib/hooks/use-active-session', () => ({
  useActiveSession: (params: unknown) => mockUseActiveSession(params),
}))

vi.mock('@/lib/hooks/use-a-term-panes', () => ({
  useATermPanes: () => mockUseATermPanes(),
}))

vi.mock('@/lib/hooks/use-a-term-settings', () => ({
  useATermSettings: (projectId?: string) => mockUseATermSettings(projectId),
}))

vi.mock('@/lib/hooks/use-a-term-handlers', () => ({
  useATermHandlers: (params: unknown) => mockUseATermHandlers(params),
}))

vi.mock('@/lib/hooks/use-local-storage-state', () => ({
  useLocalStorageState: <T>(key: string, defaultValue: T) =>
    mockUseLocalStorageState(key, defaultValue),
}))

vi.mock('@/lib/hooks/use-tab-editing', () => ({
  useTabEditing: (params: unknown) => mockUseTabEditing(params),
}))

vi.mock('@/lib/hooks/use-available-layouts', () => ({
  useAvailableLayouts: (paneCount: number) =>
    mockUseAvailableLayouts(paneCount),
  usePaneCapacity: () => mockUsePaneCapacity(),
}))

vi.mock('@/lib/hooks/use-media-query', () => ({
  useMediaQuery: (query: string) => mockUseMediaQuery(query),
}))

vi.mock('@/lib/hooks/use-auto-create-pane', () => ({
  useAutoCreatePane: (params: unknown) => mockUseAutoCreatePane(params),
}))

vi.mock('@/lib/hooks/use-project-settings', () => ({
  useProjectSettings: () => mockUseProjectSettings(),
}))

function buildActiveSessionState(
  overrides: Partial<ReturnType<typeof mockUseActiveSession>> = {},
) {
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
      ...TETHER_CAN,
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
      ...TETHER_CAN,
    },
    {
      id: 'session-adhoc',
      name: 'Ad-Hoc Session',
      user_id: null,
      project_id: null,
      working_dir: '/tmp',
      mode: 'shell',
      display_order: 2,
      is_alive: true,
      created_at: '2026-03-06T00:00:00Z',
      last_accessed_at: '2026-03-06T00:00:00Z',
      ...TETHER_CAN,
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
    mockUseProjectSettings.mockReturnValue({
      projects: [
        { id: 'project-a', name: 'Project A' },
        { id: 'project-b', name: 'Project B' },
      ],
    })
    window.localStorage.clear()
    window.sessionStorage.clear()
    window.sessionStorage.setItem('a-term-window-id', TEST_WINDOW_SCOPE)

    mockUseATermPanes.mockReturnValue({
      panes: [],
      detachedPanes: [],
      atLimit: false,
      isLoading: false,
      detachedLoadedOnce: true,
      hasLoadedOnce: true,
      swapPanePositions: vi.fn(),
      removePane: vi.fn(),
      detachPane: vi.fn(),
      attachPane: vi.fn(),
      setActiveMode: vi.fn(),
      createAdHocPane: vi.fn(),
      createProjectPane: vi.fn(),
      isCreating: false,
      saveLayouts: vi.fn(),
      maxPanes: 6,
    })

    mockUseATermHandlers.mockReturnValue({
      handleKeyboardModeChange: vi.fn(),
      handleKeyboardSizeChange: vi.fn(),
      handleKeyboardSpacingChange: vi.fn(),
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

    mockUseLocalStorageState.mockImplementation(
      (_key: string, defaultValue: unknown) => useState(defaultValue),
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
      setCursorStyle: vi.fn(),
      setCursorBlink: vi.fn(),
      setThemeId: vi.fn(),
    }))
  })

  it('scopes a detached-pane window to the requested pane and includes detached sessions', () => {
    mockUseActiveSession.mockReturnValue(buildActiveSessionState())
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
              ...TETHER_CAN,
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
      detachedPanes: [
        {
          id: 'pane-detached',
          pane_type: 'project',
          project_id: 'project-b',
          pane_order: 1,
          pane_name: 'Project B Detached',
          active_mode: 'shell',
          is_detached: true,
          created_at: '2026-03-06T00:00:00Z',
          sessions: [
            {
              id: 'session-project-b',
              name: 'Project B Shell',
              mode: 'shell',
              ...TETHER_CAN,
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
        },
      ],
      atLimit: false,
      isLoading: false,
      detachedLoadedOnce: true,
      hasLoadedOnce: true,
      swapPanePositions: vi.fn(),
      removePane: vi.fn(),
      detachPane: vi.fn(),
      attachPane: vi.fn(),
      setActiveMode: vi.fn(),
      createAdHocPane: vi.fn(),
      createProjectPane: vi.fn(),
      isCreating: false,
      saveLayouts: vi.fn(),
      maxPanes: 6,
    })

    const { result } = renderHook(() =>
      useATermTabsState({
        projectId: undefined,
        projectPath: undefined,
        detachedPaneId: 'pane-detached',
        isDetachedPaneWindow: true,
        detachedWindowPaneIds: ['pane-detached'],
      }),
    )

    expect(mockUseActiveSession).toHaveBeenCalledWith({
      includeDetached: true,
      persistKey: 'aTerm:last-active-session-id',
    })
    expect(result.current.themeId).toBe('tokyo-night')
    expect(result.current.aTermSlots).toHaveLength(1)
    expect(result.current.aTermSlots[0]).toMatchObject({
      paneId: 'pane-detached',
      projectId: 'project-b',
    })
    expect(result.current.canAddPane()).toBe(true)
    expect(mockUseAutoCreatePane).toHaveBeenLastCalledWith(
      expect.objectContaining({
        enabled: false,
      }),
    )
  })

  it('starts a new browser window empty when another live window owns the existing panes', () => {
    const now = Date.now()
    window.localStorage.setItem(
      'a-term-window-pane-owners',
      JSON.stringify({
        'other-window': {
          paneIds: ['pane-project-a'],
          updatedAt: now,
        },
      }),
    )
    mockUseActiveSession.mockReturnValue(buildActiveSessionState())
    mockUseATermPanes.mockReturnValue({
      panes: [
        {
          id: 'pane-project-a',
          pane_type: 'project',
          project_id: 'project-a',
          pane_order: 0,
          pane_name: 'Project A',
          active_mode: 'shell',
          is_detached: false,
          created_at: '2026-03-06T00:00:00Z',
          sessions: [
            {
              id: 'session-project-a',
              name: 'Project A Shell',
              mode: 'shell',
              ...TETHER_CAN,
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
      detachedPanes: [],
      atLimit: false,
      isLoading: false,
      detachedLoadedOnce: true,
      hasLoadedOnce: true,
      swapPanePositions: vi.fn(),
      removePane: vi.fn(),
      detachPane: vi.fn(),
      attachPane: vi.fn(),
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

    expect(result.current.aTermSlots).toEqual([])
    expect(result.current.activeSessionId).toBeNull()
    expect(mockUseAutoCreatePane).toHaveBeenLastCalledWith(
      expect.objectContaining({
        panes: [],
      }),
    )
  })

  it('claims a reattached pane for the current browser window', async () => {
    const attachedPane = {
      id: 'pane-detached',
      pane_type: 'project' as const,
      project_id: 'project-b',
      pane_order: 1,
      pane_name: 'Project B',
      active_mode: 'shell',
      is_detached: false,
      created_at: '2026-03-06T00:00:00Z',
      sessions: [
        {
          id: 'session-project-b',
          name: 'Project B Shell',
          mode: 'shell',
          ...TETHER_CAN,
          session_number: 1,
          is_alive: true,
          working_dir: '/workspace/project-b',
          claude_state: 'not_started' as const,
        },
      ],
      width_percent: 100,
      height_percent: 100,
      grid_row: 0,
      grid_col: 0,
    }
    const attachPane = vi.fn().mockResolvedValue(attachedPane)
    mockUseActiveSession.mockReturnValue(buildActiveSessionState())
    mockUseATermPanes.mockReturnValue({
      panes: [
        {
          id: 'pane-project-a',
          pane_type: 'project',
          project_id: 'project-a',
          pane_order: 0,
          pane_name: 'Project A',
          active_mode: 'shell',
          is_detached: false,
          created_at: '2026-03-06T00:00:00Z',
          sessions: [
            {
              id: 'session-project-a',
              name: 'Project A Shell',
              mode: 'shell',
              ...TETHER_CAN,
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
      detachedPanes: [{ ...attachedPane, is_detached: true }],
      atLimit: false,
      isLoading: false,
      detachedLoadedOnce: true,
      hasLoadedOnce: true,
      swapPanePositions: vi.fn(),
      removePane: vi.fn(),
      detachPane: vi.fn(),
      attachPane,
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

    await act(async () => {
      await result.current.attachDetachedPane('pane-detached')
    })

    const registry = JSON.parse(
      window.localStorage.getItem('a-term-window-pane-owners') ?? '{}',
    )
    expect(attachPane).toHaveBeenCalledWith('pane-detached', undefined)
    expect(registry[TEST_WINDOW_SCOPE].paneIds).toContain('pane-detached')
  })

  it('does not auto-create an ad-hoc pane while launching a requested project pane', async () => {
    const switchToSession = vi.fn()
    const createProjectPane = vi.fn().mockResolvedValue({
      id: 'pane-project-a-new',
      pane_type: 'project',
      project_id: 'project-a',
      pane_order: 0,
      pane_name: 'Project A',
      active_mode: 'shell',
      is_detached: false,
      created_at: '2026-03-06T00:00:00Z',
      sessions: [
        {
          id: 'session-project-a-new',
          name: 'Project A Shell',
          mode: 'shell',
          ...TETHER_CAN,
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
        sessions: [],
        projectATerms: [],
        adHocSessions: [],
      }),
    )
    mockUseATermPanes.mockReturnValue({
      panes: [],
      detachedPanes: [],
      atLimit: false,
      isLoading: false,
      detachedLoadedOnce: true,
      hasLoadedOnce: true,
      swapPanePositions: vi.fn(),
      removePane: vi.fn(),
      detachPane: vi.fn(),
      attachPane: vi.fn(),
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

    expect(mockUseAutoCreatePane).toHaveBeenLastCalledWith(
      expect.objectContaining({
        enabled: false,
        panes: [],
      }),
    )
    await waitFor(() => {
      expect(createProjectPane).toHaveBeenCalledTimes(1)
    })
    expect(switchToSession).toHaveBeenCalledWith('session-project-a-new')
  })

  it('uses pane-based mobile slots so one project pane appears once even when it has shell and agent sessions', () => {
    mockUseMediaQuery.mockReturnValue(true)
    mockUseActiveSession.mockReturnValue({
      activeSessionId: 'project-a-codex',
      activeSession: {
        id: 'project-a-codex',
        name: 'Project A Codex',
        user_id: null,
        project_id: 'project-a',
        working_dir: '/workspace/project-a',
        mode: 'codex',
        display_order: 1,
        is_alive: true,
        created_at: '2026-03-06T00:00:00Z',
        last_accessed_at: '2026-03-06T00:00:00Z',
        ...TETHER_CAN,
      },
      switchToSession: vi.fn(),
      sessions: [
        {
          id: 'project-a-shell',
          name: 'Project A Shell',
          user_id: null,
          project_id: 'project-a',
          working_dir: '/workspace/project-a',
          mode: 'shell',
          display_order: 0,
          is_alive: true,
          created_at: '2026-03-06T00:00:00Z',
          last_accessed_at: '2026-03-06T00:00:00Z',
          ...TETHER_CAN,
        },
        {
          id: 'project-a-codex',
          name: 'Project A Codex',
          user_id: null,
          project_id: 'project-a',
          working_dir: '/workspace/project-a',
          mode: 'codex',
          display_order: 1,
          is_alive: true,
          created_at: '2026-03-06T00:00:00Z',
          last_accessed_at: '2026-03-06T00:00:00Z',
          ...TETHER_CAN,
        },
        {
          id: 'project-b-shell',
          name: 'Project B Shell',
          user_id: null,
          project_id: 'project-b',
          working_dir: '/workspace/project-b',
          mode: 'shell',
          display_order: 2,
          is_alive: true,
          created_at: '2026-03-06T00:00:00Z',
          last_accessed_at: '2026-03-06T00:00:00Z',
          ...TETHER_CAN,
        },
      ],
      projectATerms: [
        {
          projectId: 'project-a',
          projectName: 'Project A',
          rootPath: '/workspace/project-a',
          activeMode: 'codex',
          sessions: [],
          activeSession: null,
          activeSessionId: 'project-a-codex',
          sessionBadge: null,
        },
        {
          projectId: 'project-b',
          projectName: 'Project B',
          rootPath: '/workspace/project-b',
          activeMode: 'shell',
          sessions: [],
          activeSession: null,
          activeSessionId: 'project-b-shell',
          sessionBadge: null,
        },
      ],
      adHocSessions: [],
      externalSessions: [],
      isLoading: false,
    })
    mockUseATermPanes.mockReturnValue({
      panes: [
        {
          id: 'pane-project-a',
          pane_type: 'project',
          project_id: 'project-a',
          pane_order: 0,
          pane_name: 'Project A',
          active_mode: 'codex',
          created_at: '2026-03-06T00:00:00Z',
          sessions: [
            {
              id: 'project-a-shell',
              name: 'Project A Shell',
              mode: 'shell',
              ...TETHER_CAN,
              session_number: 1,
              is_alive: true,
              working_dir: '/workspace/project-a',
              claude_state: 'not_started',
            },
            {
              id: 'project-a-codex',
              name: 'Project A Codex',
              mode: 'codex',
              ...TETHER_CAN,
              session_number: 2,
              is_alive: true,
              working_dir: '/workspace/project-a',
              claude_state: 'running',
            },
          ],
          width_percent: 100,
          height_percent: 100,
          grid_row: 0,
          grid_col: 0,
        },
      ],
      detachedPanes: [
        {
          id: 'pane-detached',
          pane_type: 'project',
          project_id: 'project-b',
          pane_order: 1,
          pane_name: 'Project B Detached',
          active_mode: 'shell',
          is_detached: true,
          created_at: '2026-03-06T00:00:00Z',
          sessions: [
            {
              id: 'project-b-shell',
              name: 'Project B Shell',
              mode: 'shell',
              ...TETHER_CAN,
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
        },
      ],
      atLimit: false,
      isLoading: false,
      detachedLoadedOnce: true,
      hasLoadedOnce: true,
      swapPanePositions: vi.fn(),
      removePane: vi.fn(),
      detachPane: vi.fn(),
      attachPane: vi.fn(),
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

    expect(mockUseActiveSession).toHaveBeenCalledWith({
      includeDetached: true,
      persistKey: 'aTerm:last-active-session-id',
    })
    expect(result.current.aTermSlots).toHaveLength(2)
    expect(
      result.current.aTermSlots.filter(
        (
          slot,
        ): slot is Extract<
          (typeof result.current.aTermSlots)[number],
          { type: 'project' }
        > => slot.type === 'project' && slot.projectId === 'project-a',
      ),
    ).toHaveLength(1)
    expect(
      result.current.aTermSlots.find(
        (
          slot,
        ): slot is Extract<
          (typeof result.current.aTermSlots)[number],
          { type: 'project' }
        > => slot.type === 'project' && slot.projectId === 'project-a',
      ),
    ).toMatchObject({
      paneId: 'pane-project-a',
      activeMode: 'codex',
      activeSessionId: 'project-a-codex',
    })
    expect(new Set(result.current.orderedIds).size).toBe(2)
    expect(mockUseAutoCreatePane).toHaveBeenLastCalledWith(
      expect.objectContaining({
        enabled: true,
        hasVisibleExternalSlot: true,
      }),
    )
  })

  it('shows the project and custom session name together in the mobile switcher', () => {
    mockUseMediaQuery.mockReturnValue(true)
    const externalSession = {
      id: 'external-codex',
      name: 'Incident review',
      user_id: null,
      project_id: 'project-a',
      working_dir: '/workspace/project-a',
      mode: 'codex',
      display_order: 0,
      is_alive: true,
      created_at: null,
      last_accessed_at: null,
      is_external: true,
      source: 'tmux_external',
      ...OWN_TMUX_CAN,
    }
    mockUseActiveSession.mockReturnValue(
      buildActiveSessionState({
        activeSessionId: externalSession.id,
        activeSession: externalSession,
        sessions: [externalSession],
        externalSessions: [externalSession],
      }),
    )

    const { result } = renderHook(() =>
      useATermTabsState({ projectId: undefined, projectPath: undefined }),
    )

    expect(result.current.aTermSlots).toHaveLength(1)
    expect(result.current.aTermSlots[0]).toMatchObject({
      type: 'project',
      projectName: 'Project A · Incident review',
    })
  })

  it('maps mobile fallback sessions through the backend flags: no Reset on a free-standing View', () => {
    mockUseMediaQuery.mockReturnValue(true)
    const base = buildActiveSessionState().sessions[0]
    const freeTether = {
      ...base,
      id: 'free-tether',
      name: 'Project A — Incident review',
      mode: 'codex',
      source: 'tether',
      task: 'Incident review',
      is_external: true,
      ...TETHER_CAN,
    }
    const unloadedLegacy = {
      ...base,
      id: 'unloaded-legacy',
      name: 'Project A — Old review',
      mode: 'codex',
      source: 'tether',
      status: 'legacy',
      is_legacy: true,
      is_external: false,
      ...TETHER_LEGACY_CAN,
    }
    const unloadedTether = {
      ...base,
      id: 'unloaded-tether',
      name: 'Plain agent',
      project_id: null,
      mode: 'codex',
      source: 'tether',
      is_external: false,
      ...TETHER_CAN,
    }
    mockUseActiveSession.mockReturnValue(
      buildActiveSessionState({
        activeSessionId: freeTether.id,
        activeSession: freeTether,
        sessions: [freeTether, unloadedLegacy, unloadedTether],
        externalSessions: [freeTether],
      }),
    )

    const { result } = renderHook(() =>
      useATermTabsState({ projectId: undefined, projectPath: undefined }),
    )

    expect(result.current.aTermSlots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          slotId: 'session-free-tether',
          type: 'project',
          projectName: 'Project A — Incident review',
          can: { rename: true, reset: false, end: true },
          showsSessionTitle: true,
        }),
        expect.objectContaining({
          slotId: 'session-unloaded-legacy',
          type: 'project',
          projectName: 'Project A — Old review',
          can: { rename: true, reset: false, end: true },
          showsSessionTitle: false,
        }),
        expect.objectContaining({
          slotId: 'session-unloaded-tether',
          type: 'adhoc',
          name: 'Plain agent',
          isExternal: false,
          can: { rename: true, reset: true, end: true },
        }),
      ]),
    )
  })

  it("on mobile, lists another agent's session in the switcher but never opens it unasked", () => {
    mockUseMediaQuery.mockReturnValue(true)
    const otherAgent = {
      ...buildActiveSessionState().sessions[0],
      id: 'other-agent',
      name: 'Project A — Hunt',
      mode: 'codex',
      source: 'tether',
      is_external: true,
      ...TETHER_CAN,
    }
    let state = buildActiveSessionState({
      activeSessionId: null,
      activeSession: null,
      sessions: [otherAgent],
      externalSessions: [otherAgent],
    })
    mockUseActiveSession.mockImplementation(() => state)

    const { result, rerender } = renderHook(() =>
      useATermTabsState({ projectId: undefined, projectPath: undefined }),
    )

    expect(result.current.aTermSlots).toEqual([
      expect.objectContaining({ slotId: 'session-other-agent' }),
    ])
    expect(result.current.activeSessionId).toBe(null)
    // Nothing of the user's is open, so A-Term may open its own ad hoc shell.
    expect(mockUseAutoCreatePane).toHaveBeenLastCalledWith(
      expect.objectContaining({ hasVisibleExternalSlot: false }),
    )

    // Chosen from the switcher or the manager: kept.
    state = {
      ...state,
      activeSessionId: 'other-agent',
      activeSession: otherAgent,
    }
    rerender()
    expect(result.current.activeSessionId).toBe('other-agent')
    expect(mockUseAutoCreatePane).toHaveBeenLastCalledWith(
      expect.objectContaining({ hasVisibleExternalSlot: true }),
    )
  })

  it.each([false, true])(
    'refreshes root titles from Tether and offers no Reset on desktop/mobile=%s',
    (isMobile) => {
      mockUseMediaQuery.mockReturnValue(isMobile)
      const rootSession = {
        ...buildActiveSessionState().sessions[0],
        id: 'root-session',
        name: 'Project A — Focus',
        mode: 'codex',
        source: 'tether',
        is_root: true,
        session_number: 1,
        claude_state: 'running',
        ...ROOT_CAN,
      }
      const pane = {
        id: 'root-pane',
        pane_type: 'project',
        project_id: 'project-a',
        pane_order: 0,
        pane_name: 'Root: exact-request',
        active_mode: 'codex',
        is_detached: false,
        created_at: null,
        sessions: [rootSession],
        width_percent: 100,
        height_percent: 100,
        grid_row: 0,
        grid_col: 0,
      }
      const paneState = { ...mockUseATermPanes(), panes: [pane] }
      mockUseATermPanes.mockReturnValue(paneState)
      mockUseActiveSession.mockReturnValue(
        buildActiveSessionState({
          activeSessionId: rootSession.id,
          activeSession: rootSession,
          sessions: [rootSession],
        }),
      )
      const { result, rerender } = renderHook(() => useATermTabsState({}))
      expect(result.current.aTermSlots[0]).toMatchObject({
        projectName: 'Project A — Focus',
        can: { rename: true, reset: false, end: true },
        showsSessionTitle: true,
      })
      mockUseATermPanes.mockReturnValue({
        ...paneState,
        panes: [
          {
            ...pane,
            sessions: [{ ...rootSession, name: 'Project A — Next focus' }],
          },
        ],
      })
      rerender()
      expect(result.current.aTermSlots[0]).toMatchObject({
        projectName: 'Project A — Next focus',
        can: { rename: true, reset: false, end: true },
      })
    },
  )

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
        ...TETHER_CAN,
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
        name: 'Ad-Hoc Session',
        user_id: null,
        project_id: null,
        working_dir: '/tmp',
        mode: 'shell',
        display_order: 2,
        is_alive: true,
        created_at: '2026-03-06T00:00:00Z',
        last_accessed_at: '2026-03-06T00:00:00Z',
        ...TETHER_CAN,
      },
    })

    rerender()

    expect(result.current.activeSessionId).toBe('session-adhoc')
    expect(result.current.themeId).toBe('phosphor')
    expect(mockUseATermSettings).toHaveBeenLastCalledWith(undefined)
  })

  it('creates detached panes inside a detached window when adding a new a-term', async () => {
    const switchToSession = vi.fn()
    const addDetachedWindowPane = vi.fn()
    const createAdHocPane = vi.fn().mockResolvedValue({
      id: 'pane-detached-new',
      pane_type: 'adhoc',
      project_id: null,
      pane_order: 1,
      pane_name: 'Ad-Hoc Session 2',
      active_mode: 'shell',
      created_at: '2026-03-06T00:00:00Z',
      sessions: [
        {
          id: 'session-detached-new',
          name: 'Detached Shell',
          mode: 'shell',
          ...TETHER_CAN,
          session_number: 1,
          is_alive: true,
          working_dir: '/tmp',
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
          ...TETHER_CAN,
        },
        switchToSession,
      }),
    )
    mockUseATermPanes.mockReturnValue({
      panes: [],
      detachedPanes: [
        {
          id: 'pane-detached',
          pane_type: 'project',
          project_id: 'project-b',
          pane_order: 0,
          pane_name: 'Project B Detached',
          active_mode: 'shell',
          is_detached: true,
          created_at: '2026-03-06T00:00:00Z',
          sessions: [
            {
              id: 'session-project-b',
              name: 'Project B Shell',
              mode: 'shell',
              ...TETHER_CAN,
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
        },
      ],
      atLimit: false,
      isLoading: false,
      detachedLoadedOnce: true,
      hasLoadedOnce: true,
      swapPanePositions: vi.fn(),
      removePane: vi.fn(),
      detachPane: vi.fn(),
      attachPane: vi.fn(),
      setActiveMode: vi.fn(),
      createAdHocPane,
      createProjectPane: vi.fn(),
      isCreating: false,
      saveLayouts: vi.fn(),
      maxPanes: 6,
    })

    const { result } = renderHook(() =>
      useATermTabsState({
        projectId: undefined,
        projectPath: undefined,
        detachedPaneId: 'pane-detached',
        isDetachedPaneWindow: true,
        detachedWindowPaneIds: ['pane-detached'],
        addDetachedWindowPane,
      }),
    )

    await act(async () => {
      await result.current.handleAddTab()
    })

    expect(createAdHocPane).toHaveBeenCalledWith('Ad-Hoc Session', undefined, {
      detached: true,
    })
    expect(addDetachedWindowPane).toHaveBeenCalledWith(
      'pane-detached-new',
      'session-detached-new',
    )
    expect(switchToSession).not.toHaveBeenCalled()
  })

  it('starts the default agent when creating project panes inside detached windows', async () => {
    const switchToSession = vi.fn()
    const addDetachedWindowPane = vi.fn()
    const handleProjectModeChange = vi.fn().mockResolvedValue(undefined)
    const createProjectPane = vi.fn().mockResolvedValue({
      id: 'pane-project-a',
      pane_type: 'project',
      project_id: 'project-a',
      pane_order: 0,
      pane_name: 'Project A',
      active_mode: 'codex',
      created_at: '2026-03-06T00:00:00Z',
      sessions: [
        {
          id: 'session-shell',
          name: 'Project A Shell',
          mode: 'shell',
          ...TETHER_CAN,
          session_number: 1,
          is_alive: true,
          working_dir: '/workspace/project-a',
          claude_state: 'not_started',
        },
        {
          id: 'session-codex',
          name: 'Project A Codex',
          mode: 'codex',
          ...TETHER_CAN,
          session_number: 1,
          is_alive: true,
          working_dir: '/workspace/project-a',
          agent_state: 'not_started',
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
    mockUseATermHandlers.mockReturnValue({
      handleKeyboardModeChange: vi.fn(),
      handleKeyboardSizeChange: vi.fn(),
      handleKeyboardSpacingChange: vi.fn(),
      handleStatusChange: vi.fn(),
      handleKeyboardInput: vi.fn(),
      handleReconnect: vi.fn(),
      handleLayoutModeChange: vi.fn(),
      handleAddTab: vi.fn(),
      handleNewATermForProject: vi.fn(),
      handleProjectModeChange,
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
    mockUseATermPanes.mockReturnValue({
      panes: [],
      detachedPanes: [],
      atLimit: false,
      isLoading: false,
      detachedLoadedOnce: true,
      hasLoadedOnce: true,
      swapPanePositions: vi.fn(),
      removePane: vi.fn(),
      detachPane: vi.fn(),
      attachPane: vi.fn(),
      setActiveMode: vi.fn(),
      createAdHocPane: vi.fn(),
      createProjectPane,
      isCreating: false,
      saveLayouts: vi.fn(),
      maxPanes: 6,
    })

    const { result } = renderHook(() =>
      useATermTabsState({
        projectId: undefined,
        projectPath: undefined,
        isDetachedPaneWindow: true,
        detachedWindowPaneIds: [],
        addDetachedWindowPane,
      }),
    )

    await act(async () => {
      await result.current.handleNewATermForProject(
        'project-a',
        undefined,
        '/workspace/project-a',
      )
    })

    expect(createProjectPane).toHaveBeenCalledWith(
      'Project-a',
      'project-a',
      '/workspace/project-a',
      undefined,
      { detached: true },
    )
    expect(addDetachedWindowPane).toHaveBeenCalledWith(
      'pane-project-a',
      'session-codex',
    )
    expect(handleProjectModeChange).toHaveBeenCalledWith(
      'project-a',
      'codex',
      expect.arrayContaining([
        expect.objectContaining({ id: 'session-codex', mode: 'codex' }),
      ]),
      'pane-project-a',
      expect.objectContaining({ id: 'pane-project-a' }),
    )
    expect(switchToSession).not.toHaveBeenCalled()
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
          ...TETHER_CAN,
          session_number: 1,
          is_alive: true,
          working_dir: '/workspace/project-c',
          claude_state: 'not_started',
        },
        {
          id: 'session-created-claude',
          name: 'Project C Claude',
          mode: 'claude',
          ...TETHER_CAN,
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
      detachedPanes: [],
      atLimit: false,
      isLoading: false,
      detachedLoadedOnce: true,
      hasLoadedOnce: true,
      swapPanePositions: vi.fn(),
      removePane: vi.fn(),
      detachPane: vi.fn(),
      attachPane: vi.fn(),
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
            ...TETHER_CAN,
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
                  ...TETHER_CAN,
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
              ...TETHER_CAN,
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
      detachedPanes: [],
      atLimit: false,
      isLoading: false,
      detachedLoadedOnce: true,
      hasLoadedOnce: true,
      swapPanePositions: vi.fn(),
      removePane: vi.fn(),
      detachPane: vi.fn(),
      attachPane: vi.fn(),
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

  it("on a phone, a project link opens the project's own pane, never another agent's session", async () => {
    mockUseMediaQuery.mockReturnValue(true)
    mockUseProjectSettings.mockReturnValue({
      projects: [{ id: 'neri', name: 'Neri' }],
    })
    const switchToSession = vi.fn()
    const otherAgent = {
      ...buildActiveSessionState().sessions[0],
      id: 'other',
      name: 'Neri hunt',
      project_id: 'neri',
      mode: 'codex',
      source: 'tether',
      is_external: true,
      ...TETHER_CAN,
    }
    const createProjectPane = vi.fn().mockResolvedValue({
      id: 'pane-neri',
      pane_type: 'project',
      project_id: 'neri',
      pane_order: 0,
      pane_name: 'Neri',
      active_mode: 'codex',
      created_at: '2026-03-06T00:00:00Z',
      sessions: [
        {
          id: 'neri-own-codex',
          name: 'Neri Codex',
          mode: 'codex',
          ...TETHER_CAN,
          session_number: 1,
          is_alive: true,
          working_dir: '/workspace/neri',
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
        sessions: [otherAgent],
        externalSessions: [otherAgent],
        adHocSessions: [],
        projectATerms: [
          {
            projectId: 'neri',
            projectName: 'Neri',
            rootPath: '/workspace/neri',
            activeMode: 'codex',
            sessions: [{ badge: 1, session: otherAgent }],
            activeSession: otherAgent,
            activeSessionId: 'other',
            sessionBadge: 1,
          },
        ],
      }),
    )
    mockUseATermPanes.mockReturnValue({
      ...mockUseATermPanes(),
      panes: [],
      createProjectPane,
    })

    renderHook(() =>
      useATermTabsState({ projectId: 'neri', projectPath: '/workspace/neri' }),
    )

    await waitFor(() => {
      expect(switchToSession).toHaveBeenCalledWith('neri-own-codex')
    })
    expect(createProjectPane).toHaveBeenCalledWith(
      'Neri',
      'neri',
      '/workspace/neri',
    )
    expect(switchToSession).not.toHaveBeenCalledWith('other')
  })

  it('with only attached Views and nothing chosen, makes the first one the active session', () => {
    const switchToSession = vi.fn()
    const view = {
      ...buildActiveSessionState().sessions[0],
      id: 'v1',
      name: 'Attached view',
      mode: 'codex',
      source: 'tmux_external',
      is_external: true,
      ...OWN_TMUX_CAN,
    }
    mockUseLocalStorageState.mockImplementation(
      (key: string, defaultValue: unknown) =>
        useState(
          (key === `a-term-attached-external-session-ids:${TEST_WINDOW_SCOPE}`
            ? ['v1']
            : defaultValue) as typeof defaultValue,
        ),
    )
    mockUseActiveSession.mockReturnValue(
      buildActiveSessionState({
        activeSessionId: null,
        activeSession: null,
        switchToSession,
        sessions: [view],
        externalSessions: [view],
        adHocSessions: [],
      }),
    )

    renderHook(() =>
      useATermTabsState({ projectId: undefined, projectPath: undefined }),
    )

    expect(switchToSession).toHaveBeenCalledWith('v1')
  })

  it('adds and removes attached external sessions as separate slots', () => {
    mockUseActiveSession.mockReturnValue(
      buildActiveSessionState({
        externalSessions: [
          {
            id: 'external-codex',
            name: 'project-a',
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
            ...OWN_TMUX_CAN,
            tmux_session_name: 'aico-deadbeef',
            tmux_source: 'tether',
            origin: 'aico',
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
              ...TETHER_CAN,
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
      detachedPanes: [],
      atLimit: false,
      isLoading: false,
      detachedLoadedOnce: true,
      hasLoadedOnce: true,
      swapPanePositions: vi.fn(),
      removePane: vi.fn(),
      detachPane: vi.fn(),
      attachPane: vi.fn(),
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

    expect(result.current.aTermSlots).toHaveLength(1)

    act(() => {
      result.current.attachExternalSession('external-codex')
    })
    expect(result.current.aTermSlots).toHaveLength(2)
    expect(result.current.aTermSlots[1]).toMatchObject({
      name: 'Project A',
    })
    expect(result.current.orderedIds).toEqual([
      'pane-pane-project-a',
      'adhoc-external-codex',
    ])

    mockUseActiveSession.mockReturnValue(
      buildActiveSessionState({
        externalSessions: [
          {
            id: 'external-codex',
            name: 'Incident review',
            user_id: null,
            project_id: 'project-a',
            working_dir: '/workspace/project-a',
            mode: 'codex',
            display_order: 3,
            is_alive: true,
            created_at: null,
            last_accessed_at: null,
            is_external: true,
            source: 'tmux_external',
            ...OWN_TMUX_CAN,
          },
        ],
      }),
    )
    rerender()
    expect(result.current.aTermSlots[1]).toMatchObject({
      name: 'Project A · Incident review',
    })

    act(() => {
      result.current.detachExternalSession('external-codex')
    })
    expect(result.current.aTermSlots).toHaveLength(1)
  })

  it('swaps externally attached panes in the visible slot order', async () => {
    const swapPanePositions = vi.fn()
    mockUseLocalStorageState.mockImplementation(
      (_key: string, defaultValue: unknown) => useState(defaultValue),
    )
    mockUseActiveSession.mockReturnValue(
      buildActiveSessionState({
        externalSessions: [
          {
            id: 'external-codex',
            name: 'codex-a-term',
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
            ...OWN_TMUX_CAN,
          },
          {
            id: 'external-claude',
            name: 'claude-a-term',
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
            ...OWN_TMUX_CAN,
          },
        ],
      }),
    )
    mockUseATermPanes.mockReturnValue({
      panes: [],
      detachedPanes: [],
      atLimit: false,
      isLoading: false,
      detachedLoadedOnce: true,
      hasLoadedOnce: true,
      swapPanePositions,
      removePane: vi.fn(),
      detachPane: vi.fn(),
      attachPane: vi.fn(),
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
      await result.current.swapPanes(
        'adhoc-external-codex',
        'adhoc-external-claude',
      )
    })

    expect(result.current.orderedIds).toEqual([
      'adhoc-external-claude',
      'adhoc-external-codex',
    ])
    expect(swapPanePositions).not.toHaveBeenCalled()
  })

  it.each([
    {
      from: 2,
      to: 3,
      stored: undefined,
      before: 'split-horizontal',
      after: 'split-main-side',
    },
    {
      from: 3,
      to: 2,
      stored: 'split-main-side',
      before: 'split-main-side',
      after: 'split-horizontal',
    },
    {
      from: 1,
      to: 2,
      stored: undefined,
      before: 'split-horizontal',
      after: 'split-horizontal',
    },
  ])(
    'moves from $before to $after when the pane count goes from $from to $to',
    async ({ from, to, stored, before, after }) => {
      const projectPane = (letter: string, order: number, count: number) => ({
        id: `pane-project-${letter}`,
        pane_type: 'project' as const,
        project_id: `project-${letter}`,
        pane_order: order,
        pane_name: `Project ${letter.toUpperCase()}`,
        active_mode: 'shell',
        created_at: '2026-03-06T00:00:00Z',
        sessions: [
          {
            id: `session-project-${letter}`,
            name: `Project ${letter.toUpperCase()} Shell`,
            mode: 'shell',
            ...TETHER_CAN,
            session_number: 1,
            is_alive: true,
            working_dir: `/workspace/project-${letter}`,
            claude_state: 'not_started',
          },
        ],
        width_percent: 100 / count,
        height_percent: 100,
        grid_row: 0,
        grid_col: order,
      })
      const panesFor = (count: number) =>
        ['a', 'b', 'c']
          .slice(0, count)
          .map((letter, order) => projectPane(letter, order, count))
      let panes = panesFor(from)

      mockUseActiveSession.mockReturnValue(buildActiveSessionState())
      mockUseLocalStorageState.mockImplementation(
        (key: string, defaultValue: unknown) =>
          useState(
            (key === `a-term-layout-mode:${TEST_WINDOW_SCOPE}` && stored
              ? stored
              : defaultValue) as typeof defaultValue,
          ),
      )
      mockUseAvailableLayouts.mockImplementation((paneCount: number) => {
        if (paneCount === 3) {
          return ['split-horizontal', 'split-vertical', 'split-main-side']
        }
        if (paneCount === 2) {
          return ['split-horizontal', 'split-vertical']
        }
        return ['split-horizontal']
      })
      mockUseATermPanes.mockImplementation(() => ({
        panes,
        detachedPanes: [],
        atLimit: false,
        isLoading: false,
        detachedLoadedOnce: true,
        hasLoadedOnce: true,
        swapPanePositions: vi.fn(),
        removePane: vi.fn(),
        detachPane: vi.fn(),
        attachPane: vi.fn(),
        setActiveMode: vi.fn(),
        createAdHocPane: vi.fn(),
        createProjectPane: vi.fn(),
        isCreating: false,
        saveLayouts: vi.fn(),
        maxPanes: 6,
      }))

      const { result, rerender } = renderHook(() =>
        useATermTabsState({ projectId: undefined, projectPath: undefined }),
      )

      expect(result.current.layoutMode).toBe(before)

      panes = panesFor(to)
      rerender()

      await waitFor(() => {
        expect(result.current.layoutMode).toBe(after)
      })
    },
  )
  it('restores persisted attached external panes and keeps the persisted layout after refresh', () => {
    let activeSessionState = buildActiveSessionState({
      externalSessions: [],
      isLoading: true,
    })
    const persistedState: Record<string, unknown> = {
      [`a-term-layout-mode:${TEST_WINDOW_SCOPE}`]: 'split-vertical',
      [`a-term-slot-order:${TEST_WINDOW_SCOPE}`]: [
        'pane-pane-project-a',
        'adhoc-external-codex',
      ],
      [`a-term-attached-external-session-ids:${TEST_WINDOW_SCOPE}`]: [
        'external-codex',
      ],
    }

    mockUseActiveSession.mockImplementation(() => activeSessionState)
    mockUseLocalStorageState.mockImplementation(
      (key: string, defaultValue: unknown) =>
        useState((persistedState[key] ?? defaultValue) as typeof defaultValue),
    )
    mockUseAvailableLayouts.mockImplementation((paneCount: number) =>
      paneCount > 1
        ? ['split-horizontal', 'split-vertical']
        : ['split-horizontal'],
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
              ...TETHER_CAN,
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
      detachedPanes: [],
      atLimit: false,
      isLoading: false,
      detachedLoadedOnce: true,
      hasLoadedOnce: true,
      swapPanePositions: vi.fn(),
      removePane: vi.fn(),
      detachPane: vi.fn(),
      attachPane: vi.fn(),
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
    expect(result.current.aTermSlots).toHaveLength(1)

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
          ...OWN_TMUX_CAN,
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
    expect(result.current.aTermSlots).toHaveLength(2)
  })
})
