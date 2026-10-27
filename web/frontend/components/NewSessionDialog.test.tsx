import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NewSessionDialog } from './NewSessionDialog'

const projectState = vi.hoisted(() => ({
  projects: [] as Array<{ id: string; name: string; root_path: string | null }>,
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
}))
const tools = [
  { slug: 'claude-code', name: 'Claude Code', color: null },
  { slug: 'codex', name: 'Codex', color: null },
]

vi.mock('@/lib/hooks/use-project-settings', () => ({
  useProjectSettings: () => projectState,
}))
vi.mock('@/lib/hooks/use-agent-tools', () => ({
  useAgentTools: () => ({ enabledTools: tools, defaultTool: tools[0] }),
}))

function renderDialog(defaultProjectId?: string) {
  const onStart = vi.fn()
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
