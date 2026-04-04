export interface MobileTerminalTouchStyles {
  overscrollBehavior: 'none'
  touchAction: 'none'
}

export const MOBILE_TERMINAL_TOUCH_SURFACE_SELECTORS = [
  '.xterm-screen',
  '.xterm-viewport',
] as const

export const MOBILE_TERMINAL_VIEWPORT_CLASS =
  'mobile-terminal-viewport'

/**
 * Disable native touch gesture handling so JavaScript controls all scrolling.
 * This is required because touch-action: pan-y lets Chrome's compositor start
 * native scrolling before our touchmove handlers can call preventDefault().
 * overscrollBehavior: none still prevents pull-to-refresh independently.
 */
export function getMobileTerminalTouchStyles(): MobileTerminalTouchStyles {
  return {
    overscrollBehavior: 'none',
    touchAction: 'none',
  }
}

/**
 * Apply touch-safe scrolling styles to the terminal container and the xterm
 * surfaces that actually receive drag gestures on mobile browsers.
 */
export function applyMobileTerminalTouchStyles(container: HTMLElement): void {
  const touchStyles = getMobileTerminalTouchStyles()

  container.style.overscrollBehavior = touchStyles.overscrollBehavior
  container.style.touchAction = touchStyles.touchAction

  for (const selector of MOBILE_TERMINAL_TOUCH_SURFACE_SELECTORS) {
    const element = container.querySelector<HTMLElement>(selector)
    if (!element) continue

    element.style.overscrollBehavior = touchStyles.overscrollBehavior
    element.style.touchAction = touchStyles.touchAction

    if (selector === '.xterm-viewport') {
      element.classList.add(MOBILE_TERMINAL_VIEWPORT_CLASS)
      element.style.setProperty('-webkit-overflow-scrolling', 'touch')
    }
  }
}
