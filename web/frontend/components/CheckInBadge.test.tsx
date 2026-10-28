import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CheckInBadge } from './CheckInBadge'

// Year 2100: a check-in still ahead.
const FUTURE = 4_102_444_800_000

describe('CheckInBadge', () => {
  it('shows nothing without check-ins', () => {
    const { container } = render(<CheckInBadge checkIns={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the next check-in time', () => {
    render(
      <CheckInBadge
        checkIns={[
          { id: 'b', due_at: FUTURE + 2_000, time: 'Tue 9:00 AM' },
          { id: 'a', due_at: FUTURE + 1_000, time: '5:30 PM' },
        ]}
      />,
    )
    const chip = screen.getByTestId('check-in-badge')
    expect(chip).toHaveTextContent('Check-in 5:30 PM')
    expect(chip).toHaveTextContent('+1')
    expect(chip).toHaveAttribute(
      'aria-label',
      'Check-ins at 5:30 PM, Tue 9:00 AM',
    )
  })

  it('says a due check-in is waiting, with why in the tooltip', () => {
    const past = Date.now() - 60_000
    render(
      <CheckInBadge
        checkIns={[
          { id: 'b', due_at: Date.now() + 3_600_000, time: '5:30 PM' },
          { id: 'a', due_at: past, time: '2:27 PM' },
        ]}
      />,
    )
    const chip = screen.getByTestId('check-in-badge')
    expect(chip).toHaveTextContent('Check-in waiting since 2:27 PM')
    expect(chip).toHaveAttribute(
      'aria-label',
      'Check-ins waiting since 2:27 PM, 5:30 PM',
    )
    expect(chip.title).toMatch(/goes in once the session is idle/)
  })

  it('reads as one check-in when there is one', () => {
    render(
      <CheckInBadge
        checkIns={[{ id: 'a', due_at: FUTURE, time: '5:30 PM' }]}
      />,
    )
    expect(
      screen.getByRole('img', { name: 'Check-in 5:30 PM' }),
    ).toBeInTheDocument()
  })
})
