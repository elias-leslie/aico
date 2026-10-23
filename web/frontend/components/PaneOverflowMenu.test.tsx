import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PaneOverflowMenu } from './PaneOverflowMenu'

describe('PaneOverflowMenu', () => {
  it('lists the session actions', () => {
    render(
      <PaneOverflowMenu
        onCloseSession={vi.fn()}
        onRename={vi.fn()}
        onRefresh={vi.fn()}
        onReset={vi.fn()}
        onSettings={vi.fn()}
        onUpload={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Session menu' }))

    expect(
      screen.getAllByRole('menuitem').map((item) => item.textContent),
    ).toEqual([
      'End session',
      'Rename',
      'Reset session',
      'Redraw',
      'Upload file',
      'Settings',
    ])
    expect(
      screen
        .getByRole('menuitem', { name: 'End session' })
        .getAttribute('title'),
    ).toBe('End session: stop its process everywhere it is open.')
  })

  it('invokes the selected action and closes the menu', () => {
    const onUpload = vi.fn()

    render(<PaneOverflowMenu onUpload={onUpload} />)

    fireEvent.click(screen.getByRole('button', { name: 'Session menu' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Upload file' }))

    expect(onUpload).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})
