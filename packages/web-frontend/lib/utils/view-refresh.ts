export interface ViewSize {
  cols: number
  rows: number
}

/**
 * What to ask the server for when this view starts showing the session at
 * another size (`next`, the holder's).
 *
 * A screen repaint rewrites the pane's rows from the top of the view and
 * leaves the history to xterm's own reflow. That is right only when the view
 * already showed the pane at its size: then xterm and tmux moved the same
 * rows. A view that was still at its own fitted size when the last seed was
 * written (`seeded`) holds that seed laid out for another height, with the
 * pane's screen at the bottom of a taller view; a repaint there writes over
 * the history just above the screen. That first switch takes a full seed;
 * later changes of the holder's size repaint.
 */
export function viewRefresh(
  previous: ViewSize | null,
  next: ViewSize,
  seeded: ViewSize | null,
): 'screen' | 'seed' {
  if (previous) return 'screen'
  if (seeded && seeded.cols === next.cols && seeded.rows === next.rows)
    return 'screen'
  return 'seed'
}
