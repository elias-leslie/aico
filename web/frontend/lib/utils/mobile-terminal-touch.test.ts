import { describe, expect, it } from 'vitest'
import {
  applyMobileTerminalTouchStyles,
  getMobileTerminalTouchStyles,
  MOBILE_TERMINAL_VIEWPORT_CLASS,
} from './mobile-terminal-touch'

describe('getMobileTerminalTouchStyles', () => {
  it('disables native touch gestures so JS handles scrolling', () => {
    expect(getMobileTerminalTouchStyles()).toEqual({
      overscrollBehavior: 'none',
      touchAction: 'none',
    })
  })

})

describe('applyMobileTerminalTouchStyles', () => {
  it('applies touch-safe scrolling styles to the xterm touch surfaces', () => {
    const container = document.createElement('div')
    const screen = document.createElement('div')
    const viewport = document.createElement('div')

    screen.className = 'xterm-screen'
    viewport.className = 'xterm-viewport'
    container.append(screen, viewport)

    applyMobileTerminalTouchStyles(container)

    expect(container.style.overscrollBehavior).toBe('none')
    expect(container.style.touchAction).toBe('none')
    expect(screen.style.overscrollBehavior).toBe('none')
    expect(screen.style.touchAction).toBe('none')
    expect(viewport.style.overscrollBehavior).toBe('none')
    expect(viewport.style.touchAction).toBe('none')
    expect(
      viewport.style.getPropertyValue('-webkit-overflow-scrolling'),
    ).toBe('touch')
    expect(
      viewport.classList.contains(MOBILE_TERMINAL_VIEWPORT_CLASS),
    ).toBe(true)
  })
})
