import { computeWheelLineDelta } from '../hooks/aterm-scrolling-utils'

interface GetScrollbackOverlayWheelActionArgs {
  deltaY: number
  isAtBottom: boolean
}

type ScrollbackOverlayWheelAction =
  | { kind: 'dismiss' }
  | { kind: 'scroll'; lineDelta: number }

export function getScrollbackOverlayWheelAction({
  deltaY,
  isAtBottom,
}: GetScrollbackOverlayWheelActionArgs): ScrollbackOverlayWheelAction {
  if (isAtBottom && deltaY > 0) {
    return { kind: 'dismiss' }
  }

  return {
    kind: 'scroll',
    lineDelta: computeWheelLineDelta(deltaY),
  }
}
