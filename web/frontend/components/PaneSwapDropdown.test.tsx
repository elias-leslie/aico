import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PaneSwapDropdown } from './PaneSwapDropdown'
import type { PaneSlot } from '@/lib/utils/slot'

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
})
