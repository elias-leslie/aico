import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PaneOverflowMenu } from './PaneOverflowMenu'

describe('PaneOverflowMenu', () => {
  it('lists the session actions with End session last', () => {
    render(
      <PaneOverflowMenu
        onCloseSession={vi.fn()}
        onRename={vi.fn()}
        onRefresh={vi.fn()}
        onReset={vi.fn()}
        onUpload={vi.fn()}
        fontSize={14}
        onFontSizeChange={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Session menu' }))

    expect(
      screen.getAllByRole('menuitem').map((item) => item.textContent),
    ).toEqual([
      'Upload a file',
      'Rename',
      'Reset session',
      'Redraw',
      'End session',
    ])
    expect(screen.getByRole('group', { name: 'Text size' })).toHaveTextContent(
      '14',
    )
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
    fireEvent.click(screen.getByRole('menuitem', { name: 'Upload a file' }))

    expect(onUpload).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('steps the text size and stops at the ends', () => {
    const onFontSizeChange = vi.fn()
    const { rerender } = render(
      <PaneOverflowMenu fontSize={14} onFontSizeChange={onFontSizeChange} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Session menu' }))
    fireEvent.click(screen.getByRole('button', { name: 'Larger text' }))
    expect(onFontSizeChange).toHaveBeenLastCalledWith(15)
    fireEvent.click(screen.getByRole('button', { name: 'Smaller text' }))
    expect(onFontSizeChange).toHaveBeenLastCalledWith(13)

    rerender(
      <PaneOverflowMenu fontSize={10} onFontSizeChange={onFontSizeChange} />,
    )
    expect(screen.getByRole('button', { name: 'Smaller text' })).toBeDisabled()
    // The menu stays open while the size changes.
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })
})
