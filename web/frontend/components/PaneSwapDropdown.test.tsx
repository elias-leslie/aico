import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { PaneSlot } from '@/lib/utils/slot'
import { PaneSwapDropdown } from './PaneSwapDropdown'

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

describe('PaneSwapDropdown', () => {
  it('swaps panes when another pane is chosen from the dropdown menu', () => {
    const slotA = makeProjectSlot('a', 'Alpha')
    const slotB = makeProjectSlot('b', 'Beta')
    const onSwap = vi.fn()

    render(
      <PaneSwapDropdown
        currentSlot={slotA}
        allSlots={[slotA, slotB]}
        onSwapWith={onSwap}
      />,
    )

    fireEvent.click(screen.getByTestId('pane-swap-dropdown'))
    fireEvent.click(screen.getByRole('button', { name: /beta/i }))

    expect(onSwap).toHaveBeenCalledWith('pane-b')
  })

  it('swaps panes when a pane header is dropped onto another header', () => {
    const slotA = makeProjectSlot('a', 'Alpha')
    const slotB = makeProjectSlot('b', 'Beta')
    const onSwapA = vi.fn()
    const onSwapB = vi.fn()

    render(
      <>
        <PaneSwapDropdown
          currentSlot={slotA}
          allSlots={[slotA, slotB]}
          onSwapWith={onSwapA}
        />
        <PaneSwapDropdown
          currentSlot={slotB}
          allSlots={[slotA, slotB]}
          onSwapWith={onSwapB}
        />
      </>,
    )

    const [buttonA, buttonB] = screen.getAllByTestId('pane-swap-dropdown')
    const dataTransfer = createDataTransfer()

    fireEvent.dragStart(buttonA, { dataTransfer })
    fireEvent.dragOver(buttonB, { dataTransfer })
    fireEvent.drop(buttonB, { dataTransfer })

    expect(onSwapA).not.toHaveBeenCalled()
    expect(onSwapB).toHaveBeenCalledWith('pane-a')
  })

  it('ignores drops from the same pane', () => {
    const slotA = makeProjectSlot('a', 'Alpha')
    const onSwap = vi.fn()

    render(
      <PaneSwapDropdown
        currentSlot={slotA}
        allSlots={[slotA, makeProjectSlot('b', 'Beta')]}
        onSwapWith={onSwap}
      />,
    )

    const button = screen.getByTestId('pane-swap-dropdown')
    const dataTransfer = createDataTransfer()

    fireEvent.dragStart(button, { dataTransfer })
    fireEvent.dragOver(button, { dataTransfer })
    fireEvent.drop(button, { dataTransfer })

    expect(onSwap).not.toHaveBeenCalled()
  })

  it('switches panes on mobile even without desktop swap wiring', () => {
    const slotA = makeProjectSlot('a', 'Alpha')
    const slotB = makeProjectSlot('b', 'Beta')
    const onSwitchTo = vi.fn()

    render(
      <PaneSwapDropdown
        currentSlot={slotA}
        allSlots={[slotA, slotB]}
        onSwitchTo={onSwitchTo}
        isMobile={true}
      />,
    )

    fireEvent.click(screen.getByTestId('pane-swap-dropdown'))
    expect(screen.getByTestId('pane-swap-mobile-sheet')).toBeInTheDocument()
    expect(screen.getByText('Alpha [shell]')).toBeInTheDocument()
    const scrollRegion = screen.getByTestId('pane-swap-mobile-sheet-scroll')
    expect(scrollRegion.className).toContain('overflow-y-auto')
    expect(scrollRegion.getAttribute('style')).toContain(
      '-webkit-overflow-scrolling: touch',
    )
    fireEvent.click(screen.getByRole('button', { name: /beta \[shell\]/i }))

    expect(onSwitchTo).toHaveBeenCalledWith(slotB)
  })

  it('disambiguates duplicate mobile labels', () => {
    const slotA = makeProjectSlot('a', 'Alpha')
    const slotB = makeProjectSlot('b', 'Alpha')

    render(
      <PaneSwapDropdown
        currentSlot={slotA}
        allSlots={[slotA, slotB]}
        onSwitchTo={vi.fn()}
        isMobile={true}
      />,
    )

    fireEvent.click(screen.getByTestId('pane-swap-dropdown'))

    expect(screen.getByText('Alpha [shell]')).toBeInTheDocument()
    expect(screen.getByText('Alpha [shell] #2')).toBeInTheDocument()
  })
})
