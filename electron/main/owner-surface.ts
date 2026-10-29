// Where the owner is working now: on this desktop, or in the web app (a
// browser or the phone). Tether's own shows (a new root's window, a due
// check-in, a recovered or rebooted session) and a launch with nothing to
// restore open desktop windows only while the owner works here; otherwise they
// keep popping up behind the browser the owner is using, minutes after the
// owner closed them.

import type { SizeHolder, ViewerLabel } from 'tether/client'

/** When the owner last came back to this desktop (ISO time), kept across restarts. */
export const DESKTOP_SINCE = 'owner-desktop-since'

interface OwnerSurfaceDeps {
  getSetting(key: string): string | undefined
  setSetting(key: string, value: string): void
  now?: () => Date
}

export function createOwnerSurface(deps: OwnerSurfaceDeps) {
  const now = deps.now ?? (() => new Date())
  // Unknown until a claim or the owner's input says otherwise: the desktop, as before.
  let onDesktop = true
  // This stretch on the desktop is on record (written once, not per key).
  let recorded = false
  // Bumped by every live signal, so a slower seed never overrides one.
  let seen = 0
  return {
    /** The owner pressed a key, clicked or scrolled in an Aico window. */
    used(): void {
      seen += 1
      onDesktop = true
      if (recorded) return
      recorded = true
      deps.setSetting(DESKTOP_SINCE, now().toISOString())
    },
    /** A client claimed a session's size. The web app claims only while its
     * terminal has focus or takes typing; the desktop also claims for windows
     * it shows or arranges itself, so only the owner's input (above) brings
     * the owner back here. */
    sizeHeld(viewer: ViewerLabel | null): void {
      if (viewer?.app !== 'web') return
      seen += 1
      onDesktop = false
      recorded = false
    },
    /** At launch: a web claim Tether remembers from after the owner last used
     * this desktop means the owner is in the web app. */
    async seed(holders: () => Promise<(SizeHolder | null)[]>): Promise<void> {
      const before = seen
      const known: (SizeHolder | null)[] = await holders().catch(() => [])
      const since = deps.getSetting(DESKTOP_SINCE) ?? ''
      const web = known.some((holder) => holder?.viewer?.app === 'web' && holder.claimedAt > since)
      if (web && seen === before) onDesktop = false
    },
    onDesktop: (): boolean => onDesktop,
  }
}
