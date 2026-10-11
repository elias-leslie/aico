import {
  listClientsTargetArgs,
  listWindowIdsArgs,
  refreshClientArgs,
  resizeWindowArgs,
  sessionStatusArgs,
  type TmuxTarget,
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

/** The shared tmux window follows the foreground client's grid. Never size an
 * unknown client, linked window, or session with a tmux status row. */
export async function activateTmuxViewSize(
  target: TmuxTarget,
  clientPid: number,
  cols: number,
  rows: number,
  run: (args: string[]) => Promise<string>,
  isCurrent: () => boolean,
): Promise<boolean> {
  if (
    !isCurrent() ||
    !Number.isSafeInteger(clientPid) ||
    clientPid <= 0 ||
    !Number.isSafeInteger(cols) ||
    cols <= 0 ||
    !Number.isSafeInteger(rows) ||
    rows <= 0
  )
    return false
  const clientArgs = listClientsTargetArgs(target, '#{client_pid}\t#{window_id}')
  const clients = (await run(clientArgs)).trim().split('\n')
  if (!isCurrent()) return false
  const ours = clients.filter((line) => line.startsWith(`${clientPid}\t`))
  if (ours.length !== 1) return false
  const [, windowId] = ours[0].split('\t')
  if (!/^@[0-9]+$/.test(windowId ?? '')) return false
  const windows = (await run(listWindowIdsArgs(target.socket))).trim().split('\n')
  if (!isCurrent() || windows.filter((id) => id === windowId).length !== 1) return false
  if ((await run(sessionStatusArgs(target))).trim() !== 'off' || !isCurrent()) return false
  // A detach or window switch can happen while the async queries are running.
  const latest = (await run(clientArgs)).trim().split('\n')
  if (!isCurrent() || latest.filter((line) => line === ours[0]).length !== 1) return false
  await run(resizeWindowArgs(windowId, target.socket, cols, rows))
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
