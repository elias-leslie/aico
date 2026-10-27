import { fireEvent, render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { SessionSidebar } from './SessionSidebar'

vi.mock('@/lib/hooks/use-session-attention', () => ({
  useSessionAttention: () => ({ forSlot: () => null, needsYouCount: 2 }),
}))
vi.mock('./SessionList', () => ({
  SessionList: () => <p>Full list</p>,
  SessionRail: () => <p>Rail marks</p>,
  sessionsHeading: () => 'Sessions · 5 · 2 need you',
}))

// jsdom has no PointerEvent; a mouse event carries what the handle reads.
beforeAll(() => {
  window.PointerEvent ??= class extends MouseEvent {} as typeof PointerEvent
})

function open(width = 320) {
  const onWidthChange = vi.fn()
  const onCollapsedChange = vi.fn()
  render(
    <SessionSidebar
      slots={[]}
      onSelect={vi.fn()}
      width={width}
      onWidthChange={onWidthChange}
      onCollapsedChange={onCollapsedChange}
    />,
  )
  return {
    handle: screen.getByRole('separator', { name: 'Resize session list' }),
    onWidthChange,
    onCollapsedChange,
  }
}

describe('SessionSidebar', () => {
  it('folds to a rail that counts who needs you and opens the list again', () => {
    const onCollapsedChange = vi.fn()
    render(
      <SessionSidebar
        slots={[]}
        onSelect={vi.fn()}
        onNewSession={vi.fn()}
        collapsed
        onCollapsedChange={onCollapsedChange}
      />,
    )
    expect(screen.getByText('Rail marks')).toBeVisible()
    expect(screen.queryByText('Full list')).toBeNull()
    expect(screen.queryByRole('separator')).toBeNull()
    expect(screen.getByRole('button', { name: 'New session' })).toBeVisible()
    const expand = screen.getByRole('button', {
      name: 'Show session list · Sessions · 5 · 2 need you',
    })
    expect(expand.textContent).toBe('2')
    fireEvent.click(expand)
    expect(onCollapsedChange).toHaveBeenCalledWith(false)
  })

  it('collapses from its header', () => {
    const { onCollapsedChange } = open()
    expect(screen.getByText('Full list')).toBeVisible()
    fireEvent.click(
      screen.getByRole('button', { name: 'Collapse session list' }),
    )
    expect(onCollapsedChange).toHaveBeenCalledWith(true)
  })

  it('resizes from the keyboard within its limits, and double-click resets', () => {
    const { handle, onWidthChange } = open(552)
    expect(handle.getAttribute('aria-valuenow')).toBe('552')
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(onWidthChange).toHaveBeenLastCalledWith(560)
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(onWidthChange).toHaveBeenLastCalledWith(536)
    fireEvent.keyDown(handle, { key: 'Home' })
    expect(onWidthChange).toHaveBeenLastCalledWith(240)
    fireEvent.doubleClick(handle)
    expect(onWidthChange).toHaveBeenLastCalledWith(320)
  })

  it('follows a drag and keeps the width where it ends', () => {
    const { handle, onWidthChange } = open()
    const aside = screen.getByTestId('session-sidebar')
    fireEvent.pointerDown(handle, { button: 0, clientX: 320 })
    fireEvent.pointerMove(handle, { clientX: 420 })
    expect(aside.style.width).toBe('420px')
    fireEvent.pointerMove(handle, { clientX: 2000 })
    expect(aside.style.width).toBe('560px')
    expect(onWidthChange).not.toHaveBeenCalled()
    fireEvent.pointerUp(handle, { clientX: 2000 })
    expect(onWidthChange).toHaveBeenCalledWith(560)
  })

  it('folds to the rail when dragged nearly shut', () => {
    const { handle, onWidthChange, onCollapsedChange } = open()
    fireEvent.pointerDown(handle, { button: 0, clientX: 320 })
    fireEvent.pointerMove(handle, { clientX: 100 })
    fireEvent.pointerUp(handle, { clientX: 100 })
    expect(onCollapsedChange).toHaveBeenCalledWith(true)
    expect(onWidthChange).not.toHaveBeenCalled()
  })
})
