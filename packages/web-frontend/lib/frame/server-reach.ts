'use client'

// Whether the Aico server answers, read from the app's own polls (the session
// list and Status) rather than a separate ping. Two failed tries in a row, or
// a poll that gave up, mark it unreachable; any answer marks it back.
// `since` is the last time it answered (or, if it never did on this load,
// when the first try failed): "Can't reach Aico since 4:23 PM".

import type { QueryCache, QueryClient } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'
import { ApiError } from '../api-fetch'

export interface ServerReach {
  down: boolean
  /** When the server last answered, or (never answered) when it first failed; ms. */
  since: number | null
}

/** The polls that say whether the server is up. Other queries may reach other hosts. */
const WATCHED = new Set(['terminal-sessions', 'status'])
/** Failed tries in a row before it counts as down (one blip is not an outage). */
const FAILED_TRIES = 2

const UP: ServerReach = { down: false, since: null }
let state: ServerReach = UP
let lastOk: number | null = null
let firstFail: number | null = null
const listeners = new Set<() => void>()

function publish(next: ServerReach) {
  if (next.down === state.down && next.since === state.since) return
  state = next
  for (const listener of listeners) listener()
}

/** A failure that means the server did not answer: no response, or the
 * proxy in front of it saying the server is gone. A refusal is an answer. */
export function isUnreachable(error: unknown): boolean {
  if (error instanceof ApiError)
    return error.status === 502 || error.status === 503 || error.status === 504
  return error instanceof TypeError
}

export function markAnswered(at = Date.now()) {
  lastOk = at
  firstFail = null
  publish(UP)
}

export function markFailed(at = Date.now()) {
  if (firstFail === null) firstFail = at
  publish({ down: true, since: lastOk ?? firstFail })
}

/** Follow the watched polls in `client`; returns the stop function. */
export function watchServerReach(client: QueryClient): () => void {
  const cache: QueryCache = client.getQueryCache()
  return cache.subscribe((event) => {
    if (event.type !== 'updated') return
    const key = event.query.queryKey[0]
    if (typeof key !== 'string' || !WATCHED.has(key)) return
    const action = event.action
    if (action.type === 'success') markAnswered(event.query.state.dataUpdatedAt)
    else if (
      (action.type === 'failed' && action.failureCount >= FAILED_TRIES) ||
      action.type === 'error'
    ) {
      if (isUnreachable(action.error)) markFailed()
    }
  })
}

export function useServerReach(): ServerReach {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => state,
    () => UP,
  )
}

/** Test hook. */
export function resetServerReachForTest() {
  lastOk = null
  firstFail = null
  publish(UP)
}
