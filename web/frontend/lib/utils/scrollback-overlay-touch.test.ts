import { describe, expect, it } from 'vitest'
import {
  SCROLLBACK_OVERLAY_TOUCH_DISMISS_THRESHOLD_PX,
  shouldDismissScrollbackOverlayTouchGesture,
} from './scrollback-overlay-touch'

describe('shouldDismissScrollbackOverlayTouchGesture', () => {
  it('dismisses only when a gesture starts and ends at bottom with an upward drag', () => {
    expect(
      shouldDismissScrollbackOverlayTouchGesture({
        gestureStartedAtBottom: true,
        gestureLeftBottom: false,
        touchStartY: 280,
        touchEndY: 280 - SCROLLBACK_OVERLAY_TOUCH_DISMISS_THRESHOLD_PX - 1,
        isAtBottom: true,
      }),
    ).toBe(true)
  })

  it('does not dismiss when the user dragged away from bottom to read history', () => {
    expect(
      shouldDismissScrollbackOverlayTouchGesture({
        gestureStartedAtBottom: true,
        gestureLeftBottom: true,
        touchStartY: 280,
        touchEndY: 360,
        isAtBottom: false,
      }),
    ).toBe(false)
  })

  it('does not dismiss when the gesture started above bottom and landed there later', () => {
    expect(
      shouldDismissScrollbackOverlayTouchGesture({
        gestureStartedAtBottom: false,
        gestureLeftBottom: false,
        touchStartY: 280,
        touchEndY: 200,
        isAtBottom: true,
      }),
    ).toBe(false)
  })

  it('does not dismiss for downward drags or tiny movements at bottom', () => {
    expect(
      shouldDismissScrollbackOverlayTouchGesture({
        gestureStartedAtBottom: true,
        gestureLeftBottom: false,
        touchStartY: 280,
        touchEndY: 300,
        isAtBottom: true,
      }),
    ).toBe(false)

    expect(
      shouldDismissScrollbackOverlayTouchGesture({
        gestureStartedAtBottom: true,
        gestureLeftBottom: false,
        touchStartY: 280,
        touchEndY: 280 - SCROLLBACK_OVERLAY_TOUCH_DISMISS_THRESHOLD_PX,
        isAtBottom: true,
      }),
    ).toBe(false)
  })
})
