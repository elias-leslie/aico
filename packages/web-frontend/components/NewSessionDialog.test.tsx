import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import type { ComponentProps } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { rememberWorkstation } from '@/lib/machine-name'
import { NewSessionDialog } from './NewSessionDialog'

type Start = ComponentProps<typeof NewSessionDialog>['onStart']

const projectState = vi.hoisted(() => ({
  projects: [] as Array<{ id: string; name: string; root_path: string | null }>,
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
}))
const tools = [
  {
    slug: 'claude-code',
    name: 'Claude Code',
    color: null,
    description: null,
    aliases: ['claude'],
  },
  { slug: 'codex', name: 'Codex', color: null, description: null, aliases: [] },
  { slug: 'pi', name: 'Pi', color: null, description: null, aliases: [] },
]

vi.mock('@/lib/hooks/use-project-settings', () => ({
  useProjectSettings: () => projectState,
}))
const statusState = vi.hoisted(() => ({ machine: 'davion-sidarli' }))
const hostState = vi.hoisted(() => ({
  hosts: [] as Array<{ name: string; state: string; wake?: unknown }>,
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
vi.mock('@/lib/hooks/use-status', () => ({
  useStatus: () => {
    rememberWorkstation(statusState.machine)
    return {}
  },
}))
vi.mock('@/lib/hooks/use-hosts', async (importOriginal) => ({
  startingLabel: (
    await importOriginal<typeof import('@/lib/hooks/use-hosts')>()
  ).startingLabel,
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
  useAgentTools: () => ({ enabledTools: tools, defaultTool: tools[0] }),
}))

const usage = vi.hoisted(() => ({
  report: null as unknown,
}))
vi.mock('@/lib/hooks/use-usage', () => ({
  useUsage: () => ({ report: usage.report }),
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
    localStorage.clear()
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

  it('says what each subscription has left beside its agent, and nothing when not known', () => {
    const provider = (id: string, status: string, left: number | null) => ({
      id,
      name: id,
      status,
      answer: `${id} answer`,
      credits: null,
      windows:
        left === null
          ? []
          : [
              {
                label: 'Weekly',
                state: 'ok',
                left_percent: left,
                text: `Weekly ${left}% left`,
                resets_at: null,
                length_seconds: 604800,
                resets_in_seconds: null,
              },
            ],
    })
    usage.report = {
      providers: [
        provider('claude', 'ok', 73),
        provider('codex', 'on_credits', 0),
      ],
    }
    renderDialog()
    const agent = () => screen.getByRole('group', { name: 'Agent' })
    const claude = () =>
      within(agent()).getByRole('button', { name: /Claude Code/ })
    expect(claude()).toHaveTextContent('73% left')
    expect(claude()).toHaveAttribute('title', 'claude answer')
    expect(
      within(agent()).getByRole('button', { name: /Codex/ }),
    ).toHaveTextContent('on credits')
    expect(
      within(agent()).getByRole('button', { name: 'Pi' }),
    ).not.toHaveAttribute('title')
    cleanup()
    usage.report = {
      providers: [
        provider('claude', 'partly_unknown', 90),
        provider('codex', 'used_up', 0),
      ],
    }
    renderDialog()
    // A window not reporting could be the tighter one, so no number; the tooltip says why.
    expect(claude()).toHaveTextContent(/^Claude Code$/)
    expect(claude()).toHaveAttribute('title', 'claude answer')
    expect(
      within(agent()).getByRole('button', { name: /Codex/ }),
    ).toHaveTextContent('used up')
    cleanup()
    // Pi's subscription has another name; the usage report lists Pi under it.
    usage.report = {
      providers: [{ ...provider('opencode-go', 'used_up', 0), tools: ['pi'] }],
    }
    renderDialog()
    const pi = within(agent()).getByRole('button', { name: /^Pi/ })
    expect(pi).toHaveTextContent('opencode-go used up')
    expect(pi).toHaveAttribute('title', 'opencode-go answer')
    usage.report = null
  })

  it('offers no host choice when Tether links to no host', () => {
    renderDialog()
    expect(screen.queryByRole('group', { name: 'Runs on' })).toBeNull()
  })

  it('names this machine the Standby when the Standby serves the page', () => {
    statusState.machine = 'aico'
    hostState.hosts = [{ name: 'davion-sidarli', state: 'offline' }]
    renderDialog('neri')
    const hosts = screen.getByRole('group', { name: 'Runs on' })
    expect(within(hosts).getByRole('button', { name: 'Standby' })).toBeTruthy()
    expect(within(hosts).getAllByRole('button', { name: /Workstation/ })).toHaveLength(1)
    statusState.machine = 'davion-sidarli'
    rememberWorkstation('davion-sidarli')
  })

  it('starts on a chosen host, with Workstation as the default', () => {
    hostState.hosts = [
      { name: 'agent-work', state: 'connected' },
      { name: 'lab', state: 'offline' },
    ]
    const { onStart } = renderDialog('neri')
    const hosts = screen.getByRole('group', { name: 'Runs on' })
    expect(screen.getByRole('button', { name: 'Workstation' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
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

  it('shows the host starting while a create waits on it', async () => {
    hostState.hosts = [
      {
        name: 'agent-work',
        state: 'powered_off',
        wake: { state: 'starting', step: 'powering_on' },
      },
    ]
    renderDialog(
      'neri',
      vi.fn<Start>(() => new Promise<void>(() => {})),
    )
    fireEvent.click(screen.getByRole('button', { name: /^agent-work/ }))
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Start Claude Code in Neri on agent-work',
      }),
    )
    expect(
      await screen.findByText('Starting agent-work… powering on'),
    ).toBeInTheDocument()
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

    // Connected but its list fails: say why, and nothing to start in.
    hostState.hosts[1] = { name: 'lab', state: 'connected' }
    fireEvent.click(screen.getByRole('button', { name: /^lab/ }))
    expect(screen.getByText(/lab is offline \(link down\)\./)).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Start/ })).toBeDisabled()
  })

  it("starts on a host that is off in this computer's projects, which turns it on", () => {
    hostState.hosts = [{ name: 'agent-work', state: 'offline' }]
    delete hostProjects.lists['agent-work']
    hostProjects.failures['agent-work'] =
      'agent-work is offline (not reachable)'
    const { onStart } = renderDialog('neri')
    fireEvent.click(screen.getByRole('button', { name: /^agent-work/ }))
    expect(screen.getByText(/agent-work is off or out of reach/)).toBeTruthy()
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Start Claude Code in Neri on agent-work',
      }),
    )
    expect(onStart).toHaveBeenCalledWith(
      'neri',
      '/srv/neri',
      'claude-code',
      'agent-work',
    )
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

  it('starts in the project in view, never in one the search hides', () => {
    projectState.projects = [
      { id: 'agent-skills', name: 'Agent Skills', root_path: '/srv/skills' },
      ...projectState.projects,
    ]
    const { onStart } = renderDialog('aico')
    expect(
      screen.getByRole('button', { name: 'Start Claude Code in Aico' }),
    ).toBeEnabled()

    fireEvent.change(
      screen.getByRole('searchbox', { name: 'Find a project' }),
      { target: { value: 'ner' } },
    )
    const start = screen.getByRole('button', { name: 'Pick a project' })
    expect(start).toBeDisabled()
    expect(screen.queryByRole('button', { name: /in Aico/ })).toBeNull()
    expect(onStart).not.toHaveBeenCalled()
  })

  it('starts in the last project started when none is in view', () => {
    const { onStart } = renderDialog()
    fireEvent.click(screen.getByRole('radio', { name: /Neri/ }))
    fireEvent.click(screen.getByRole('button', { name: /Start .* in Neri/ }))
    expect(onStart).toHaveBeenCalledOnce()
    cleanup()

    renderDialog()
    expect(screen.getByRole('radio', { name: /Neri/ })).toHaveAttribute(
      'aria-checked',
      'true',
    )
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

  it('has no New chat button: a chat starts from its own place', () => {
    renderDialog()
    expect(screen.queryByRole('button', { name: 'New chat' })).toBeNull()
  })

  it('starts with the name the owner typed, trimmed, and without one when blank', () => {
    const { onStart } = renderDialog('neri')
    fireEvent.change(screen.getByTestId('new-session-name'), {
      target: { value: '  Fix login  ' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: 'Start Claude Code in Neri' }),
    )
    expect(onStart).toHaveBeenCalledWith(
      'neri',
      '/srv/neri',
      'claude-code',
      undefined,
      'Fix login',
    )
  })

  it('preselects the agent last started on this device and says so', () => {
    localStorage.setItem('aico:new-session-agent', JSON.stringify('codex'))
    const { onStart } = renderDialog('neri')
    expect(screen.getByTestId('last-used-agent')).toHaveTextContent(
      'Codex was the last one you used.',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Start Codex in Neri' }))
    expect(onStart).toHaveBeenCalledWith('neri', '/srv/neri', 'codex')
    expect(
      JSON.parse(localStorage.getItem('aico:new-session-agent') ?? ''),
    ).toBe('codex')
  })

  it('without a remembered agent, follows the newest session, then the registry default', () => {
    render(
      <NewSessionDialog
        isOpen
        onClose={vi.fn()}
        onStart={vi.fn()}
        recentAgentSlug="codex"
      />,
    )
    expect(
      screen.getByRole('button', { name: /^Start Codex in/ }),
    ).toBeInTheDocument()
    cleanup()
    renderDialog()
    expect(
      screen.getByRole('button', { name: /^Start Claude Code in/ }),
    ).toBeInTheDocument()
    expect(screen.queryByTestId('last-used-agent')).toBeNull()
  })

  it('passes a remembered or default agent with no plan, until it is picked', () => {
    usage.report = {
      providers: [
        {
          id: 'claude',
          name: 'Claude',
          status: 'no_plan',
          answer: 'No plan since Nov 8, 2:20 PM EST',
          windows: [],
          credits: null,
          plan: null,
          problem: null,
        },
      ],
    }
    renderDialog()
    expect(
      screen.getByRole('button', { name: /^Start Codex in/ }),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Claude Code/ }))
    expect(
      screen.getByRole('button', { name: /^Start Claude Code in/ }),
    ).toBeInTheDocument()
    usage.report = null
  })

  it('remembers the agent that was started', () => {
    renderDialog('neri')
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }))
    fireEvent.click(screen.getByRole('button', { name: 'Start Codex in Neri' }))
    expect(
      JSON.parse(localStorage.getItem('aico:new-session-agent') ?? ''),
    ).toBe('codex')
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
