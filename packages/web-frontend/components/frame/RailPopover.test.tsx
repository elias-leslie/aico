import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RailPopover } from './RailPopover'

function Rail() {
  return (
    <div>
      <input aria-label="Terminal" />
      <RailPopover
        label="Status: 9 problems"
        panelLabel="Status"
        className="lantern-icon-btn"
        icon="S"
      >
        <button type="button">First</button>
        <button type="button">Last</button>
      </RailPopover>
    </div>
  )
}

const icon = () => screen.getByRole('button', { name: 'Status: 9 problems' })

afterEach(() => vi.restoreAllMocks())

describe('RailPopover', () => {
  it('is a dialog button that stays shut on hover and opens on click', () => {
    render(<Rail />)
    expect(icon()).toHaveAttribute('aria-haspopup', 'dialog')
    expect(icon()).toHaveAttribute('aria-expanded', 'false')
    fireEvent.mouseEnter(icon())
    fireEvent.mouseOver(icon())
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(icon())
    expect(screen.getByRole('dialog', { name: 'Status' })).toBeVisible()
    expect(icon()).toHaveAttribute('aria-expanded', 'true')
  })

  it('moves focus inside when it opens', () => {
    render(<Rail />)
    fireEvent.click(icon())
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(
      true,
    )
  })

  it('closes on Esc, returns focus to the icon and keeps Esc from the session', () => {
    const heard = vi.fn()
    window.addEventListener('keydown', heard)
    render(<Rail />)
    fireEvent.click(icon())
    fireEvent.keyDown(screen.getByRole('button', { name: 'First' }), {
      key: 'Escape',
    })
    window.removeEventListener('keydown', heard)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(icon()).toHaveFocus()
    expect(heard).not.toHaveBeenCalled()
  })

  it('closes on a press outside and gives focus back to the icon', () => {
    render(<Rail />)
    fireEvent.click(icon())
    fireEvent.pointerDown(screen.getByLabelText('Terminal'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(icon()).toHaveFocus()
  })

  it('keeps Tab inside, wrapping at both ends', () => {
    render(<Rail />)
    fireEvent.click(icon())
    const first = screen.getByRole('button', { name: 'First' })
    const last = screen.getByRole('button', { name: 'Last' })
    // jsdom has no layout, so every element counts as laid out.
    for (const element of [first, last])
      Object.defineProperty(element, 'offsetParent', {
        get: () => document.body,
      })
    last.focus()
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(first).toHaveFocus()
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    expect(last).toHaveFocus()
  })

  it('shows the hint under the content', () => {
    render(<Rail />)
    fireEvent.click(icon())
    expect(screen.getByText('Esc closes')).toBeVisible()
  })
})
