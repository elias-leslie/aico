import { SCROLL_THRESHOLD } from '../constants/a-term'
import { prefersLocalViewportScrollForMode } from '../utils/session-mode'

type XtermATerm = InstanceType<typeof import('@xterm/xterm').Terminal>

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ARROW_UP = '\x1b[A'
export const ARROW_DOWN = '\x1b[B'
/** SGR (1006) mouse button codes for wheel up/down. */
const SGR_WHEEL_UP_BUTTON = 64
const SGR_WHEEL_DOWN_BUTTON = 65
/** Cap per scroll event so a fling cannot flood the session with reports. */
const MAX_MOUSE_WHEEL_TICKS_PER_EVENT = 12
/** WheelEvent.deltaMode values. */
const WHEEL_DELTA_MODE_LINE = 1
const WHEEL_DELTA_MODE_PAGE = 2
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

/**
 * Build an SGR mouse wheel report for a terminal cell.
 *
 * Full-screen TUIs that enable mouse tracking (Claude Code) own their own
 * scrollback: tmux keeps no history for the alternate screen, so the only way
 * to reach earlier output is to hand the wheel to the application. xterm.js
 * already does this for real wheel events; touch drags have to be translated
 * here.
 */
export function buildMouseWheelSequence(
  direction: 'up' | 'down',
  column = 1,
  row = 1,
): string {
  const button =
    direction === 'up' ? SGR_WHEEL_UP_BUTTON : SGR_WHEEL_DOWN_BUTTON
  return `\x1b[<${button};${clampCell(column)};${clampCell(row)}M`
}

function clampCell(value: number, max = Number.POSITIVE_INFINITY): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(Math.max(Math.trunc(value), 1), Math.max(max, 1))
}

/** Translate a client point inside the a-term screen to 1-based cell coords. */
export function pointToCell(
  screen: HTMLElement | null,
  aTerm: XtermATerm,
  clientX: number,
  clientY: number,
): { column: number; row: number } {
  if (!screen) return { column: 1, row: 1 }
  const rect = screen.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return { column: 1, row: 1 }
  const column =
    Math.floor(((clientX - rect.left) / rect.width) * aTerm.cols) + 1
  const row = Math.floor(((clientY - rect.top) / rect.height) * aTerm.rows) + 1
  return {
    column: clampCell(column, aTerm.cols),
    row: clampCell(row, aTerm.rows),
  }
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
  return (
    cellHeight / (MOBILE_TOUCH_SCROLL_SENSITIVITY * SCROLL_SPEED_MULTIPLIER)
  )
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

/** Wheel ticks a drag of `deltaY` pixels is worth, one tick per text row. */
export function getMouseWheelTickCount(
  deltaY: number,
  cellHeight: number,
): number {
  const step = cellHeight > 0 ? cellHeight : SCROLL_THRESHOLD
  const ticks = Math.trunc(Math.abs(deltaY) / step)
  return Math.min(ticks, MAX_MOUSE_WHEEL_TICKS_PER_EVENT)
}

/**
 * Wheel ticks a desktop wheel event is worth, honouring its delta mode.
 *
 * xterm.js refuses to translate wheel events into mouse reports unless its
 * render service has already published device cell metrics, which never
 * happens for these panes, so a-term does the translation itself and matches
 * xterm's own pixels-to-rows math.
 */
export function getWheelMouseTickCount(
  deltaY: number,
  deltaMode: number,
  cellHeight: number,
  rows: number,
): number {
  if (deltaY === 0) return 0
  const pixelStep = cellHeight > 0 ? cellHeight : DESKTOP_WHEEL_LINE_HEIGHT_PX
  const lines =
    deltaMode === WHEEL_DELTA_MODE_LINE
      ? Math.abs(deltaY)
      : deltaMode === WHEEL_DELTA_MODE_PAGE
        ? Math.abs(deltaY) * Math.max(rows, 1)
        : Math.abs(deltaY) / pixelStep
  return Math.min(
    Math.max(Math.round(lines), 1),
    MAX_MOUSE_WHEEL_TICKS_PER_EVENT,
  )
}

export function computeWheelLineDelta(deltaY: number): number {
  return (
    Math.max(1, Math.floor(Math.abs(deltaY) / DESKTOP_WHEEL_LINE_HEIGHT_PX)) *
    SCROLL_SPEED_MULTIPLIER *
    (deltaY > 0 ? 1 : -1)
  )
}

// ---------------------------------------------------------------------------
// Touch event handler setup
// ---------------------------------------------------------------------------

/**
 * Whether the program in the pane owns its own scrollback.
 *
 * tmux is the authority (see `usePaneMode`); until it has answered, fall back
 * to what this xterm has observed, which is what a-term always used.
 */
export function resolvesToAppOwnedScrollback(
  aTerm: XtermATerm,
  paneOwnsScrollback?: () => boolean | null,
): boolean {
  const owned = paneOwnsScrollback?.() ?? null
  return owned === null ? isMouseTrackingActive(aTerm) : owned
}

export interface TouchScrollDeps {
  aTermRef: React.RefObject<XtermATerm | null>
  sendArrowKey: (direction: 'up' | 'down') => void
  sendMouseWheel: (
    direction: 'up' | 'down',
    column: number,
    row: number,
  ) => void
  sessionMode?: string
  onRequestScrollbackOverlay?: () => void
  isScrollbackOverlayActive?: boolean
  paneOwnsScrollback?: () => boolean | null
  requestPaneMode?: () => void
}

export function setupTouchHandlers(
  container: HTMLElement,
  deps: TouchScrollDeps,
): () => void {
  let touchStartY = 0
  let lastSentY = 0
  let pendingNormalScrollDeltaY = 0

  // Touch start must not send anything to the pane. Entering tmux copy-mode
  // here left the pane stuck in copy-mode once the drag finished, and tmux then
  // swallowed every later keystroke — the session looked like it had stopped
  // accepting input entirely.
  const handleTouchStart = (e: TouchEvent) => {
    touchStartY = e.touches[0].clientY
    lastSentY = touchStartY
    pendingNormalScrollDeltaY = 0
    // Ask tmux who owns the scrollback now, so the answer is in hand by the
    // time the finger has moved far enough to scroll anything.
    deps.requestPaneMode?.()
  }

  const handleTouchMove = (e: TouchEvent) => {
    const aTerm = deps.aTermRef.current
    if (!aTerm) return
    const currentY = e.touches[0].clientY

    if (touchStartY === 0 && lastSentY === 0) {
      ;({ touchStartY, lastSentY } = initializeTouchTracking(currentY))
    }

    // Applications that track the mouse keep their own scrollback (Claude Code
    // draws in the alternate screen, where tmux stores no history at all), so
    // hand the drag to the application as wheel reports. That is what a wheel
    // does on a desktop terminal, and it is the only history these panes have.
    if (resolvesToAppOwnedScrollback(aTerm, deps.paneOwnsScrollback)) {
      e.preventDefault()
      e.stopPropagation()
      const screen = container.querySelector<HTMLElement>('.xterm-screen')
      const deltaY = lastSentY - currentY
      const cellHeight = screen
        ? screen.clientHeight / Math.max(aTerm.rows, 1)
        : 0
      const ticks = getMouseWheelTickCount(deltaY, cellHeight)
      if (ticks > 0) {
        const touch = e.touches[0]
        const { column, row } = pointToCell(
          screen,
          aTerm,
          touch.clientX,
          touch.clientY,
        )
        const direction = deltaY > 0 ? 'down' : 'up'
        for (let tick = 0; tick < ticks; tick += 1) {
          deps.sendMouseWheel(direction, column, row)
        }
        // Keep the sub-line remainder so a slow drag still tracks the content
        // one row at a time instead of snapping on every event.
        const consumed =
          ticks * (cellHeight > 0 ? cellHeight : SCROLL_THRESHOLD)
        lastSentY -= deltaY > 0 ? consumed : -consumed
      }
      return
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
  }
}
