import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TouchTips } from './TouchTips'

const pointer = (
  target: Element,
  type: string,
  init: { pointerType?: string; x?: number; y?: number } = {},
) => {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(event, {
    pointerType: init.pointerType ?? 'touch',
    clientX: init.x ?? 100,
    clientY: init.y ?? 300,
  })
  act(() => {
    target.dispatchEvent(event)
  })
}
const tap = (target: Element) => {
  pointer(target, 'pointerdown')
  pointer(target, 'pointerup')
}
const tip = () => screen.queryByRole('tooltip')

describe('TouchTips', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('shows a badge’s title on a tap, and closes on the next touch', () => {
    render(
      <>
        <TouchTips />
        <span title="Ready to take over" data-testid="badge">
          dot
        </span>
        <p data-testid="else">else</p>
      </>,
    )
    const badge = screen.getByTestId('badge')
    tap(badge)
    expect(tip()).toHaveTextContent('Ready to take over')
    tap(badge)
    expect(tip()).toBeNull()
    tap(badge)
    expect(tip()).not.toBeNull()
    tap(screen.getByTestId('else'))
    expect(tip()).toBeNull()
  })

  it('lets a tap act on a control, and a hold shows its tip without acting', () => {
    const pressed = vi.fn()
    render(
      <>
        <TouchTips />
        <button type="button" onClick={pressed}>
          <span title="The whole name" data-testid="name">
            The wh…
          </span>
        </button>
      </>,
    )
    const name = screen.getByTestId('name')
    tap(name)
    expect(tip()).toBeNull()
    act(() => name.click())
    expect(pressed).toHaveBeenCalledTimes(1)

    pointer(name, 'pointerdown')
    act(() => vi.advanceTimersByTime(500))
    expect(tip()).toHaveTextContent('The whole name')
    pointer(name, 'pointerup')
    act(() => name.click())
    expect(pressed).toHaveBeenCalledTimes(1)
  })

  it('leaves a scroll, a mouse and a title-less touch alone', () => {
    render(
      <>
        <TouchTips />
        <span title="Tip" data-testid="badge">
          dot
        </span>
      </>,
    )
    const badge = screen.getByTestId('badge')
    pointer(badge, 'pointerdown')
    pointer(badge, 'pointermove', { y: 340 })
    act(() => vi.advanceTimersByTime(500))
    pointer(badge, 'pointerup')
    expect(tip()).toBeNull()

    pointer(badge, 'pointerdown', { pointerType: 'mouse' })
    act(() => vi.advanceTimersByTime(500))
    pointer(badge, 'pointerup', { pointerType: 'mouse' })
    expect(tip()).toBeNull()

    pointer(badge, 'pointerdown')
    pointer(badge, 'pointercancel')
    act(() => vi.advanceTimersByTime(500))
    expect(tip()).toBeNull()
  })
})
