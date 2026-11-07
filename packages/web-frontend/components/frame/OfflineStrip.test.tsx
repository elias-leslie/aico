import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  markAnswered,
  markFailed,
  resetServerReachForTest,
} from '@/lib/frame/server-reach'
import { OfflineStrip } from './OfflineStrip'

const refetch = vi.hoisted(() => vi.fn())
vi.mock('@tanstack/react-query', async (real) => ({
  ...(await real<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => ({ refetchQueries: refetch }),
}))

afterEach(() => {
  resetServerReachForTest()
  vi.clearAllMocks()
})

describe('OfflineStrip', () => {
  it('shows nothing while the server answers', () => {
    const { container } = render(<OfflineStrip />)
    expect(container).toBeEmptyDOMElement()
  })

  it('says since when, keeps what it last knew, and Retry refetches what is on screen', () => {
    render(<OfflineStrip />)
    act(() => {
      const today = new Date()
      today.setHours(15, 4, 0, 0)
      markAnswered(today.getTime())
      markFailed()
    })
    expect(screen.getByTestId('offline-strip')).toHaveTextContent(
      /Can’t reach Aico since 3:04\s?PM\. Showing what it last knew\./,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(refetch).toHaveBeenCalledWith({ type: 'active' })
    act(() => markAnswered())
    expect(screen.queryByTestId('offline-strip')).toBeNull()
  })

  it('with nothing from it yet, says there is nothing to show', () => {
    render(<OfflineStrip />)
    act(() => markFailed(Date.now()))
    expect(screen.getByTestId('offline-strip')).toHaveTextContent(
      /Nothing to show yet; sessions come back once it answers\./,
    )
  })
})
