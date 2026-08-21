interface ScrollbackWheelPolicy {
  deltaY: number
  overlayActive: boolean
  mouseReportingActive: boolean
  alternateScreen: boolean
  tuiSlug: string
}

export type ScrollbackWheelAction = 'ignore' | 'open' | 'consume' | 'forward'

export function scrollbackWheelAction({
  deltaY,
  overlayActive,
  mouseReportingActive,
  alternateScreen,
  tuiSlug,
}: ScrollbackWheelPolicy): ScrollbackWheelAction {
  if (overlayActive || deltaY === 0) return 'ignore'

  // Agent TUIs own their live alternate screen; wheel-up opens tmux scrollback,
  // while wheel-down must still be consumed locally so xterm does not translate
  // the wheel into arrow keys for Claude/Codex.
  if (tuiSlug !== 'shell') {
    // Except when the TUI both draws in the alternate screen and grabs the
    // mouse (Claude Code): tmux then holds no history worth showing — a live
    // session sits at three lines — and the program owns the transcript, so
    // the wheel belongs to it. Antigravity and Codex stay on the overlay
    // because they keep their output in tmux history on the normal screen.
    if (mouseReportingActive && alternateScreen) return 'forward'
    return deltaY < 0 ? 'open' : 'consume'
  }

  if (deltaY < 0 && !mouseReportingActive) return 'open'
  return 'ignore'
}

export function shouldOpenScrollbackOnWheel(policy: ScrollbackWheelPolicy): boolean {
  return scrollbackWheelAction(policy) === 'open'
}
