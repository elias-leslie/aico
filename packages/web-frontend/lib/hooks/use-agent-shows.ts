'use client'

import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api-fetch'

type ShowMetadata = {
  id: string
  session: string | null
  title: string | null
  createdAt: string
  /** The linked host that shared it; absent: this computer. Its files are on that host. */
  host?: string
}

/** An agent's share: links to files or folders where they are, or a web link. */
type AgentShow = ShowMetadata &
  ({ kind: 'files'; paths: string[] } | { kind: 'url'; url: string })

/** The most shares the server lists. */
const MAX_SHOWS = 200

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

function fetchShows(signal?: AbortSignal) {
  return apiFetch<unknown>('/api/shows', { signal, cache: 'no-store' }).then(
    parseShows,
  )
}

/** Take one share out of Files > Shared; a refusal throws with the server's reason. */
export function removeShow(id: string) {
  return apiFetch<unknown>(`/api/shows/${id}`, { method: 'DELETE' })
}

/** Everything agents shared, oldest first, kept fresh (what Files > Shared lists). */
export function useShareList() {
  return useQuery<AgentShow[]>({
    queryKey: ['agent-shows', 'all'],
    queryFn: ({ signal }) => fetchShows(signal),
    refetchInterval: 10_000,
  })
}
