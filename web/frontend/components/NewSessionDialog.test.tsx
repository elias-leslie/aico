import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NewSessionDialog } from './NewSessionDialog'

type Start = ComponentProps<typeof NewSessionDialog>['onStart']

const projectState = vi.hoisted(() => ({
  projects: [] as Array<{ id: string; name: string; root_path: string | null }>,
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
}))
const tools = [
  { slug: 'claude-code', name: 'Claude Code', color: null, description: null },
  { slug: 'codex', name: 'Codex', color: null, description: null },
  {
    slug: 'agent-hub',
    name: 'Agent Hub',
    color: '#7C83F6',
    description: 'Any model',
  },
]

vi.mock('@/lib/hooks/use-project-settings', () => ({
  useProjectSettings: () => projectState,
}))
const hostState = vi.hoisted(() => ({
  hosts: [] as Array<{ name: string; state: string }>,
  isLoading: false,
  isError: false,
}))
const hostProjects = vi.hoisted(() => ({
  lists: {} as Record<
    string,
    Array<{ id: string; name: string; root_path: string | null }>
  >,
  failures: {} as Record<string, string>,
}))
vi.mock('@/lib/hooks/use-hosts', () => ({
  HOST_STATE_LABELS: {
    connected: '',
    connecting: 'connecting',
    offline: 'offline',
    powered_off: 'powered off',
    identity_changed: 'changed',
  },
  useHosts: () => hostState,
  useHostProjects: (host: string | undefined) => {
    const failure = host ? hostProjects.failures[host] : undefined
    return {
      projects: (host && hostProjects.lists[host]) || [],
      isLoading: false,
      isError: Boolean(failure),
      error: failure ? new Error(failure) : null,
      refetch: vi.fn(),
    }
  },
}))
vi.mock('@/lib/hooks/use-agent-tools', () => ({
  CHAT_TOOL_SLUG: 'agent-hub',
  useAgentTools: () => ({ enabledTools: tools, defaultTool: tools[0] }),
}))

function renderDialog(defaultProjectId?: string, onStart = vi.fn<Start>()) {
  const onClose = vi.fn()
  render(
    <NewSessionDialog
      isOpen
      onClose={onClose}
      onStart={onStart}
      defaultProjectId={defaultProjectId}
    />,
  )
  return { onStart, onClose }
}

describe('NewSessionDialog', () => {
  beforeEach(() => {
    projectState.projects = [
      { id: 'aico', name: 'Aico', root_path: '/srv/aico' },
      { id: 'neri', name: 'Neri', root_path: '/srv/neri' },
    ]
    projectState.isLoading = false
    projectState.isError = false
    hostState.hosts = []
    hostState.isError = false
    hostProjects.lists = {
      'agent-work': [{ id: 'neri', name: 'Neri', root_path: '/home/u/neri' }],
      lab: [{ id: 'neri', name: 'Neri', root_path: '/home/u/neri' }],
    }
    hostProjects.failures = {}
  })

  it('offers no host choice when Tether links to no host', () => {
    renderDialog()
    expect(screen.queryByRole('group', { name: 'Runs on' })).toBeNull()
  })

  it('starts on a chosen host, with This computer as the default', () => {
    hostState.hosts = [
      { name: 'agent-work', state: 'connected' },
      { name: 'lab', state: 'offline' },
    ]
    const { onStart } = renderDialog('neri')
    const hosts = screen.getByRole('group', { name: 'Runs on' })
    expect(
      screen.getByRole('button', { name: 'This computer' }),
    ).toHaveAttribute('aria-pressed', 'true')
    expect(hosts).toHaveTextContent('offline')
    fireEvent.click(screen.getByRole('button', { name: 'agent-work' }))
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Start Claude Code in Neri on agent-work',
      }),
    )
    expect(onStart).toHaveBeenCalledWith(
      'neri',
      '/home/u/neri',
      'claude-code',
      'agent-work',
    )
  })

  it("lists the chosen host's projects, and says why when it can't", () => {
    hostState.hosts = [
      { name: 'agent-work', state: 'connected' },
      { name: 'lab', state: 'offline' },
    ]
    hostProjects.lists['agent-work'] = [
      { id: 'tools', name: 'Tools', root_path: '/home/u/tools' },
    ]
    delete hostProjects.lists.lab
    hostProjects.failures.lab = 'lab is offline (link down)'
    renderDialog('aico')
    fireEvent.click(screen.getByRole('button', { name: 'agent-work' }))
    expect(screen.queryByRole('radio', { name: /Aico/ })).toBeNull()
    expect(
      screen.getByRole('button', {
        name: 'Start Claude Code in Tools on agent-work',
      }),
    ).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: /^lab/ }))
    expect(screen.getByText(/lab is offline \(link down\)\./)).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Start/ })).toBeDisabled()
  })

  it('keeps the dialog open with the reason when the host is away', async () => {
    hostState.hosts = [{ name: 'lab', state: 'offline' }]
    const onStart = vi.fn<Start>(() =>
      Promise.reject(new Error('lab is offline (link down)')),
    )
    const { onClose } = renderDialog('neri', onStart)
    fireEvent.click(screen.getByRole('button', { name: /^lab/ }))
    fireEvent.click(
      screen.getByRole('button', { name: 'Start Claude Code in Neri on lab' }),
    )
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'lab is offline (link down)',
      ),
    )
    expect(onClose).not.toHaveBeenCalled()
  })

  it('hides the host choice for an Agent Hub chat, which runs here', () => {
    hostState.hosts = [{ name: 'agent-work', state: 'connected' }]
    const { onStart } = renderDialog('neri')
    fireEvent.click(screen.getByRole('button', { name: 'agent-work' }))
    fireEvent.click(screen.getByRole('button', { name: /Agent Hub/ }))
    expect(screen.queryByRole('group', { name: 'Runs on' })).toBeNull()
    fireEvent.click(
      screen.getByRole('button', { name: 'Start Agent Hub in Neri' }),
    )
    expect(onStart).toHaveBeenCalledWith('neri', '/srv/neri', 'agent-hub')
  })

  it("starts the default agent in the open session's project", () => {
    const { onStart, onClose } = renderDialog('neri')

    expect(screen.getByRole('radio', { name: /Neri/ })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Start Claude Code in Neri' }),
    )
    expect(onStart).toHaveBeenCalledWith('neri', '/srv/neri', 'claude-code')
    expect(onClose).toHaveBeenCalled()
  })

  it('puts the agent picker above the project list, outside its scroll', () => {
    renderDialog()

    const agents = screen.getByRole('group', { name: 'Agent' })
    const list = screen.getByRole('radiogroup', { name: 'Project' })
    expect(
      agents.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(list.closest('.overflow-y-auto')?.contains(agents)).toBe(false)
  })

  it('starts the chosen agent, or a shell, in the chosen project', () => {
    const { onStart } = renderDialog()

    fireEvent.click(screen.getByRole('radio', { name: /Neri/ }))
    fireEvent.click(screen.getByRole('button', { name: /Codex/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Start Codex in Neri' }))
    expect(onStart).toHaveBeenLastCalledWith('neri', '/srv/neri', 'codex')
  })

  it('starts a shell when Shell is chosen', () => {
    const { onStart } = renderDialog()

    fireEvent.click(screen.getByRole('button', { name: 'Shell' }))
    expect(screen.queryByRole('button', { name: /Codex/ })).toBeNull()
    fireEvent.click(
      screen.getByRole('button', { name: 'Start a shell in Aico' }),
    )
    expect(onStart).toHaveBeenCalledWith('aico', '/srv/aico', 'shell')
  })

  it('lists Agent Hub with its note and starts it as the chosen agent', () => {
    const { onStart } = renderDialog('neri')

    fireEvent.click(screen.getByRole('button', { name: /Agent Hub/ }))
    expect(screen.getByTestId('new-session-tool-note')).toHaveTextContent(
      'Any model',
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Start Agent Hub in Neri' }),
    )
    expect(onStart).toHaveBeenCalledWith('neri', '/srv/neri', 'agent-hub')
  })

  it('filters projects by name or path', () => {
    renderDialog()

    fireEvent.change(
      screen.getByRole('searchbox', { name: 'Find a project' }),
      {
        target: { value: 'srv/ner' },
      },
    )
    expect(screen.getAllByRole('radio')).toHaveLength(1)
    fireEvent.change(
      screen.getByRole('searchbox', { name: 'Find a project' }),
      {
        target: { value: 'zzz' },
      },
    )
    expect(screen.getByText('No project matches “zzz”.')).toBeInTheDocument()
  })

  it('offers a retry when projects fail to load, and cannot start', () => {
    projectState.projects = []
    projectState.isError = true
    renderDialog()

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(projectState.refetch).toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled()
  })
})
