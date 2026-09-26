import type { LifecycleOwnerToken } from './lifecycle-guard'
import { isATermSessionName, type TmuxTarget } from './tmux'

export interface ExternalView {
  id: string
  sessionId: string
  externalTmuxSocket: string | null
  externalTmuxSession: string | null
}

export type ExternalViewPresence = 'present' | 'absent' | 'unknown'

export interface ExternalViewOperations {
  list: () => ExternalView[]
  isOpen: (id: string) => boolean
  acquire: (id: string) => LifecycleOwnerToken | null
  release: (id: string, owner: LifecycleOwnerToken) => void
  probe: (target: TmuxTarget) => Promise<ExternalViewPresence>
  forget: (row: ExternalView) => boolean
}

/** Refresh may forget a closed A-Term view only after its exact tmux target
 * proves absent. An empty discovery catalog alone is not absence evidence. */
export async function reconcileClosedExternalViews(
  liveSessionNames: readonly string[],
  operations: ExternalViewOperations,
): Promise<number> {
  const live = new Set(liveSessionNames)
  let removed = 0
  for (const row of operations.list()) {
    const session = row.externalTmuxSession
    if (
      !session ||
      row.externalTmuxSocket !== null ||
      !isATermSessionName(session) ||
      live.has(session) ||
      operations.isOpen(row.id)
    )
      continue

    const owner = operations.acquire(row.id)
    if (!owner) continue
    try {
      const presence = await operations.probe({ socket: null, session })
      if (presence !== 'absent') continue
      const current = operations.list().find((candidate) => candidate.id === row.id)
      if (
        !current ||
        current.sessionId !== row.sessionId ||
        current.externalTmuxSocket !== row.externalTmuxSocket ||
        current.externalTmuxSession !== session ||
        operations.isOpen(row.id)
      )
        continue
      if (operations.forget(current)) removed++
    } finally {
      operations.release(row.id, owner)
    }
  }
  return removed
}
