'use client'

import { useQuery } from '@tanstack/react-query'
import { apiFetch, isPermanentRefusal } from '../api-fetch'
import type {
  HistoryDetail,
  HistoryEventPage,
  HistorySearchPage,
  HistorySession,
} from '../history'

const HISTORY_POLL_MS = 30_000
/** Ask once more after a failure, unless the answer was a refusal that asking again won't change. */
const retryOnce = (count: number, error: unknown) =>
  count < 1 && !isPermanentRefusal(error)
const EVENTS_PAGE = 100
/** How many of the newest sessions the list reads; a full page isn't the whole history. */
export const HISTORY_PAGE = 100

/** GET /api/history: recent sessions, newest first. `stale` keeps the last list while a read fails. */
export function useHistory(tool: string) {
  const query = useQuery({
    queryKey: ['history', tool],
    queryFn: () =>
      apiFetch<{ items: HistorySession[] }>(
        `/api/history?limit=${HISTORY_PAGE}${tool ? `&tool=${encodeURIComponent(tool)}` : ''}`,
        undefined,
        'Couldn’t load recent sessions',
      ),
    refetchInterval: HISTORY_POLL_MS,
    refetchOnWindowFocus: true,
    retry: retryOnce,
  })
  const items = query.data?.items ?? null
  return {
    items,
    loading: query.isPending,
    failed: !items && query.isError,
    error: query.error as Error | null,
    stale: !!items && query.isError,
    readAt: query.dataUpdatedAt || null,
    failedAt: query.errorUpdatedAt || null,
    refetch: query.refetch,
    refreshing: query.isFetching,
  }
}

/** One session's totals. */
export function useHistorySession(id: string) {
  return useQuery({
    queryKey: ['history', 'session', id],
    queryFn: () =>
      apiFetch<HistoryDetail>(
        `/api/history/${encodeURIComponent(id)}`,
        undefined,
        'Couldn’t load this session',
      ),
    retry: retryOnce,
  })
}

/** The newest events of a session; older ones come through `eventsBefore`. */
export function useHistoryEvents(id: string) {
  return useQuery({
    queryKey: ['history', 'events', id],
    queryFn: () => eventsBefore(id),
    retry: retryOnce,
  })
}

export function eventsBefore(
  id: string,
  before?: number,
): Promise<HistoryEventPage> {
  const query = new URLSearchParams({ limit: String(EVENTS_PAGE) })
  if (before !== undefined) query.set('before', String(before))
  return apiFetch<HistoryEventPage>(
    `/api/history/${encodeURIComponent(id)}/events?${query}`,
    undefined,
    'Couldn’t load the transcript',
  )
}

/** GET /api/history/search: the conversations whose messages contain `text` (two or more characters). */
export function useHistorySearch(text: string, tool: string) {
  const query = text.trim()
  return useQuery({
    queryKey: ['history', 'search', query, tool],
    enabled: query.length >= 2,
    // The signal ends the request when the text changes or the page goes: the server stops reading.
    queryFn: ({ signal }) =>
      apiFetch<HistorySearchPage>(
        `/api/history/search?q=${encodeURIComponent(query)}&limit=30${tool ? `&tool=${encodeURIComponent(tool)}` : ''}`,
        { signal },
        'Couldn’t search the sessions',
      ),
    staleTime: 60_000,
    retry: retryOnce,
  })
}

/** The one event at a byte offset (a search hit), for the transcript to open on. */
export function useHistoryEventAt(id: string, at: number | null) {
  return useQuery({
    queryKey: ['history', 'event-at', id, at],
    enabled: at !== null,
    queryFn: () =>
      apiFetch<HistoryEventPage>(
        `/api/history/${encodeURIComponent(id)}/events?limit=1&from=${at}`,
        undefined,
        'Couldn’t load the matching message',
      ),
    retry: retryOnce,
  })
}
