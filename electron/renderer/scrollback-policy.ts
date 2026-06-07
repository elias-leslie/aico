interface ScrollbackWheelPolicy {
  deltaY: number
  overlayActive: boolean
  mouseReportingActive: boolean
  tuiSlug: string
}

export type ScrollbackWheelAction = 'ignore' | 'open' | 'consume'

export function scrollbackWheelAction({
  deltaY,
  overlayActive,
  mouseReportingActive,
  tuiSlug,
}: ScrollbackWheelPolicy): ScrollbackWheelAction {
  if (overlayActive || deltaY === 0) return 'ignore'

  // Agent TUIs own their live alternate screen; wheel-up opens tmux scrollback,
  // while wheel-down must still be consumed locally so xterm does not translate
  // the wheel into arrow keys for Claude/Codex.
  if (tuiSlug !== 'shell') {
    return deltaY < 0 ? 'open' : 'consume'
  }

  if (deltaY < 0 && !mouseReportingActive) return 'open'
  return 'ignore'
}

export function shouldOpenScrollbackOnWheel(policy: ScrollbackWheelPolicy): boolean {
  return scrollbackWheelAction(policy) === 'open'
}
