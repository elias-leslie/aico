import { beforeEach, describe, expect, it, vi } from 'vitest'
import { addProjectPaneAction } from './a-term-handler-actions'
import { waitForTmuxInit } from './a-term-handler-utils'

vi.mock('./a-term-handler-utils', async () => {
  const actual = await vi.importActual<typeof import('./a-term-handler-utils')>(
    './a-term-handler-utils',
  )
  return {
    ...actual,
    waitForTmuxInit: vi.fn().mockResolvedValue(undefined),
  }
})

describe('addProjectPaneAction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates the requested agent tool pane and starts that session', async () => {
    const createProjectPane = vi.fn().mockResolvedValue({
      id: 'pane-project-a',
      pane_type: 'project',
      project_id: 'project-a',
      pane_order: 1,
      pane_name: 'Project-a',
      active_mode: 'codex',
      created_at: '2026-03-13T00:00:00Z',
      sessions: [
        {
          id: 'session-shell',
          name: 'Project A Shell',
          mode: 'shell',
          session_number: 1,
          is_alive: true,
          working_dir: '/workspace/project-a',
          claude_state: 'not_started',
        },
        {
          id: 'session-codex',
          name: 'Project A Codex',
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
    const navigateToSession = vi.fn()
    const startAgent = vi.fn().mockResolvedValue(true)

    await addProjectPaneAction(
      'project-a',
      'codex',
      '/workspace/project-a',
      [],
      [],
      false,
      createProjectPane,
      navigateToSession,
      startAgent,
    )

    expect(createProjectPane).toHaveBeenCalledWith(
      'Project-a',
      'project-a',
      '/workspace/project-a',
      'codex',
    )
    expect(navigateToSession).toHaveBeenCalledWith('session-codex')
    expect(waitForTmuxInit).toHaveBeenCalledTimes(1)
    expect(startAgent).toHaveBeenCalledWith('session-codex')
  })

  it('opens new project panes in shell mode when no explicit mode is requested', async () => {
    const createProjectPane = vi.fn().mockResolvedValue({
      id: 'pane-project-b',
      pane_type: 'project',
      project_id: 'project-b',
      pane_order: 2,
      pane_name: 'Project-b',
      active_mode: 'shell',
      created_at: '2026-03-13T00:00:00Z',
      sessions: [
        {
          id: 'session-shell',
          name: 'Project B Shell',
          mode: 'shell',
          session_number: 1,
          is_alive: true,
          working_dir: '/workspace/project-b',
          claude_state: 'not_started',
        },
        {
          id: 'session-claude',
          name: 'Project B Claude',
          mode: 'claude',
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
    const navigateToSession = vi.fn()
    const startAgent = vi.fn().mockResolvedValue(true)

    await addProjectPaneAction(
      'project-b',
      undefined,
      '/workspace/project-b',
      [],
      [],
      false,
      createProjectPane,
      navigateToSession,
      startAgent,
    )

    expect(createProjectPane).toHaveBeenCalledWith(
      'Project-b',
      'project-b',
      '/workspace/project-b',
      undefined,
    )
    expect(navigateToSession).toHaveBeenCalledWith('session-shell')
    expect(waitForTmuxInit).not.toHaveBeenCalled()
    expect(startAgent).not.toHaveBeenCalled()
  })
})
