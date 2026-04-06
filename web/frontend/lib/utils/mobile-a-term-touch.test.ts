import { describe, expect, it } from 'vitest'
import {
  applyMobileATermTouchStyles,
  getMobileATermTouchStyles,
  MOBILE_A_TERM_VIEWPORT_CLASS,
} from './mobile-a-term-touch'

describe('getMobileATermTouchStyles', () => {
  it('disables native touch gestures so JS handles scrolling', () => {
    expect(getMobileATermTouchStyles()).toEqual({
      overscrollBehavior: 'none',
      touchAction: 'none',
    })
  })

})

describe('applyMobileATermTouchStyles', () => {
  it('applies touch-safe scrolling styles to the xterm touch surfaces', () => {
    const container = document.createElement('div')
    const screen = document.createElement('div')
    const viewport = document.createElement('div')

    screen.className = 'xterm-screen'
    viewport.className = 'xterm-viewport'
    container.append(screen, viewport)

    applyMobileATermTouchStyles(container)

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
      viewport.classList.contains(MOBILE_A_TERM_VIEWPORT_CLASS),
    ).toBe(true)
  })
})
