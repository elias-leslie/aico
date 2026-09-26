import {
  fitWindowToSessionArgs,
  listClientsTargetArgs,
  listWindowIdsArgs,
  refreshClientArgs,
  type TmuxTarget,
  windowSizePolicyArgs,
} from './tmux'

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

/** Merge overlapping resize signals, then repeat once for the latest size. */
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

/** Fit an externally owned manual-size window only while this PTY is its sole
 * client and the window is not linked into another session. */
export async function fitSoleExternalTmuxWindow(
  target: TmuxTarget,
  clientPid: number,
  run: (args: string[]) => Promise<string>,
  isCurrent: () => boolean,
): Promise<boolean> {
  if (!isCurrent() || !Number.isSafeInteger(clientPid) || clientPid <= 0) return false
  const clientArgs = listClientsTargetArgs(target, '#{client_pid}\t#{window_id}')
  const clients = (await run(clientArgs))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (!isCurrent() || clients.length !== 1) return false
  const [pid, windowId] = clients[0].split('\t')
  if (pid !== String(clientPid) || !/^@[0-9]+$/.test(windowId ?? '')) return false

  const windows = (await run(listWindowIdsArgs(target.socket)))
    .split('\n')
    .map((line) => line.trim())
  if (!isCurrent() || windows.filter((id) => id === windowId).length !== 1) return false
  const policy = (await run(windowSizePolicyArgs(windowId, target.socket))).trim()
  if (!isCurrent() || policy !== 'manual') return false
  // Recheck the client immediately before changing a shared tmux window.
  if ((await run(clientArgs)).trim() !== clients[0] || !isCurrent()) return false
  await run(fitWindowToSessionArgs(windowId, target.socket))
  return true
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
