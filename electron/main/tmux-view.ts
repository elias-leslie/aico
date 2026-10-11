// View-side tmux helpers. Tether owns every tmux server, session and pane, and
// answers the pane-mode question itself (GET /v1/sessions/:id/pane-mode). Aico
// only runs `tmux attach` for its windows (the byte path) and, against the exact
// socket and target Tether handed out for that attach, repaints its own
// attached clients.

export interface AttachedTarget {
  socket: string
  target: string
}

/** Share one pending query without retaining a stale result. */
export function coalesceAsync<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined
  return () => {
    if (pending) return pending
    const request = Promise.resolve().then(load)
    pending = request
    const clear = () => {
      if (pending === request) pending = undefined
    }
    void request.then(clear, clear)
    return request
  }
}

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

/** Repaint only clients attached to this session, stopping once the
 * initiating PTY is stale. */
export async function refreshAttachedClients(
  { socket, target }: AttachedTarget,
  run: (args: string[]) => Promise<string>,
  isCurrent: () => boolean,
): Promise<void> {
  if (!isCurrent()) return
  const output = await run(['-S', socket, 'list-clients', '-t', target, '-F', '#{client_name}'])
  for (const client of output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)) {
    if (!isCurrent()) return
    await run(['-S', socket, 'refresh-client', '-t', client])
  }
}
