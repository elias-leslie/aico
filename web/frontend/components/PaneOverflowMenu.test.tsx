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

    const detachItem = screen.getByRole('menuitem', { name: 'Detach Pane' })
    const closePaneItem = screen.getByRole('menuitem', { name: 'Close Pane' })
    const closeItem = screen.getByRole('menuitem', { name: 'Close Session' })

    expect(detachItem.getAttribute('title')).toBe(
      'Detach pane: open this pane in its own window.',
    )
    expect(closePaneItem.getAttribute('title')).toBe(
      'Close pane: remove it from this layout but keep the session running.',
    )
    expect(closeItem.getAttribute('title')).toBe(
      'Close session: terminate the underlying tmux session.',
    )

    expect(
      screen.getByRole('menuitem', { name: 'Reset A-Term' }),
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
    fireEvent.click(screen.getByRole('menuitem', { name: 'Detach Pane' }))

    expect(onDetach).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('invokes the close-pane action and closes the menu', () => {
    const onClosePane = vi.fn()

    render(<PaneOverflowMenu onClosePane={onClosePane} />)

    fireEvent.click(screen.getByRole('button', { name: 'Pane actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close Pane' }))

    expect(onClosePane).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})
