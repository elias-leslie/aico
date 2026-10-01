import { type FSWatcher, watch } from 'node:fs'
import { basename, dirname } from 'node:path'
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
  acquire: (id: string) => LifecycleOwnerToken | null
  release: (id: string, owner: LifecycleOwnerToken) => void
  probe: (target: TmuxTarget) => Promise<ExternalViewPresence>
  forget: (row: ExternalView) => boolean
}

export interface SessionViewOperations extends ExternalViewOperations {
  openViews: () => string[]
  close: (id: string) => void
}

export async function reconcileSessionViews(
  liveSessionNames: readonly string[],
  operations: SessionViewOperations,
): Promise<number> {
  const forgotten = await reconcileClosedExternalViews(liveSessionNames, operations)
  return forgotten + reconcileRetiredViews(operations)
}

/** A catalog deletion is the owner's completed retirement receipt. Terminal
 * exit alone cannot distinguish End from a detached or interrupted client. */
export function reconcileRetiredViews(
  operations: Pick<SessionViewOperations, 'list' | 'openViews' | 'close'>,
): number {
  const retained = new Set(operations.list().map((row) => row.id))
  let closed = 0
  for (const id of operations.openViews()) {
    if (retained.has(id)) continue
    operations.close(id)
    closed++
  }
  return closed
}

/** Observe commits from the independent owner connection, including a commit
 * that lands after the desktop's tmux client has already exited. Watch the
 * directory because SQLite can remove and recreate its WAL. */
export function watchSessionCatalog(
  dbPath: string,
  refresh: () => void,
  onError: (error: Error) => void,
): FSWatcher {
  const name = basename(dbPath)
  const watcher = watch(dirname(dbPath), (_event, filename) => {
    if (filename === null || filename.toString() === name || filename.toString() === `${name}-wal`)
      refresh()
  })
  watcher.on('error', onError)
  return watcher
}

/** Refresh may forget an A-Term view only after its exact tmux target
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
      live.has(session)
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
        current.externalTmuxSession !== session
      )
        continue
      if (operations.forget(current)) removed++
    } finally {
      operations.release(row.id, owner)
    }
  }
  return removed
}
