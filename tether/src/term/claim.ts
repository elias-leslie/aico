// A viewer's claim on the session's shared tmux window size (Tether's
// active-client resize claim), retried while the claim cannot land yet.

import {
  type TetherClient,
  TetherError,
  TetherUnavailable,
  type ViewerLabel,
} from '../client/index'

/** Merge overlapping signals, then repeat once for the latest state. */
export function coalesceTrailingAsync(work: () => Promise<void>): () => Promise<void> {
  let pending = false
  let running: Promise<void> | null = null
  return () => {
    pending = true
    if (running) return running
    running = (async () => {
      try {
        while (pending) {
          pending = false
          await work()
        }
      } finally {
        running = null
      }
    })()
    return running
  }
}

const CLAIM_ATTEMPTS = 4
const CLAIM_RETRY_MS = 200

export interface SizeClaimDeps {
  tether: Pick<TetherClient, 'resizeClaim'>
  id: string
  /** The session generation to claim under (the latest known). */
  generation(): string
  /** The tmux client's pid (on the host, for a remote link; -1 while not
   * known), and the size it asks for. */
  link: { readonly pid: number; readonly cols: number; readonly rows: number }
  /** Names this app and device on the claim ("Viewing on …" elsewhere). */
  viewer?: ViewerLabel
  /** False once the viewer or its link is replaced: stop trying. */
  isCurrent(): boolean
  /** Re-read the session (its generation changed). */
  refresh(): Promise<void>
  /** The claim landed; `changed` when the window was another size before. */
  applied(changed: boolean): void
}

/**
 * Claim the size for this viewer's link. A client that is not attached yet or
 * a tmux that is not answering is retried briefly; a stale generation re-reads
 * the session and tries again; any other refusal ends the claim. Overlapping
 * calls coalesce into one trailing claim at the link's latest size.
 */
export function createSizeClaim(deps: SizeClaimDeps): () => Promise<void> {
  const { tether, id, link } = deps
  return coalesceTrailingAsync(async () => {
    for (let attempt = 0; attempt < CLAIM_ATTEMPTS && deps.isCurrent(); attempt += 1) {
      // A remote link's pid is known once tmux on the host answers: the
      // claim after the first seed carries it.
      if (link.pid <= 0) return
      try {
        const result = await tether.resizeClaim(
          id,
          deps.generation(),
          link.pid,
          link.cols,
          link.rows,
          deps.viewer,
        )
        if (result.applied) {
          deps.applied(result.changed)
          return
        }
        if (result.reason === 'stale') await deps.refresh().catch(() => {})
        else if (result.reason !== 'client_not_attached' && result.reason !== 'tmux_unavailable')
          return
      } catch (error) {
        if (error instanceof TetherError && error.code === 'stale_generation') {
          await deps.refresh().catch(() => {})
          continue
        }
        if (!(error instanceof TetherUnavailable))
          console.warn(`[aico] resize claim failed widget=${id}:`, error)
        return
      }
      await new Promise((resolve) => setTimeout(resolve, CLAIM_RETRY_MS))
    }
  })
}
