import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Attention } from '@/lib/attention'
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

describe('PaneSwapDropdown attention', () => {
  it('groups the mobile switcher most-urgent first with badges and a needs-you count', () => {
    const slots = [
      makeProjectSlot('a', 'Alpha'),
      makeProjectSlot('b', 'Beta'),
      makeProjectSlot('c', 'Gamma'),
      makeProjectSlot('d', 'Delta'),
    ]
    const states: Record<string, Attention> = {
      a: { group: 'idle', activity: 'idle', at: 1, detail: 'idle 2h' },
      b: { group: 'working', activity: 'working', at: 5, detail: 'working 4m' },
      c: {
        group: 'needs-you',
        activity: 'blocked',
        at: 9,
        detail: 'waiting 3m',
      },
      d: { group: 'finished', activity: 'idle', at: 8, detail: 'done 1m' },
    }
    const onSwitchTo = vi.fn()
    render(
      <PaneSwapDropdown
        currentSlot={slots[0] as PaneSlot}
        allSlots={slots}
        onSwitchTo={onSwitchTo}
        isMobile
        attention={{
          forSlot: (slot) => states[(slot as PaneSlot).paneId] ?? null,
          needsYouCount: 1,
        }}
      />,
    )
    expect(screen.getByTestId('needs-you-count').textContent).toBe('1')
    fireEvent.click(screen.getByTestId('pane-swap-dropdown'))
    const sheet = screen.getByTestId('pane-swap-mobile-sheet')
    expect(
      [...sheet.querySelectorAll('[data-testid="pane-swap-group-header"]')].map(
        (el) => el.textContent,
      ),
    ).toEqual(['Needs you', 'Finished', 'Working', 'Idle'])
    const rows = [...sheet.querySelectorAll('button[type="button"]')]
      .map((el) => el.textContent ?? '')
      .filter((text) => /Alpha|Beta|Gamma|Delta/.test(text))
    expect(rows).toEqual([
      'Gamma [shell]waiting 3m',
      'Delta [shell]done 1m',
      'Beta [shell]working 4m',
      'Alpha [shell]idle 2hCurrent',
    ])
    fireEvent.click(screen.getByRole('button', { name: /Gamma/ }))
    expect(onSwitchTo).toHaveBeenCalledWith(slots[2])
  })
})
