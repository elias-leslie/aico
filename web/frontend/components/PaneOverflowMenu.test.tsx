import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PaneOverflowMenu } from './PaneOverflowMenu'

describe('PaneOverflowMenu', () => {
  it('shows consolidated pane actions with detach and close explanations', () => {
    render(
      <PaneOverflowMenu
        onDetach={vi.fn()}
        onClosePane={vi.fn()}
        onCloseSession={vi.fn()}
        onRefresh={vi.fn()}
        onReset={vi.fn()}
        onSettings={vi.fn()}
        onUpload={vi.fn()}
        onVoice={vi.fn()}
        onClean={vi.fn()}
        onResetAll={vi.fn()}
        onCloseAll={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Pane actions' }))

    const detachItem = screen.getByRole('menuitem', {
      name: 'Open in new window',
    })
    const closePaneItem = screen.getByRole('menuitem', { name: 'Close view' })
    const closeItem = screen.getByRole('menuitem', { name: 'End session' })

    expect(detachItem.getAttribute('title')).toBe(
      'Open this view in a separate window. The session keeps running.',
    )
    expect(closePaneItem.getAttribute('title')).toBe(
      'Close this view. The session keeps running and can be opened again.',
    )
    expect(closeItem.getAttribute('title')).toBe(
      'End session: stop its process in every view.',
    )

    expect(
      screen.getByRole('menuitem', { name: 'Reset A-Term' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('menuitem', { name: 'Refresh Layout' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('menuitem', { name: 'Clean Prompt' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('menuitem', { name: 'Upload File' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('menuitem', { name: 'Voice Input' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('menuitem', { name: 'Settings' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('menuitem', { name: 'Reset All' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('menuitem', { name: 'Close All' }),
    ).toBeInTheDocument()
  })

  it('invokes the selected action and closes the menu', () => {
    const onUpload = vi.fn()

    render(<PaneOverflowMenu onUpload={onUpload} />)

    fireEvent.click(screen.getByRole('button', { name: 'Pane actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Upload File' }))

    expect(onUpload).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('invokes the detach action and closes the menu', () => {
    const onDetach = vi.fn()

    render(<PaneOverflowMenu onDetach={onDetach} />)

    fireEvent.click(screen.getByRole('button', { name: 'Pane actions' }))
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'Open in new window' }),
    )

    expect(onDetach).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('invokes the close-pane action and closes the menu', () => {
    const onClosePane = vi.fn()

    render(<PaneOverflowMenu onClosePane={onClosePane} />)

    fireEvent.click(screen.getByRole('button', { name: 'Pane actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close view' }))

    expect(onClosePane).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('invokes the refresh action and closes the menu', () => {
    const onRefresh = vi.fn()

    render(<PaneOverflowMenu onRefresh={onRefresh} />)

    fireEvent.click(screen.getByRole('button', { name: 'Pane actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Refresh Layout' }))

    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('shows swap targets and swaps panes from the overflow menu', () => {
    const onSwapWith = vi.fn()

    render(
      <PaneOverflowMenu
        onSwapWith={onSwapWith}
        swapTargets={[
          { id: 'pane-b', label: 'Beta' },
          { id: 'pane-c', label: 'Gamma' },
        ]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Pane actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Swap With Beta' }))

    expect(onSwapWith).toHaveBeenCalledWith('pane-b')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})
