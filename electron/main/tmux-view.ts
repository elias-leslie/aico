// View-side tmux helpers. Tether owns every tmux server, session and pane;
// Aico only runs `tmux attach` for its windows (the byte path) and, against the
// exact socket and target Tether handed out for that attach, two read-only view
// queries: the pane's scroll mode and repainting its own attached clients.

export interface AttachedTarget {
  socket: string
  target: string
}

export interface PaneMode {
  alternateScreen: boolean
  mouseReporting: boolean
  historySize: number
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

export function paneModeArgs({ socket, target }: AttachedTarget): string[] {
  return [
    '-S',
    socket,
    'display-message',
    '-p',
    '-t',
    target,
    '#{?alternate_on,1,0} #{?mouse_any_flag,1,0} #{history_size}',
  ]
}

export function parsePaneMode(stdout: string): PaneMode {
  const [alternate, mouse, history] = stdout.trim().split(/\s+/)
  const historySize = Number(history)
  return {
    alternateScreen: alternate === '1',
    mouseReporting: mouse === '1',
    historySize: Number.isSafeInteger(historySize) && historySize > 0 ? historySize : 0,
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
