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

    // A hold whose release made no click doesn't eat a keyboard's later one.
    pointer(name, 'pointerdown')
    act(() => vi.advanceTimersByTime(500))
    pointer(name, 'pointerup')
    act(() => vi.advanceTimersByTime(500))
    act(() => name.click())
    expect(pressed).toHaveBeenCalledTimes(2)
  })

  it('leaves the session’s keys alone, and plain text its selection menu', () => {
    const pressed = vi.fn()
    render(
      <>
        <TouchTips />
        <button
          type="button"
          title="Enter"
          data-no-touch-tip
          onClick={pressed}
          data-testid="key"
        />
        <span title="Whole name" data-testid="text">
          Whole…
        </span>
        <button type="button" title="Run" data-testid="control" />
      </>,
    )
    const key = screen.getByTestId('key')
    pointer(key, 'pointerdown')
    act(() => vi.advanceTimersByTime(500))
    pointer(key, 'pointerup')
    expect(tip()).toBeNull()
    act(() => key.click())
    expect(pressed).toHaveBeenCalledTimes(1)

    const menuOn = (target: Element) => {
      const event = new Event('contextmenu', {
        bubbles: true,
        cancelable: true,
      })
      target.dispatchEvent(event)
      return event.defaultPrevented
    }
    const text = screen.getByTestId('text')
    pointer(text, 'pointerdown')
    act(() => vi.advanceTimersByTime(500))
    expect(menuOn(text)).toBe(false)
    const control = screen.getByTestId('control')
    pointer(control, 'pointerdown')
    act(() => vi.advanceTimersByTime(500))
    expect(menuOn(control)).toBe(true)
  })

  it('closes when the page behind it scrolls or focus leaves, not for a scroll elsewhere', () => {
    render(
      <>
        <TouchTips />
        <div data-testid="around">
          <span title="Tip" data-testid="badge">
            dot
          </span>
        </div>
        <div data-testid="elsewhere" />
      </>,
    )
    const badge = screen.getByTestId('badge')
    const scroll = (target: Element) =>
      act(() => {
        target.dispatchEvent(new Event('scroll'))
      })
    tap(badge)
    scroll(screen.getByTestId('elsewhere'))
    expect(tip()).not.toBeNull()
    scroll(screen.getByTestId('around'))
    expect(tip()).toBeNull()
    tap(badge)
    act(() => {
      window.dispatchEvent(new Event('blur'))
    })
    expect(tip()).toBeNull()
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
