'use client'

import {
  type QueryClient,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { useEffect, useSyncExternalStore } from 'react'
import { apiFetch } from '../api-fetch'
import type { NightshiftViewResult } from '../health'

/** How often the pill re-reads Nightshift's view while its live feed is down (its checks run every few minutes). */
export const HEALTH_POLL_MS = 60_000
/** A refused or unanswered feed (EventSource gave up) is opened again after this. */
export const HEALTH_STREAM_RETRY_MS = 30_000
export const HEALTH_STREAM_URL = '/api/nightshift/stream'
const QUERY_KEY = ['nightshift-view']

// One feed per page, shared by the pill and the sheet: the server says when
// Nightshift's items changed (`changed`) and whether its own feed from
// Nightshift is up (`live`). While it isn't, the view is polled instead.
let users = 0
let source: EventSource | null = null
let retry: ReturnType<typeof setTimeout> | undefined
let client: QueryClient | null = null
let live = false
const liveListeners = new Set<() => void>()

function setLive(next: boolean): void {
  if (live === next) return
  live = next
  for (const listener of liveListeners) listener()
}

function reread(): void {
  void client?.invalidateQueries({ queryKey: QUERY_KEY })
}

function open(): void {
  if (typeof EventSource === 'undefined') return
  const es = new EventSource(HEALTH_STREAM_URL)
  source = es
  es.addEventListener('live', (event) => {
    let next = false
    try {
      next = JSON.parse((event as MessageEvent<string>).data)?.live === true
    } catch {}
    // Back from polling: what changed meanwhile wasn't heard, read it now.
    if (next && !live) reread()
    setLive(next)
  })
  es.addEventListener('changed', reread)
  es.onerror = () => {
    setLive(false)
    // EventSource retries a dropped stream itself; a refused one it closes for good.
    if (es.readyState === EventSource.CLOSED && source === es) {
      source = null
      retry = setTimeout(() => {
        retry = undefined
        if (users > 0 && !source) open()
      }, HEALTH_STREAM_RETRY_MS)
    }
  }
}

function hold(queryClient: QueryClient): () => void {
  client = queryClient
  users += 1
  if (users === 1 && !source && !retry) open()
  return () => {
    users -= 1
    if (users > 0) return
    clearTimeout(retry)
    retry = undefined
    source?.close()
    source = null
    setLive(false)
  }
}

function subscribeLive(listener: () => void): () => void {
  liveListeners.add(listener)
  return () => liveListeners.delete(listener)
}

const isLive = () => live
const notLive = () => false

/** Nightshift's owner view, read through the web server, again whenever Nightshift says it changed. */
export function useHealth() {
  const queryClient = useQueryClient()
  const streaming = useSyncExternalStore(subscribeLive, isLive, notLive)
  useEffect(() => hold(queryClient), [queryClient])
  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () =>
      apiFetch<NightshiftViewResult>(
        '/api/nightshift/view',
        undefined,
        'Couldn’t load health',
      ),
    staleTime: 30_000,
    // The feed says when to read again; a slow poll only while it is down.
    refetchInterval: streaming ? false : HEALTH_POLL_MS,
  })
  return {
    result: query.data,
    isLoading: query.isLoading,
    // A failed refresh after a good read still counts: the old view is not current.
    isError: query.isError,
    refetch: query.refetch,
  }
}
