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

  // A shell session may now be running an agent launched from its prompt.
  // Never let xterm synthesize history-navigation keys at the live bottom.
  if (!mouseReportingActive) return deltaY < 0 ? 'open' : 'consume'
  // A program that grabbed the mouse (vim, htop, an agent) scrolls itself.
  // xterm's own wheel reporting is switched off for the whole terminal, so
  // the wheel has to be sent explicitly; tmux re-encodes it for the pane.
  return 'forward'
}

export function shouldOpenScrollbackOnWheel(policy: ScrollbackWheelPolicy): boolean {
  return scrollbackWheelAction(policy) === 'open'
}

/**
 * Whether a wheel event belongs to the live pane at all.
 *
 * This is the synchronous half of the decision, taken before tmux has been
 * asked which way to route the wheel. The scrollback overlay is a scrollable
 * xterm of its own -- it pages older history at the top and dismisses on a
 * downward wheel at the bottom -- so whenever it is up, the wheel is its own
 * and the pane must not claim it.
 */
export function claimsWheelForPane({
  deltaY,
  overlayActive,
  tuiSlug,
}: {
  deltaY: number
  overlayActive: boolean
  tuiSlug: string
}): boolean {
  if (deltaY === 0 || overlayActive) return false
  return tuiSlug !== 'shell'
}

/**
 * Whether the program in the pane runs its own text selection, so mouse drags
 * should reach it untouched.
 *
 * Claude Code's fullscreen renderer draws in the alternate screen, grabs the
 * mouse, and selects across its whole transcript itself: dragging to an edge
 * auto-scrolls the conversation and release copies to the clipboard. Forcing
 * xterm's local selection there limits a copy to the visible rows. A plain
 * shell hands the mouse to whatever full-screen program enabled it. Other
 * agents keep the local selection, which Shift-drag also gives anywhere.
 */
export function programOwnsSelection({
  tuiSlug,
  alternateScreen,
  mouseReporting,
}: {
  tuiSlug: string
  alternateScreen: boolean
  mouseReporting: boolean
}): boolean {
  if (!alternateScreen || !mouseReporting) return false
  return tuiSlug === 'claude-code' || tuiSlug === 'shell'
}
