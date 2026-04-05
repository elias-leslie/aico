export interface MobileATermTouchStyles {
  overscrollBehavior: 'none'
  touchAction: 'none'
}

export const MOBILE_ATERM_TOUCH_SURFACE_SELECTORS = [
  '.xterm-screen',
  '.xterm-viewport',
] as const

export const MOBILE_ATERM_VIEWPORT_CLASS =
  'mobile-aterm-viewport'

/**
 * Disable native touch gesture handling so JavaScript controls all scrolling.
 * This is required because touch-action: pan-y lets Chrome's compositor start
 * native scrolling before our touchmove handlers can call preventDefault().
 * overscrollBehavior: none still prevents pull-to-refresh independently.
 */
export function getMobileATermTouchStyles(): MobileATermTouchStyles {
  return {
    overscrollBehavior: 'none',
    touchAction: 'none',
  }
}

/**
 * Apply touch-safe scrolling styles to the aterm container and the xterm
 * surfaces that actually receive drag gestures on mobile browsers.
 */
export function applyMobileATermTouchStyles(container: HTMLElement): void {
  const touchStyles = getMobileATermTouchStyles()

  container.style.overscrollBehavior = touchStyles.overscrollBehavior
  container.style.touchAction = touchStyles.touchAction

  for (const selector of MOBILE_ATERM_TOUCH_SURFACE_SELECTORS) {
    const element = container.querySelector<HTMLElement>(selector)
    if (!element) continue

    element.style.overscrollBehavior = touchStyles.overscrollBehavior
    element.style.touchAction = touchStyles.touchAction

    if (selector === '.xterm-viewport') {
      element.classList.add(MOBILE_ATERM_VIEWPORT_CLASS)
      element.style.setProperty('-webkit-overflow-scrolling', 'touch')
    }
  }
}
