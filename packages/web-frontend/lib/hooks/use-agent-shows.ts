'use client'

import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '@/lib/api-fetch'
import { openFiles } from '@/lib/files-opener'

type ShowMetadata = {
  id: string
  session: string | null
  title: string | null
  createdAt: string
  /** The linked host that shared it; absent: this computer. Its files are on that host. */
  host?: string
}

/** An agent's share: links to files or folders where they are, or a web link. */
export type AgentShow = ShowMetadata &
  ({ kind: 'files'; paths: string[] } | { kind: 'url'; url: string })

/** The most shares the server lists. */
const MAX_SHOWS = 200
/** On opening the app, at most this many shares made while it was closed pop up. */
const MAX_CATCH_UP = 3
const SEEN_KEY = 'aico:shares-seen-at'
/** The newest share Files > Shared has shown (shares after it are new there). */
const OPENED_KEY = 'aico:shared-opened-at'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isShow(value: unknown): value is AgentShow {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !/^[0-9a-f]{12}$/.test(value.id) ||
    !(value.session === null || typeof value.session === 'string') ||
    !(value.title === null || typeof value.title === 'string') ||
    typeof value.createdAt !== 'string'
  ) {
    return false
  }
  if (value.kind === 'files') {
    return (
      Array.isArray(value.paths) &&
      value.paths.length > 0 &&
      value.paths.every(
        (path) => typeof path === 'string' && path.startsWith('/'),
      )
    )
  }
  return (
    value.kind === 'url' &&
    typeof value.url === 'string' &&
    /^https?:\/\//i.test(value.url)
  )
}

function parseShows(value: unknown): AgentShow[] {
  if (
    !isRecord(value) ||
    !Array.isArray(value.shows) ||
    value.shows.length > MAX_SHOWS
  ) {
    throw new Error('Invalid shared items')
  }
  const items: unknown[] = value.shows
  if (!items.every(isShow)) throw new Error('Invalid shared item')
  return items
}

function fetchShows(since?: string, signal?: AbortSignal) {
  return apiFetch<unknown>(`/api/shows${since ? `?since=${since}` : ''}`, {
    signal,
    cache: 'no-store',
  }).then(parseShows)
}

/** Take one share out of Files > Shared; a refusal throws with the server's reason. */
export function removeShow(id: string) {
  return apiFetch<unknown>(`/api/shows/${id}`, { method: 'DELETE' })
}

function readSeenAt(): string | null {
  try {
    return window.localStorage.getItem(SEEN_KEY)
  } catch {
    return null
  }
}

function writeSeenAt(value: string): void {
  try {
    window.localStorage.setItem(SEEN_KEY, value)
  } catch {
    // Without storage, shares made while the app was closed just don't pop up.
  }
}

/**
 * New shares, one notice at a time. On opening the app, the few made since it
 * was last open pop up too; a push link (`?show=<id>`) opens its share in Files.
 */
export function useAgentShows() {
  const [pending, setPending] = useState<AgentShow[]>([])
  const cursor = useRef<string | undefined>(undefined)

  useEffect(() => {
    const controller = new AbortController()
    let polling = false
    let requested = new URLSearchParams(window.location.search).get('show')

    async function poll() {
      if (document.visibilityState !== 'visible' || polling) return
      polling = true
      try {
        const first = cursor.current === undefined
        const items = await fetchShows(cursor.current, controller.signal)
        if (controller.signal.aborted) return
        const last = items.at(-1)
        if (last) cursor.current = last.id
        else if (first) cursor.current = ''
        const seenAt = readSeenAt()
        // Only shares newer than any seen before: an expired cursor lists everything again.
        let fresh = items.filter((item) =>
          seenAt === null ? !first : item.createdAt > seenAt,
        )
        if (first) fresh = fresh.slice(-MAX_CATCH_UP)
        if (last && (!seenAt || last.createdAt > seenAt))
          writeSeenAt(last.createdAt)
        const asked = requested
          ? items.find((item) => item.id === requested)
          : undefined
        if (asked) {
          requested = null
          if (openFiles({ kind: 'shared', showId: asked.id }))
            fresh = fresh.filter((item) => item !== asked)
          else fresh = [asked, ...fresh.filter((item) => item !== asked)]
        }
        if (fresh.length) setPending((queue) => [...queue, ...fresh].slice(-20))
      } catch {
        // Retry on the next visible-page poll.
      } finally {
        polling = false
      }
    }

    void poll()
    const timer = window.setInterval(() => void poll(), 10_000)
    const onVisibility = () => void poll()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      controller.abort()
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  const dismiss = useCallback(() => setPending((queue) => queue.slice(1)), [])
  return { show: pending[0], dismiss }
}

/** Everything agents shared, oldest first, kept fresh (what Files > Shared lists). */
export function useShareList() {
  return useQuery<AgentShow[]>({
    queryKey: ['agent-shows', 'all'],
    queryFn: ({ signal }) => fetchShows(undefined, signal),
    refetchInterval: 10_000,
  })
}

function readOpenedAt(): string | null {
  try {
    return window.localStorage.getItem(OPENED_KEY)
  } catch {
    return null
  }
}

function writeOpenedAt(value: string): void {
  try {
    window.localStorage.setItem(OPENED_KEY, value)
  } catch {
    // Without storage the mark just stays off: nothing is claimed new.
  }
}

/** How many shares came since Files > Shared was last open: the number on its button. `viewing` is
 * true while Shared is on screen, which counts everything as seen. A first visit starts from now:
 * the shares already there are not new. */
export function useNewShares(viewing: boolean): number {
  const list = useShareList()
  const [openedAt, setOpenedAt] = useState<string | null>(null)
  useEffect(() => setOpenedAt(readOpenedAt()), [])
  const newest = list.data?.at(-1)?.createdAt ?? null
  useEffect(() => {
    if (!list.data) return
    const stored = readOpenedAt()
    if (stored !== null && !viewing) return
    const mark =
      newest && (stored === null || newest > stored)
        ? newest
        : (stored ?? new Date().toISOString())
    if (mark !== stored) writeOpenedAt(mark)
    setOpenedAt(mark)
  }, [list.data, newest, viewing])
  if (viewing || openedAt === null) return 0
  return (list.data ?? []).filter((share) => share.createdAt > openedAt).length
}
