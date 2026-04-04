import { describe, expect, it } from 'vitest'
import { getScrollbackOverlayWheelAction } from './scrollback-overlay-scroll'

describe('getScrollbackOverlayWheelAction', () => {
  it('dismisses when the user wheels down past the bottom', () => {
    expect(
      getScrollbackOverlayWheelAction({
        deltaY: 80,
        isAtBottom: true,
      }),
    ).toEqual({ kind: 'dismiss' })
  })

  it('uses the shared ad-hoc wheel delta math when scrolling within history', () => {
    expect(
      getScrollbackOverlayWheelAction({
        deltaY: -84,
        isAtBottom: true,
      }),
    ).toEqual({ kind: 'scroll', lineDelta: -12 })

    expect(
      getScrollbackOverlayWheelAction({
        deltaY: 84,
        isAtBottom: false,
      }),
    ).toEqual({ kind: 'scroll', lineDelta: 12 })
  })
})
