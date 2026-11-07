import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdHocSlot, PaneSlot } from '@/lib/utils/slot'
import { SLOT_BASE } from '@/test-stubs/session-fixtures'
import { UnifiedTerminalHeaderContent } from './UnifiedTerminalHeaderContent'

const { renamePane, updateSession } = vi.hoisted(() => ({
  renamePane: vi.fn(),
  updateSession: vi.fn(),
}))

vi.mock('@/lib/frame/live', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/frame/live')>()),
  useLiveSessions: () => ({
    items: [],
    bySession: new Map(),
    conversations: new Set(),
    failed: false,
    stale: false,
  }),
}))
vi.mock('../frame/SideEdgeButton', () => ({
  SideEdgeButton: () => <i data-testid="side-edge-mock" />,
}))
vi.mock('../KeptCheckIns', () => ({ KeptCheckIns: () => null }))
vi.mock('@/lib/hooks/use-agent-tools', () => ({
  useAgentTools: () => ({ enabledTools: [], agentTools: [] }),
}))

vi.mock('@/lib/hooks/use-terminal-panes', () => ({
  useTerminalPanes: () => ({ renamePane }),
}))

vi.mock('@/lib/hooks/use-terminal-sessions', () => ({
  useTerminalSessions: () => ({ update: updateSession }),
}))

vi.mock('../ModeToggle', () => ({
  ModeToggle: () => null,
}))

vi.mock('../PaneOverflowMenu', () => ({
  PaneOverflowMenu: ({ onRename }: { onRename?: () => void }) => (
    <div data-testid="pane-overflow-menu">
      <button type="button" onClick={onRename}>
        Rename
      </button>
    </div>
  ),
}))

vi.mock('./HeaderIconButton', () => ({
  HeaderIconButton: ({
    tooltip,
    onClick,
  }: {
    tooltip: string
    onClick: () => void
  }) => (
    <button type="button" onClick={onClick}>
      {tooltip}
    </button>
  ),
}))

vi.mock('./ContextFillBadge', () => ({ ContextFillBadge: () => null }))

vi.mock('./PaneStatusBadge', () => ({
  PaneStatusBadge: ({ status }: { status?: string }) => (
    <i data-testid="status-mock">{status}</i>
  ),
}))

const frameState = vi.hoisted(() => ({
  value: null as { docked: boolean; tier: string } | null,
}))
vi.mock('../frame/FrameContext', () => ({ useFrame: () => frameState.value }))

vi.mock('./PaneSearchControl', () => ({
  PaneSearchControl: () => <div data-testid="pane-search-control" />,
}))

function makeProjectSlot(
  id: string,
  name: string,
): Extract<PaneSlot, { type: 'project' }> {
  return {
    type: 'project',
    ...SLOT_BASE,
    paneId: id,
    projectId: `${id}-project`,
    projectName: name,
    rootPath: `/workspace/${id}`,
    activeMode: 'shell',
    activeSessionId: `${id}-session`,
  }
}

describe('UnifiedTerminalHeaderContent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    frameState.value = null
  })

  it.each([false, true])(
    'routes a rename by the backend rename flag: can.rename=%s',
    (canRename) => {
      const base = makeProjectSlot('a', 'Alpha · Focus')
      const slot = { ...base, can: { ...base.can, rename: canRename } }
      render(
        <UnifiedTerminalHeaderContent slot={slot} onCloseSession={vi.fn()} />,
      )
      fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
      const input = screen.getByRole('textbox')
      fireEvent.change(input, { target: { value: 'Alpha · Next focus' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      if (canRename) {
        expect(updateSession).toHaveBeenCalledWith('a-session', {
          name: 'Alpha · Next focus',
        })
        expect(renamePane).not.toHaveBeenCalled()
      } else {
        expect(renamePane).toHaveBeenCalledWith('a', 'Alpha · Next focus')
        expect(updateSession).not.toHaveBeenCalled()
      }
    },
  )

  it('shows a lane title and chip', () => {
    render(
      <UnifiedTerminalHeaderContent
        slot={{
          ...makeProjectSlot('a', 'Alpha — Focus'),
          can: { rename: true, reset: true, end: true },
          showsSessionTitle: true,
          task: 'Focus',
          badge: { label: '↳ Lead', color: '#6fa8ff' },
        }}
      />,
    )
    expect(screen.getByText('Focus')).toBeInTheDocument()
    expect(screen.getByTestId('coordinator-badge')).toHaveTextContent('↳ Lead')
  })

  it('renames a free-standing View in Tether when the backend allows it', () => {
    const slot: AdHocSlot = {
      type: 'adhoc',
      sessionId: 'free-session',
      name: 'Alpha — Focus',
      workingDir: '/workspace/a',
      isExternal: true,
      task: 'Focus',
      can: { rename: true, reset: false, end: true },
      showsSessionTitle: true,
    }
    render(
      <UnifiedTerminalHeaderContent slot={slot} onCloseSession={vi.fn()} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    const input = screen.getByRole('textbox')
    expect(input).toHaveValue('Focus')
    fireEvent.change(input, { target: { value: 'Next focus' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(updateSession).toHaveBeenCalledWith('free-session', {
      name: 'Next focus',
    })
    expect(renamePane).not.toHaveBeenCalled()
  })

  it('offers no rename on a free-standing View the backend will not rename', () => {
    const slot: AdHocSlot = {
      type: 'adhoc',
      sessionId: 'own-tmux',
      name: 'codex-agent-hub',
      workingDir: '/workspace/a',
      isExternal: true,
      can: { rename: false, reset: false, end: false },
      showsSessionTitle: false,
    }
    render(
      <UnifiedTerminalHeaderContent slot={slot} onCloseSession={vi.fn()} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(updateSession).not.toHaveBeenCalled()
    expect(renamePane).not.toHaveBeenCalled()
  })

  it('renders the pane actions menu when close session is the only available action', () => {
    render(
      <UnifiedTerminalHeaderContent
        slot={makeProjectSlot('a', 'Alpha')}
        onCloseSession={vi.fn()}
      />,
    )

    expect(screen.getByTestId('pane-overflow-menu')).toBeInTheDocument()
  })

  it('renders search control directly in the header when search is available', () => {
    render(
      <UnifiedTerminalHeaderContent
        slot={makeProjectSlot('a', 'Alpha')}
        onSearch={() => ({
          query: 'alpha',
          totalMatches: 1,
          activeIndex: 0,
          found: true,
        })}
        onClearSearch={vi.fn()}
      />,
    )

    expect(screen.getByTestId('pane-search-control')).toBeInTheDocument()
  })

  it('renders a direct files action in the header when files are available', () => {
    const onFiles = vi.fn()

    render(
      <UnifiedTerminalHeaderContent
        slot={makeProjectSlot('a', 'Alpha')}
        onFiles={onFiles}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Files' }))

    expect(onFiles).toHaveBeenCalledTimes(1)
  })

  it('labels the files action Files on desktop, with a tooltip', () => {
    render(
      <UnifiedTerminalHeaderContent
        slot={makeProjectSlot('a', 'Alpha')}
        onFiles={vi.fn()}
      />,
    )
    const button = screen.getByRole('button', { name: 'Files' })
    expect(button).toHaveTextContent('Files')
    expect(button).toHaveAttribute('title')
  })

  it('shows the connection beside the tool switcher', () => {
    render(
      <UnifiedTerminalHeaderContent
        slot={makeProjectSlot('a', 'Alpha')}
        connectionStatus="connecting"
      />,
    )
    expect(screen.getByTestId('status-mock')).toHaveTextContent('connecting')
  })

  it.each([
    ['panel', true, true],
    ['rail', true, false],
    ['panel', false, false],
  ])(
    'hides the title only where the list shows its row (%s, docked %s)',
    (tier, docked, hidden) => {
      frameState.value = { docked, tier }
      render(
        <UnifiedTerminalHeaderContent slot={makeProjectSlot('a', 'Alpha')} />,
      )
      const title = screen.getByText('Alpha').closest('.hidden')
      expect(title !== null).toBe(hidden)
    },
  )

  it('shows the title when there is no frame around the bar', () => {
    render(
      <UnifiedTerminalHeaderContent slot={makeProjectSlot('a', 'Alpha')} />,
    )
    expect(screen.getByText('Alpha').closest('.hidden')).toBeNull()
  })

  it('offers Compose only where the compose box can be hidden, showing its state', () => {
    const onToggleCompose = vi.fn()
    const { rerender } = render(
      <UnifiedTerminalHeaderContent slot={makeProjectSlot('a', 'Alpha')} />,
    )
    expect(screen.queryByRole('button', { name: 'Compose' })).toBeNull()

    rerender(
      <UnifiedTerminalHeaderContent
        slot={makeProjectSlot('a', 'Alpha')}
        composeOpen
        onToggleCompose={onToggleCompose}
      />,
    )
    const compose = screen.getByRole('button', { name: 'Compose' })
    expect(compose).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(compose)
    expect(onToggleCompose).toHaveBeenCalledTimes(1)
  })
})
