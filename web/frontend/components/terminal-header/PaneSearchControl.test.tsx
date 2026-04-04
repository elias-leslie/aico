import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PaneSearchControl } from './PaneSearchControl'

describe('PaneSearchControl', () => {
  it('opens inline search and runs a reset search on input changes', () => {
    const onSearch = vi.fn().mockReturnValue({
      query: 'alpha',
      totalMatches: 3,
      activeIndex: 0,
      found: true,
    })

    render(
      <PaneSearchControl
        onSearch={onSearch}
        onClearSearch={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByTitle('Search pane output'))
    fireEvent.change(screen.getByTestId('pane-search-input'), {
      target: { value: 'alpha' },
    })

    expect(onSearch).toHaveBeenCalledWith('alpha', {
      direction: 'next',
      reset: true,
    })
    expect(screen.getByText('1/3')).toBeInTheDocument()
  })

  it('navigates between matches and clears when closed', () => {
    const onSearch = vi
      .fn()
      .mockReturnValueOnce({
        query: 'alpha',
        totalMatches: 3,
        activeIndex: 0,
        found: true,
      })
      .mockReturnValueOnce({
        query: 'alpha',
        totalMatches: 3,
        activeIndex: 1,
        found: true,
      })
    const onClearSearch = vi.fn()

    render(
      <PaneSearchControl
        onSearch={onSearch}
        onClearSearch={onClearSearch}
      />,
    )

    fireEvent.click(screen.getByTitle('Search pane output'))
    fireEvent.change(screen.getByTestId('pane-search-input'), {
      target: { value: 'alpha' },
    })
    fireEvent.click(screen.getByTitle('Next match'))
    fireEvent.click(screen.getByTitle('Close search'))

    expect(onSearch).toHaveBeenLastCalledWith('alpha', {
      direction: 'next',
      reset: false,
    })
    expect(onClearSearch).toHaveBeenCalledTimes(1)
  })
})
