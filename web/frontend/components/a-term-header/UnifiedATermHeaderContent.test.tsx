import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdHocSlot, PaneSlot } from '@/lib/utils/slot'
import { SLOT_BASE } from '@/test-stubs/session-fixtures'
import { UnifiedATermHeaderContent } from './UnifiedATermHeaderContent'

const { renamePane, updateSession } = vi.hoisted(() => ({
  renamePane: vi.fn(),
  updateSession: vi.fn(),
}))

vi.mock('@/lib/hooks/use-agent-tools', () => ({
  useAgentTools: () => ({ enabledTools: [], agentTools: [] }),
}))

vi.mock('@/lib/hooks/use-a-term-panes', () => ({
  useATermPanes: () => ({ renamePane }),
}))

vi.mock('@/lib/hooks/use-a-term-sessions', () => ({
  useATermSessions: () => ({ update: updateSession }),
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

vi.mock('./PaneStatusBadge', () => ({
  PaneStatusBadge: () => null,
  shouldShowPaneStatus: () => false,
}))

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
    sessionBadge: null,
  }
}

describe('UnifiedATermHeaderContent', () => {
  beforeEach(() => vi.clearAllMocks())

  it.each([false, true])(
    'routes a rename by the backend rename flag: can.rename=%s',
    (canRename) => {
      const base = makeProjectSlot('a', 'Alpha · Focus')
      const slot = { ...base, can: { ...base.can, rename: canRename } }
      render(<UnifiedATermHeaderContent slot={slot} onCloseSession={vi.fn()} />)
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
      <UnifiedATermHeaderContent
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
    render(<UnifiedATermHeaderContent slot={slot} onCloseSession={vi.fn()} />)
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
    render(<UnifiedATermHeaderContent slot={slot} onCloseSession={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(updateSession).not.toHaveBeenCalled()
    expect(renamePane).not.toHaveBeenCalled()
  })

  it('renders the pane actions menu when close session is the only available action', () => {
    render(
      <UnifiedATermHeaderContent
        slot={makeProjectSlot('a', 'Alpha')}
        onCloseSession={vi.fn()}
      />,
    )

    expect(screen.getByTestId('pane-overflow-menu')).toBeInTheDocument()
  })

  it('renders search control directly in the header when search is available', () => {
    render(
      <UnifiedATermHeaderContent
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
      <UnifiedATermHeaderContent
        slot={makeProjectSlot('a', 'Alpha')}
        onFiles={onFiles}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Files' }))

    expect(onFiles).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])(
    'opens the session list from the title (phone: %s)',
    (isMobile) => {
      const slotA = makeProjectSlot('a', 'Alpha')
      const slotB = makeProjectSlot('b', 'Beta')
      const onSwitchTo = vi.fn()

      render(
        <UnifiedATermHeaderContent
          slot={slotA}
          allSlots={[slotA, slotB]}
          onSwitchTo={onSwitchTo}
          isMobile={isMobile}
        />,
      )

      fireEvent.click(screen.getByTestId('session-switcher'))
      fireEvent.click(screen.getByRole('button', { name: /beta/i }))
      expect(onSwitchTo).toHaveBeenCalledWith(slotB)
    },
  )

  it('offers New session from the bar', () => {
    const onOpenModal = vi.fn()
    render(
      <UnifiedATermHeaderContent
        slot={makeProjectSlot('a', 'Alpha')}
        onOpenModal={onOpenModal}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'New session' }))
    expect(onOpenModal).toHaveBeenCalledTimes(1)
  })

  it('offers Compose only where the compose box can be hidden, showing its state', () => {
    const onToggleCompose = vi.fn()
    const { rerender } = render(
      <UnifiedATermHeaderContent slot={makeProjectSlot('a', 'Alpha')} />,
    )
    expect(screen.queryByRole('button', { name: 'Compose' })).toBeNull()

    rerender(
      <UnifiedATermHeaderContent
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
