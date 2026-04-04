import type { ComponentProps } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalManagerModal } from './TerminalManagerModal'

const mockUseProjectSettings = vi.fn()

vi.mock('@/lib/hooks/use-project-settings', () => ({
  useProjectSettings: () => mockUseProjectSettings(),
}))

function buildProject(id: string, name: string, rootPath: string) {
  return {
    id,
    name,
    root_path: rootPath,
    terminal_enabled: true,
    mode: 'shell',
    display_order: 0,
  }
}

function renderModal(overrides: Partial<ComponentProps<typeof TerminalManagerModal>> = {}) {
  return render(
    <TerminalManagerModal
      isOpen={true}
      onClose={vi.fn()}
      onCreateGenericTerminal={vi.fn()}
      onCreateProjectTerminal={vi.fn()}
      externalSessions={[]}
      detachedPanes={[]}
      onAttachExternalSession={vi.fn()}
      onAttachDetachedPane={vi.fn()}
      panes={[]}
      {...overrides}
    />,
  )
}

function buildProjectSettingsState(overrides: Record<string, unknown> = {}) {
  const projects = [
    buildProject('proj-agent-hub', 'Agent Hub', '/workspace/agent-hub'),
    buildProject('proj-terminal', 'Terminal', '/workspace/terminal'),
    buildProject('proj-portfolio', 'Portfolio AI', '/workspace/portfolio-ai'),
  ]

  return {
    projects,
    enabledProjects: projects,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
    ...overrides,
  }
}

describe('TerminalManagerModal', () => {
  beforeEach(() => {
    mockUseProjectSettings.mockReturnValue(buildProjectSettingsState())
  })

  it('filters projects by project name and attachable session metadata', () => {
    renderModal({
      externalSessions: [
        {
          id: 'codex-terminal',
          name: 'codex-terminal',
          user_id: null,
          project_id: 'proj-terminal',
          working_dir: '/workspace/terminal',
          mode: 'codex',
          display_order: 0,
          is_alive: true,
          created_at: null,
          last_accessed_at: null,
          is_external: true,
          source: 'tmux_external',
        },
      ],
    })

    fireEvent.change(screen.getByPlaceholderText(/filter by project/i), {
      target: { value: 'codex-terminal' },
    })

    expect(screen.getByText('Terminal')).toBeInTheDocument()
    expect(screen.queryByText('Agent Hub')).not.toBeInTheDocument()
  })

  it('uses a full-height mobile layout with a shared scroll region', () => {
    renderModal()

    expect(screen.getByTestId('terminal-manager-modal').className).toContain('top-3')
    expect(screen.getByTestId('terminal-manager-modal').className).toContain('bottom-3')
    expect(screen.getByTestId('terminal-manager-scroll-region').className).toContain('flex-1')
    expect(screen.getByTestId('terminal-manager-scroll-region').className).toContain('overflow-y-auto')
  })

  it('creates an ad-hoc terminal from quick start', () => {
    const onCreateGenericTerminal = vi.fn()

    renderModal({ onCreateGenericTerminal })

    fireEvent.click(screen.getByText('New Ad-Hoc Terminal'))

    expect(onCreateGenericTerminal).toHaveBeenCalledTimes(1)
  })

  it('attaches a single existing project session without closing the modal directly', () => {
    const onAttachExternalSession = vi.fn()
    const onClose = vi.fn()

    renderModal({
      onAttachExternalSession,
      onClose,
      externalSessions: [
        {
          id: 'codex-terminal',
          name: 'codex-terminal',
          user_id: null,
          project_id: 'proj-terminal',
          working_dir: '/workspace/terminal',
          mode: 'codex',
          display_order: 0,
          is_alive: true,
          created_at: null,
          last_accessed_at: null,
          is_external: true,
          source: 'tmux_external',
        },
      ],
    })

    fireEvent.click(screen.getByRole('button', { name: 'Attach' }))

    expect(onAttachExternalSession).toHaveBeenCalledWith('codex-terminal')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('lets the user choose between multiple project sessions before attaching', () => {
    const onAttachExternalSession = vi.fn()

    renderModal({
      onAttachExternalSession,
      externalSessions: [
        {
          id: 'claude-agent-hub',
          name: 'claude-agent-hub',
          user_id: null,
          project_id: 'proj-agent-hub',
          working_dir: '/workspace/agent-hub',
          mode: 'claude',
          display_order: 0,
          is_alive: true,
          created_at: null,
          last_accessed_at: null,
          is_external: true,
          source: 'tmux_external',
        },
        {
          id: 'codex-agent-hub',
          name: 'codex-agent-hub',
          user_id: null,
          project_id: 'proj-agent-hub',
          working_dir: '/workspace/agent-hub',
          mode: 'codex',
          display_order: 0,
          is_alive: true,
          created_at: null,
          last_accessed_at: null,
          is_external: true,
          source: 'tmux_external',
        },
      ],
    })

    fireEvent.change(screen.getByLabelText('Select existing session for Agent Hub'), {
      target: { value: 'codex-agent-hub' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }))

    expect(onAttachExternalSession).toHaveBeenCalledWith('codex-agent-hub')
  })

  it('starts a fresh project terminal even when attachable sessions exist', () => {
    const onCreateProjectTerminal = vi.fn()

    renderModal({
      onCreateProjectTerminal,
      externalSessions: [
        {
          id: 'codex-terminal',
          name: 'codex-terminal',
          user_id: null,
          project_id: 'proj-terminal',
          working_dir: '/workspace/terminal',
          mode: 'codex',
          display_order: 0,
          is_alive: true,
          created_at: null,
          last_accessed_at: null,
          is_external: true,
          source: 'tmux_external',
        },
      ],
    })

    const newButtons = screen.getAllByRole('button', { name: 'New' })
    fireEvent.click(newButtons[0])

    expect(onCreateProjectTerminal).toHaveBeenCalledWith('proj-agent-hub', '/workspace/agent-hub')
  })

  it('shows unmatched attachables in an other sessions fallback section', () => {
    renderModal({
      externalSessions: [
        {
          id: 'codex-unknown',
          name: 'codex-unknown',
          user_id: null,
          project_id: 'proj-missing',
          working_dir: '/workspace/missing',
          mode: 'codex',
          display_order: 0,
          is_alive: true,
          created_at: null,
          last_accessed_at: null,
          is_external: true,
          source: 'tmux_external',
        },
      ],
    })

    expect(screen.getByText('Other Attachables')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /codex-unknown/i })).toBeInTheDocument()
  })

  it('reattaches a detached managed pane from the matching project row', () => {
    const onAttachDetachedPane = vi.fn()

    renderModal({
      onAttachDetachedPane,
      detachedPanes: [
        {
          id: 'pane-terminal',
          pane_type: 'project',
          project_id: 'proj-terminal',
          pane_order: 0,
          pane_name: 'Terminal',
          active_mode: 'codex',
          is_detached: true,
          created_at: null,
          sessions: [
            {
              id: 'shell-terminal',
              name: 'Terminal Shell',
              mode: 'shell',
              session_number: 1,
              is_alive: true,
              working_dir: '/workspace/terminal',
              claude_state: 'not_started',
            },
            {
              id: 'codex-terminal',
              name: 'Terminal Codex',
              mode: 'codex',
              session_number: 1,
              is_alive: true,
              working_dir: '/workspace/terminal',
              claude_state: 'running',
            },
          ],
          width_percent: 100,
          height_percent: 100,
          grid_row: 0,
          grid_col: 0,
        },
      ],
    })

    fireEvent.click(screen.getByRole('button', { name: 'Attach' }))

    expect(onAttachDetachedPane).toHaveBeenCalledWith('pane-terminal')
  })

  it('shows a shared no-match summary when the search has no results', () => {
    renderModal()

    fireEvent.change(screen.getByPlaceholderText(/filter by project/i), {
      target: { value: 'missing-workspace' },
    })

    expect(
      screen.getByText(/No terminals match "missing-workspace"/),
    ).toBeInTheDocument()
  })

  it('shows a loading state while project workspaces are loading', () => {
    mockUseProjectSettings.mockReturnValue(
      buildProjectSettingsState({
        projects: [],
        enabledProjects: [],
        isLoading: true,
      }),
    )

    renderModal()

    expect(
      screen.getByText(/Loading project workspaces/),
    ).toBeInTheDocument()
    expect(screen.getByTestId('terminal-manager-scroll-region')).toHaveAttribute(
      'aria-busy',
      'true',
    )
  })

  it('shows an error state with retry when project loading fails', () => {
    const refetch = vi.fn()
    mockUseProjectSettings.mockReturnValue(
      buildProjectSettingsState({
        projects: [],
        enabledProjects: [],
        isError: true,
        error: new Error('SummitFlow projects are unavailable'),
        refetch,
      }),
    )

    renderModal()

    expect(
      screen.getByText('SummitFlow projects are unavailable'),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(refetch).toHaveBeenCalledTimes(1)
  })
})
