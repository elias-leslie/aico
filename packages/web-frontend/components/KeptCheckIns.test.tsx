import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { KeptCheckIns } from './KeptCheckIns'

const state = vi.hoisted(() => ({
  data: [] as Array<{
    id: string
    dueAt: number
    time: string
    session: string
    failed: boolean
  }>,
  cancel: vi.fn(),
}))

vi.mock('@/lib/hooks/use-check-ins', () => ({
  useKeptCheckIns: () => ({ data: state.data }),
  useCheckInActions: () => ({
    cancel: { mutate: state.cancel, isPending: false, error: null },
  }),
}))

describe('KeptCheckIns', () => {
  beforeEach(() => {
    state.cancel.mockReset()
    state.data = []
  })

  it('shows nothing while no check-in is kept', () => {
    const { container } = render(<KeptCheckIns />)
    expect(container).toBeEmptyDOMElement()
  })

  it('lists kept check-ins and cancels one', () => {
    state.data = [
      {
        id: 'aaaaaaaaaaaa',
        dueAt: 1,
        time: 'Tue 9:00 AM',
        session: 'Aico — Fix login',
        failed: false,
      },
      {
        id: 'bbbbbbbbbbbb',
        dueAt: 2,
        time: '5:30 PM',
        session: 'Neri',
        failed: true,
      },
    ]
    render(<KeptCheckIns />)
    expect(screen.getByText('Aico — Fix login')).toBeInTheDocument()
    expect(screen.getByText('Tue 9:00 AM')).toBeInTheDocument()
    expect(
      screen.getByText('5:30 PM · last restart failed'),
    ).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Cancel kept check-in for Aico — Fix login at Tue 9:00 AM',
      }),
    )
    expect(state.cancel).toHaveBeenCalledWith('aaaaaaaaaaaa')
  })
})
