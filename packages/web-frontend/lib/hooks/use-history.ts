'use client'

import { useQuery } from '@tanstack/react-query'
import { apiFetch, isPermanentRefusal } from '../api-fetch'
import type {
  HistoryDetail,
  HistoryEventPage,
  HistorySession,
} from '../history'

const HISTORY_POLL_MS = 30_000
/** Ask once more after a failure, unless the answer was a refusal that asking again won't change. */
const retryOnce = (count: number, error: unknown) =>
  count < 1 && !isPermanentRefusal(error)
const EVENTS_PAGE = 100

/** GET /api/history: recent sessions, newest first. `stale` keeps the last list while a read fails. */
export function useHistory(tool: string) {
  const query = useQuery({
    queryKey: ['history', tool],
    queryFn: () =>
      apiFetch<{ items: HistorySession[] }>(
        `/api/history?limit=100${tool ? `&tool=${encodeURIComponent(tool)}` : ''}`,
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
