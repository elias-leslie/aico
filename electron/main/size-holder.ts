// Who holds a session's shared tmux window size, from this window's side.
// Every attached client sizes the same window, so when another client (a phone
// in a browser, say) claims it, this window keeps its full-width terminal over a
// narrow pane. While another client holds the size the window shows a notice
// with a way to take it back, and takes it back by itself when the owner comes
// back to the window: focus, a click in the terminal, or typing.
//
// The notice is slow to appear and quick to go: it shows only once another
// client has held the size for OVERLAY_DELAY_MS, so a claim that is taken back
// at once, or a brief swap while typing, never flashes it. Automatic claims are
// spaced out and capped, so two clients that are both in use cannot trade the
// size back and forth.

/** Another client must hold the size this long before the notice shows. */
export const OVERLAY_DELAY_MS = 600
/** Activity (typing, clicking) takes the size back at most this often. */
export const RECLAIM_SPACING_MS = 1500
/** Owner input this recent counts as actively using the window. */
export const ACTIVE_WITHIN_MS = 5000
/** At most this many automatic claims per window of time before the notice stays. */
const AUTO_LIMIT = 3
const AUTO_WINDOW_MS = 10_000

export interface SizeHolderDeps {
  /** Claim the size for this window's terminal (one at a time; the caller coalesces). */
  reclaim(): void
  /** Show or hide the notice in the window. */
  show(visible: boolean): void
  /** The window has focus and the owner typed in it a moment ago. */
  isActive(): boolean
  now?(): number
}

export function createSizeHolder(deps: SizeHolderDeps) {
  const now = deps.now ?? Date.now
  let other = false
  let visible = false
  let timer: NodeJS.Timeout | undefined
  let lastAuto = -Infinity
  const autoClaims: number[] = []

  function setVisible(next: boolean): void {
    if (next === visible) return
    visible = next
    deps.show(next)
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
    /** Another client claimed the size. */
    lost(): void {
      other = true
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
      other = false
      if (timer) clearTimeout(timer)
      timer = undefined
      setVisible(false)
    },
    /** The owner focused, clicked or typed in this window. */
    activity(): void {
      if (other) auto()
    },
    /** The owner pressed Use here. */
    force(): void {
      deps.reclaim()
    },
    isOther: (): boolean => other,
    dispose(): void {
      if (timer) clearTimeout(timer)
      timer = undefined
    },
  }
}

export type SizeHolder = ReturnType<typeof createSizeHolder>
