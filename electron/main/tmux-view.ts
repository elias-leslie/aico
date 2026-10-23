// Small async coalescing helpers shared by the terminal and the Tether link.

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
