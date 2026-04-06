import { SCROLL_THRESHOLD } from '../constants/a-term'
import { prefersLocalViewportScrollForMode } from '../utils/session-mode'

type XtermATerm = InstanceType<typeof import('@xterm/xterm').Terminal>

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ARROW_UP = '\x1b[A'
export const ARROW_DOWN = '\x1b[B'
export const COPY_MODE_ENTER = '\x02['
export const COPY_MODE_SCROLL_UP = '\x15'
export const COPY_MODE_SCROLL_DOWN = '\x04'
export const MOBILE_TOUCH_SCROLL_SENSITIVITY = 2
export const DESKTOP_WHEEL_LINE_HEIGHT_PX = 14
export const SCROLL_SPEED_MULTIPLIER = 2

// ---------------------------------------------------------------------------
// A-Term state queries
// ---------------------------------------------------------------------------

export function isAlternateScreen(aTerm: XtermATerm): boolean {
  return aTerm.buffer.active.type === 'alternate'
}

export function isMouseTrackingActive(aTerm: XtermATerm): boolean {
  return aTerm.modes.mouseTrackingMode !== 'none'
}

// ---------------------------------------------------------------------------
// Pure scroll math
// ---------------------------------------------------------------------------

export function getTouchScrollLineDelta(
  pixelDeltaY: number,
  cellHeight: number,
): number {
  if (cellHeight <= 0 || pixelDeltaY === 0) return 0
  const effectiveCellHeight = getTouchScrollEffectiveCellHeight(cellHeight)
  const lines = Math.max(
    1,
    Math.floor(Math.abs(pixelDeltaY) / effectiveCellHeight),
  )
  return pixelDeltaY > 0 ? lines : -lines
}

export function getTouchScrollEffectiveCellHeight(cellHeight: number): number {
  if (cellHeight <= 0) return 0
  return cellHeight / (MOBILE_TOUCH_SCROLL_SENSITIVITY * SCROLL_SPEED_MULTIPLIER)
}

export function refreshATermViewport(aTerm: XtermATerm): void {
  const start = 0
  const end = Math.max(aTerm.rows - 1, 0)

  // xterm's public aTerm.refresh() can leave touch-driven scrollLines()
  // visually stale on mobile — the buffer position changes but the rendered
  // rows don't update.  The internal refreshRows() forces a repaint of the
  // newly-selected viewport rows.
  const renderService = (
    aTerm as XtermATerm & {
      _core?: {
        _renderService?: {
          refreshRows?: (start: number, end: number) => void
        }
      }
    }
  )._core?._renderService

  if (typeof renderService?.refreshRows === 'function') {
    renderService.refreshRows(start, end)
    return
  }

  aTerm.refresh(start, end)
}

export function initializeTouchTracking(currentY: number): {
  touchStartY: number
  lastSentY: number
} {
  return { touchStartY: currentY, lastSentY: currentY }
}

export function computeWheelLineDelta(deltaY: number): number {
  return Math.max(
    1,
    Math.floor(Math.abs(deltaY) / DESKTOP_WHEEL_LINE_HEIGHT_PX),
  ) * SCROLL_SPEED_MULTIPLIER * (deltaY > 0 ? 1 : -1)
}

// ---------------------------------------------------------------------------
// Touch event handler setup
// ---------------------------------------------------------------------------

export interface TouchScrollDeps {
  aTermRef: React.RefObject<XtermATerm | null>
  enterCopyMode: () => void
  sendArrowKey: (direction: 'up' | 'down') => void
  sendCopyModeScroll: (direction: 'up' | 'down') => void
  resetCopyMode: () => void
  sessionMode?: string
  onRequestScrollbackOverlay?: () => void
  isScrollbackOverlayActive?: boolean
}

export function setupTouchHandlers(
  container: HTMLElement,
  deps: TouchScrollDeps,
): () => void {
  let touchStartY = 0
  let lastSentY = 0
  let pendingNormalScrollDeltaY = 0

  const handleTouchStart = (e: TouchEvent) => {
    touchStartY = e.touches[0].clientY
    lastSentY = touchStartY
    pendingNormalScrollDeltaY = 0

    const aTerm = deps.aTermRef.current
    if (
      aTerm &&
      !isAlternateScreen(aTerm) &&
      isMouseTrackingActive(aTerm)
    ) {
      deps.enterCopyMode()
    }
  }

  const handleTouchMove = (e: TouchEvent) => {
    const aTerm = deps.aTermRef.current
    if (!aTerm) return
    const currentY = e.touches[0].clientY

    if (touchStartY === 0 && lastSentY === 0) {
      ;({ touchStartY, lastSentY } = initializeTouchTracking(currentY))
    }

    // TUI sessions: activate scrollback overlay on a natural downward drag,
    // matching the rest of mobile aTerm scrolling.
    if (prefersLocalViewportScrollForMode(deps.sessionMode)) {
      e.preventDefault()
      e.stopPropagation()
      const deltaY = lastSentY - currentY
      // deltaY < 0 means finger moved down = scroll up into earlier history.
      // Only update lastSentY when threshold is met — touch events fire
      // with tiny deltas (1-5px) that must accumulate to reach the threshold.
      if (Math.abs(deltaY) >= SCROLL_THRESHOLD) {
        if (deltaY < 0 && !deps.isScrollbackOverlayActive) {
          deps.onRequestScrollbackOverlay?.()
        }
        lastSentY = currentY
      }
      return
    }

    if (isAlternateScreen(aTerm)) {
      e.preventDefault()
      e.stopPropagation()
      const deltaY = lastSentY - currentY
      if (Math.abs(deltaY) >= SCROLL_THRESHOLD) {
        deps.sendArrowKey(deltaY > 0 ? 'down' : 'up')
        lastSentY = currentY
      }
      return
    }

    if (isMouseTrackingActive(aTerm)) {
      e.preventDefault()
      e.stopPropagation()
      const deltaY = lastSentY - currentY
      if (Math.abs(deltaY) >= SCROLL_THRESHOLD) {
        deps.enterCopyMode()
        deps.sendCopyModeScroll(deltaY > 0 ? 'down' : 'up')
        lastSentY = currentY
      }
      return
    }

    pendingNormalScrollDeltaY += lastSentY - currentY
    lastSentY = currentY

    const screen = container.querySelector<HTMLElement>('.xterm-screen')
    const cellHeight = screen
      ? screen.clientHeight / Math.max(aTerm.rows, 1)
      : 0
    const lineDelta = getTouchScrollLineDelta(
      pendingNormalScrollDeltaY,
      cellHeight,
    )
    if (lineDelta === 0) return

    e.preventDefault()
    e.stopPropagation()
    aTerm.scrollLines(lineDelta)
    refreshATermViewport(aTerm)
    pendingNormalScrollDeltaY -=
      lineDelta * getTouchScrollEffectiveCellHeight(cellHeight)
  }

  const handleTouchEnd = () => {
    touchStartY = 0
    lastSentY = 0
    pendingNormalScrollDeltaY = 0
  }

  container.addEventListener('touchstart', handleTouchStart, {
    passive: true,
    capture: true,
  })
  container.addEventListener('touchmove', handleTouchMove, {
    passive: false,
    capture: true,
  })
  container.addEventListener('touchend', handleTouchEnd, {
    passive: true,
    capture: true,
  })
  container.addEventListener('touchcancel', handleTouchEnd, {
    passive: true,
    capture: true,
  })

  return () => {
    container.removeEventListener('touchstart', handleTouchStart, {
      capture: true,
    })
    container.removeEventListener('touchmove', handleTouchMove, {
      capture: true,
    })
    container.removeEventListener('touchend', handleTouchEnd, {
      capture: true,
    })
    container.removeEventListener('touchcancel', handleTouchEnd, {
      capture: true,
    })
    deps.resetCopyMode()
  }
}
