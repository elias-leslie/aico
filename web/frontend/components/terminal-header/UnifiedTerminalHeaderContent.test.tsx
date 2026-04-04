import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { UnifiedTerminalHeaderContent } from './UnifiedTerminalHeaderContent'
import type { PaneSlot } from '@/lib/utils/slot'

vi.mock('@/lib/hooks/use-agent-tools', () => ({
  useAgentTools: () => ({ enabledTools: [] }),
}))

vi.mock('@/lib/hooks/use-terminal-panes', () => ({
  useTerminalPanes: () => ({ renamePane: vi.fn() }),
}))

vi.mock('@/components/LayoutModeButton', () => ({
  LayoutModeButtons: () => null,
}))

vi.mock('../ModeToggle', () => ({
  ModeToggle: () => null,
}))

vi.mock('../PaneOverflowMenu', () => ({
  PaneOverflowMenu: () => <div data-testid="pane-overflow-menu" />,
}))

vi.mock('./AddTerminalButton', () => ({
  AddTerminalButton: () => null,
}))

vi.mock('./HeaderIconButton', () => ({
  HeaderIconButton: () => null,
}))

vi.mock('./PaneStatusBadge', () => ({
  PaneStatusBadge: () => null,
}))

vi.mock('./PaneSearchControl', () => ({
  PaneSearchControl: () => <div data-testid="pane-search-control" />,
}))

function makeProjectSlot(id: string, name: string): PaneSlot {
  return {
    type: 'project',
    paneId: id,
    projectId: `${id}-project`,
    projectName: name,
    rootPath: `/workspace/${id}`,
    activeMode: 'shell',
    activeSessionId: `${id}-session`,
    sessionBadge: null,
  }
}

function createDataTransfer() {
  const data = new Map<string, string>()
  return {
    effectAllowed: 'move',
    dropEffect: 'move',
    setData: (type: string, value: string) => {
      data.set(type, value)
    },
    getData: (type: string) => data.get(type) ?? '',
    clearData: () => data.clear(),
  }
}

describe('UnifiedTerminalHeaderContent', () => {
  it('swaps panes when one header is dropped onto another header', () => {
    const slotA = makeProjectSlot('a', 'Alpha')
    const slotB = makeProjectSlot('b', 'Beta')
    const onSwapA = vi.fn()
    const onSwapB = vi.fn()

    render(
      <>
        <UnifiedTerminalHeaderContent
          slot={slotA}
          allSlots={[slotA, slotB]}
          onSwapWith={onSwapA}
        />
        <UnifiedTerminalHeaderContent
          slot={slotB}
          allSlots={[slotA, slotB]}
          onSwapWith={onSwapB}
        />
      </>,
    )

    const dragHandleA = screen.getByTestId('pane-drag-handle-pane-a')
    const headerB = screen.getByTestId('terminal-header-pane-b')

    const dataTransfer = createDataTransfer()

    fireEvent.dragStart(dragHandleA, { dataTransfer })
    fireEvent.dragOver(headerB, { dataTransfer })
    fireEvent.drop(headerB, { dataTransfer })

    expect(onSwapA).not.toHaveBeenCalled()
    expect(onSwapB).toHaveBeenCalledWith('pane-a')
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
})
