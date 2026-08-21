// Wheel-to-mouse-report translation for TUIs that own their own scrollback.
//
// Claude Code draws in the alternate screen and turns on SGR (1006) mouse
// reporting, so tmux keeps no usable history for it — the scrollback overlay
// has nothing to show. The program itself holds that transcript and scrolls it
// when it receives wheel reports, so aico builds the reports and writes them
// straight to the pty.

/** SGR (1006) mouse button codes for wheel up/down. */
const SGR_WHEEL_UP_BUTTON = 64
const SGR_WHEEL_DOWN_BUTTON = 65
/** Cap per wheel event so a fling cannot flood the program with reports. */
const MAX_WHEEL_TICKS_PER_EVENT = 12
/** Row height used before the terminal has been measured. */
const NOMINAL_CELL_HEIGHT_PX = 14
/** WheelEvent.deltaMode values. */
const WHEEL_DELTA_MODE_LINE = 1
const WHEEL_DELTA_MODE_PAGE = 2

function clampCell(value: number, max = Number.POSITIVE_INFINITY): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(Math.max(Math.trunc(value), 1), Math.max(max, 1))
}

export function sgrWheelSequence(direction: 'up' | 'down', column = 1, row = 1): string {
  const button = direction === 'up' ? SGR_WHEEL_UP_BUTTON : SGR_WHEEL_DOWN_BUTTON
  return `\x1b[<${button};${clampCell(column)};${clampCell(row)}M`
}

/** Wheel ticks a wheel event is worth, honouring its delta mode. */
export function wheelMouseTicks(
  deltaY: number,
  deltaMode: number,
  cellHeight: number,
  rows: number,
): number {
  if (deltaY === 0) return 0
  const pixelStep = cellHeight > 0 ? cellHeight : NOMINAL_CELL_HEIGHT_PX
  const lines =
    deltaMode === WHEEL_DELTA_MODE_LINE
      ? Math.abs(deltaY)
      : deltaMode === WHEEL_DELTA_MODE_PAGE
        ? Math.abs(deltaY) * Math.max(rows, 1)
        : Math.abs(deltaY) / pixelStep
  return Math.min(Math.max(Math.round(lines), 1), MAX_WHEEL_TICKS_PER_EVENT)
}

/** Translate a client point inside the terminal screen to 1-based cell coords. */
export function pointToCell(
  screen: { getBoundingClientRect(): DOMRect } | null,
  cols: number,
  rows: number,
  clientX: number,
  clientY: number,
): { column: number; row: number } {
  if (!screen) return { column: 1, row: 1 }
  const rect = screen.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return { column: 1, row: 1 }
  return {
    column: clampCell(Math.floor(((clientX - rect.left) / rect.width) * cols) + 1, cols),
    row: clampCell(Math.floor(((clientY - rect.top) / rect.height) * rows) + 1, rows),
  }
}
