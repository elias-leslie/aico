export const SCROLLBACK_OVERLAY_TOUCH_DISMISS_THRESHOLD_PX = 30

interface ScrollbackOverlayTouchDismissArgs {
  gestureStartedAtBottom: boolean
  gestureLeftBottom: boolean
  touchStartY: number | null
  touchEndY: number | null
  isAtBottom: boolean
}

export function shouldDismissScrollbackOverlayTouchGesture({
  gestureStartedAtBottom,
  gestureLeftBottom,
  touchStartY,
  touchEndY,
  isAtBottom,
}: ScrollbackOverlayTouchDismissArgs): boolean {
  if (touchStartY === null || touchEndY === null) return false
  if (!gestureStartedAtBottom || gestureLeftBottom || !isAtBottom) return false

  return (
    touchStartY - touchEndY > SCROLLBACK_OVERLAY_TOUCH_DISMISS_THRESHOLD_PX
  )
}
