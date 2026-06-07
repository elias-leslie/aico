// Wheel-to-lines mapping, matched to A-Term's overlay feel: a typical notch
// (~100px deltaY) moves ~14 lines — about half a page — which is the snappy
// scroll speed we want. Chromium gives pixel deltas (deltaMode 0).
const WHEEL_LINE_HEIGHT_PX = 14
const SCROLL_SPEED_MULTIPLIER = 2

export function wheelLineDelta(deltaY: number): number {
  if (deltaY === 0) return 0
  return (
    Math.max(1, Math.floor(Math.abs(deltaY) / WHEEL_LINE_HEIGHT_PX)) *
    SCROLL_SPEED_MULTIPLIER *
    (deltaY > 0 ? 1 : -1)
  )
}
