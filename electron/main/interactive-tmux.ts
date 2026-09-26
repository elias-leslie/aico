import { listClientsTargetArgs, refreshClientArgs, type TmuxTarget } from './tmux'

/** Share one pending interactive query without retaining a stale result. */
export function coalesceAsync<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined
  return () => {
    if (pending) return pending
    const request = Promise.resolve().then(load)
    pending = request
    void request.then(
      () => {
        if (pending === request) pending = undefined
      },
      () => {
        if (pending === request) pending = undefined
      },
    )
    return request
  }
}

/** Repaint only clients from this session, stopping when the initiating PTY is stale. */
export async function refreshAttachedTmuxClients(
  target: TmuxTarget,
  run: (args: string[]) => Promise<string>,
  isCurrent: () => boolean,
): Promise<void> {
  if (!isCurrent()) return
  const output = await run(listClientsTargetArgs(target))
  for (const client of output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)) {
    if (!isCurrent()) return
    await run(refreshClientArgs(client, target.socket))
  }
}
