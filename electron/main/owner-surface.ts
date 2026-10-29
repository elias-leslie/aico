// Where the owner is working now: on this desktop, or in the web app (a
// browser or the phone). Tether's own shows (a new root's window, a due
// check-in, a recovered or rebooted session) and a launch with nothing to
// restore open desktop windows only while the owner works here; otherwise they
// keep popping up behind the browser the owner is using, minutes after the
// owner closed them.

import type { SizeHolder, ViewerLabel } from 'tether/client'

export function createOwnerSurface() {
  // Unknown until a claim or a focus says otherwise: the desktop, as before.
  let onDesktop = true
  // Bumped by every live signal, so a slower seed never overrides one.
  let seen = 0
  return {
    /** An Aico window gained focus. */
    focused(): void {
      onDesktop = true
      seen += 1
    },
    /** A client claimed a session's size. The web app claims only while its
     * terminal has focus or takes typing; the desktop also claims for windows
     * it arranges, so only its focus (above) brings the owner back here. */
    sizeHeld(viewer: ViewerLabel | null): void {
      if (viewer?.app !== 'web') return
      onDesktop = false
      seen += 1
    },
    /** At launch: the latest claim Tether remembers says where the owner was. */
    async seed(holders: () => Promise<(SizeHolder | null)[]>): Promise<void> {
      const before = seen
      const known: (SizeHolder | null)[] = await holders().catch(() => [])
      const latest = known
        .filter((holder): holder is SizeHolder => holder !== null)
        .sort((a, b) => b.claimedAt.localeCompare(a.claimedAt))[0]
      if (latest && seen === before) onDesktop = latest.viewer?.app !== 'web'
    },
    onDesktop: (): boolean => onDesktop,
  }
}
