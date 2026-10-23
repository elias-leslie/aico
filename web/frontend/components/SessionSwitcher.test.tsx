import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Attention } from '@/lib/attention'
import type { PaneSlot } from '@/lib/utils/slot'
import { SLOT_BASE } from '@/test-stubs/session-fixtures'
import { SessionSwitcher } from './SessionSwitcher'

function makeProjectSlot(id: string, name: string): PaneSlot {
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

describe('SessionSwitcher', () => {
  it('switches sessions from the phone sheet', () => {
    const slotA = makeProjectSlot('a', 'Alpha')
    const slotB = makeProjectSlot('b', 'Beta')
    const onSwitchTo = vi.fn()

    render(
      <SessionSwitcher
        currentSlot={slotA}
        allSlots={[slotA, slotB]}
        onSwitchTo={onSwitchTo}
        isMobile={true}
      />,
    )

    fireEvent.click(screen.getByTestId('session-switcher'))
    expect(screen.getByTestId('session-sheet')).toBeInTheDocument()
    expect(screen.getByText('Alpha [shell]')).toBeInTheDocument()
    const scrollRegion = screen.getByTestId('session-list')
    expect(scrollRegion.className).toContain('overflow-y-auto')
    expect(scrollRegion.getAttribute('style')).toContain(
      '-webkit-overflow-scrolling: touch',
    )
    fireEvent.click(screen.getByRole('button', { name: /beta \[shell\]/i }))

    expect(onSwitchTo).toHaveBeenCalledWith(slotB)
  })

  it('numbers duplicate session labels', () => {
    const slotA = makeProjectSlot('a', 'Alpha')
    const slotB = makeProjectSlot('b', 'Alpha')

    render(
      <SessionSwitcher
        currentSlot={slotA}
        allSlots={[slotA, slotB]}
        onSwitchTo={vi.fn()}
        isMobile={true}
      />,
    )

    fireEvent.click(screen.getByTestId('session-switcher'))

    expect(screen.getByText('Alpha [shell]')).toBeInTheDocument()
    expect(screen.getByText('Alpha [shell] #2')).toBeInTheDocument()
  })
})

describe('SessionSwitcher attention', () => {
  it('shows a phone header badge as a colour dot so the title keeps the width', () => {
    const lane = {
      ...makeProjectSlot('a', 'Tether — Badge check lane'),
      badge: { label: '↳ Badge check lead', color: '#f0a35e' },
    } as PaneSlot
    render(
      <SessionSwitcher
        currentSlot={lane}
        allSlots={[lane, makeProjectSlot('b', 'Beta')]}
        onSwitchTo={vi.fn()}
        isMobile
      />,
    )
    const trigger = screen.getByTestId('session-switcher')
    const dot = trigger.querySelector('[data-testid="coordinator-badge"]')
    expect(dot?.getAttribute('data-variant')).toBe('dot')
    expect(dot?.textContent).toBe('')
    expect(trigger.getAttribute('aria-label')).toContain('(↳ Badge check lead)')
    // The sheet keeps the worded chip.
    fireEvent.click(trigger)
    const sheet = screen.getByTestId('session-sheet')
    expect(sheet.textContent).toContain('↳ Badge check lead')
  })

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
      <SessionSwitcher
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
    fireEvent.click(screen.getByTestId('session-switcher'))
    const sheet = screen.getByTestId('session-sheet')
    expect(
      [...sheet.querySelectorAll('[data-testid="session-group-header"]')].map(
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

  it('opens the same grouped list as a menu on a desktop', () => {
    const slotA = makeProjectSlot('a', 'Alpha')
    const slotB = makeProjectSlot('b', 'Beta')
    const onSwitchTo = vi.fn()
    render(
      <SessionSwitcher
        currentSlot={slotA}
        allSlots={[slotA, slotB]}
        onSwitchTo={onSwitchTo}
      />,
    )

    fireEvent.click(screen.getByTestId('session-switcher'))
    expect(screen.queryByTestId('session-sheet')).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Sessions' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /beta \[shell\]/i }))

    expect(onSwitchTo).toHaveBeenCalledWith(slotB)
    expect(screen.queryByRole('dialog', { name: 'Sessions' })).toBeNull()
  })
})
