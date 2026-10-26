import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CheckInBadge } from './CheckInBadge'

describe('CheckInBadge', () => {
  it('shows nothing without check-ins', () => {
    const { container } = render(<CheckInBadge checkIns={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the next check-in time', () => {
    render(
      <CheckInBadge
        checkIns={[
          { id: 'b', due_at: 2_000, time: 'Tue 9:00 AM' },
          { id: 'a', due_at: 1_000, time: '5:30 PM' },
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

  it('reads as one check-in when there is one', () => {
    render(
      <CheckInBadge checkIns={[{ id: 'a', due_at: 1, time: '5:30 PM' }]} />,
    )
    expect(
      screen.getByRole('img', { name: 'Check-in 5:30 PM' }),
    ).toBeInTheDocument()
  })
})
