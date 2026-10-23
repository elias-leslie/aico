import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OWN_TMUX_CAN,
  ROOT_CAN,
  TETHER_CAN,
} from '@/test-stubs/session-fixtures'
import { useATermTabsState } from './use-a-term-tabs-state'

const mockUseActiveSession = vi.fn()
const mockUseATermPanes = vi.fn()
const mockUseATermSettings = vi.fn()
const mockUseATermHandlers = vi.fn()
const mockUseMediaQuery = vi.fn()
const mockUseProjectSettings = vi.fn()

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

vi.mock('@/lib/hooks/use-media-query', () => ({
  useMediaQuery: (query: string) => mockUseMediaQuery(query),
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

    mockUseATermPanes.mockReturnValue({
      panes: [],
      detachedPanes: [],
      isLoading: false,
      removePane: vi.fn(),
      setActiveMode: vi.fn(),
      createProjectPane: vi.fn(),
      isCreating: false,
    })

    mockUseATermHandlers.mockReturnValue({
      handleStatusChange: vi.fn(),
      handleKeyboardInput: vi.fn(),
      handleComposeInput: vi.fn(),
      handleReconnect: vi.fn(),
      handleNewATermForProject: vi.fn(),
      handleProjectModeChange: vi.fn(),
      setATermRef: vi.fn(),
      remove: vi.fn(),
      reset: vi.fn(),
      sessionsLoading: false,
      projectsLoading: false,
    })

    mockUseMediaQuery.mockReturnValue(false)
    mockUseATermSettings.mockImplementation((projectId?: string) => ({
      fontSize:
        projectId === 'project-a' ? 16 : projectId === 'project-b' ? 18 : 14,
      setFontSize: vi.fn(),
    }))
  })

  it('lists attached and detached panes once each, even with shell and agent sessions', () => {
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
      isLoading: false,
      removePane: vi.fn(),
      setActiveMode: vi.fn(),
      createProjectPane: vi.fn(),
      isCreating: false,
    })

    const { result } = renderHook(() =>
      useATermTabsState({ projectId: undefined, projectPath: undefined }),
    )

    expect(mockUseActiveSession).toHaveBeenCalledWith({
      includeDetached: true,
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
  })

  it('shows the project and custom session name together in the switcher', () => {
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

  it('maps sessions no pane shows through the backend flags: no Reset on a free-standing View', () => {
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
        sessions: [freeTether, unloadedTether],
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
          slotId: 'session-unloaded-tether',
          type: 'adhoc',
          name: 'Plain agent',
          isExternal: false,
          can: { rename: true, reset: true, end: true },
        }),
      ]),
    )
  })

  it("lists another agent's session in the switcher but never opens it unasked", () => {
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

    // Chosen from the switcher or the manager: kept.
    state = {
      ...state,
      activeSessionId: 'other-agent',
      activeSession: otherAgent,
    }
    rerender()
    expect(result.current.activeSessionId).toBe('other-agent')
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
    expect(result.current.fontSize).toBe(16)
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
    expect(result.current.fontSize).toBe(18)
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
    expect(result.current.fontSize).toBe(14)
    expect(mockUseATermSettings).toHaveBeenLastCalledWith(undefined)
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
      isLoading: false,
      removePane: vi.fn(),
      setActiveMode: vi.fn(),
      createProjectPane,
      isCreating: false,
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
        undefined,
        { detached: true },
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
      isLoading: false,
      removePane: vi.fn(),
      setActiveMode: vi.fn(),
      createProjectPane,
      isCreating: false,
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

  it("a project link opens the project's own pane, never another agent's session", async () => {
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
      undefined,
      { detached: true },
    )
    expect(switchToSession).not.toHaveBeenCalledWith('other')
  })

  it('creates new sessions detached, so no pane limit applies', async () => {
    mockUseActiveSession.mockReturnValue(buildActiveSessionState())
    const panes = mockUseATermPanes()
    renderHook(() => useATermTabsState({}))

    const handlerParams = mockUseATermHandlers.mock.calls.at(-1)?.[0] as {
      createProjectPane: (
        name: string,
        projectId: string,
        dir?: string,
        tool?: string,
      ) => Promise<unknown>
    }
    await handlerParams.createProjectPane('A', 'project-a', '/a', 'codex')
    expect(panes.createProjectPane).toHaveBeenCalledWith(
      'A',
      'project-a',
      '/a',
      'codex',
      { detached: true },
    )
  })
})
