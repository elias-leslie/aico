// Who holds a session's shared tmux window size, from this window's side.
// Every attached client sizes the same window, so when another client (a phone
// in a browser, say) claims it, this window would keep its full-width terminal
// over a narrow pane. While another client holds the size the window draws the
// session at that client's size under a slim bar naming it, with a way to take
// the size back, and takes it back when the owner uses the window: a click in
// the terminal, typing or pasting. Focus alone only looks.
//
// The bar is slow to appear and quick to go: it shows only once another
// client has held the size for OVERLAY_DELAY_MS, so a claim that is taken back
// at once, or a brief swap while typing, never flashes it. Automatic claims are
// spaced out and capped, so two clients that are both in use cannot trade the
// size back and forth.

import type { ViewerLabel } from 'tether/client'

/** Another client must hold the size this long before the bar shows. */
export const OVERLAY_DELAY_MS = 600
/** Activity (typing, clicking) takes the size back at most this often. */
export const RECLAIM_SPACING_MS = 1500
/** Owner input this recent counts as actively using the window. */
export const ACTIVE_WITHIN_MS = 5000
/** At most this many automatic claims per window of time before the bar stays. */
const AUTO_LIMIT = 3
const AUTO_WINDOW_MS = 10_000

/** Who holds the size instead of this window, and the window's size then
 * (null until tmux has said). */
export interface HeldElsewhere {
  viewer: ViewerLabel | null
  size: { cols: number; rows: number } | null
}

export interface SizeHolderDeps {
  /** Claim the size for this window's terminal (one at a time; the caller coalesces). */
  reclaim(): void
  /** Show the session as held by another client (again, when that changed),
   * or as this window's own (null). */
  show(held: HeldElsewhere | null): void
  /** The window has focus and the owner typed in it a moment ago. */
  isActive(): boolean
  now?(): number
}

export function createSizeHolder(deps: SizeHolderDeps) {
  const now = deps.now ?? Date.now
  let other: HeldElsewhere | null = null
  let visible = false
  let timer: NodeJS.Timeout | undefined
  let lastAuto = -Infinity
  const autoClaims: number[] = []

  function setVisible(next: boolean): void {
    if (next === visible) return
    visible = next
    deps.show(next ? other : null)
  }

  function auto(): void {
    const at = now()
    if (at - lastAuto < RECLAIM_SPACING_MS) return
    while (autoClaims.length && at - autoClaims[0] > AUTO_WINDOW_MS) autoClaims.shift()
    if (autoClaims.length >= AUTO_LIMIT) return
    lastAuto = at
    autoClaims.push(at)
    deps.reclaim()
  }

  return {
    /** Another client claimed the size, or the size it holds changed. */
    lost(held: HeldElsewhere): void {
      const changed = JSON.stringify(held) !== JSON.stringify(other)
      other = held
      if (visible && changed) deps.show(held)
      if (deps.isActive()) auto()
      if (!timer && !visible) {
        timer = setTimeout(() => {
          timer = undefined
          if (other) setVisible(true)
        }, OVERLAY_DELAY_MS)
      }
    },
    /** This window holds the size (its claim applied, or Tether says so). */
    held(): void {
      other = null
      if (timer) clearTimeout(timer)
      timer = undefined
      setVisible(false)
    },
    /** The owner clicked or typed in this window. */
    activity(): void {
      if (other) auto()
    },
    /** The owner pressed Use here. */
    force(): void {
      deps.reclaim()
    },
    isOther: (): boolean => other !== null,
    dispose(): void {
      if (timer) clearTimeout(timer)
      timer = undefined
    },
  }
}

export type SizeHolder = ReturnType<typeof createSizeHolder>
