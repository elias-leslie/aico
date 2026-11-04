'use client'

import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../api-fetch'
import type { StatusView } from '../status'

/** Rows report every few minutes; the page and the badge read them this often. */
export const STATUS_POLL_MS = 30_000
export const STATUS_QUERY_KEY = ['status']

/**
 * GET /api/status, shared by the Status page and the sidebar badge. `stale` is a view kept from
 * an earlier read while the latest one failed; `failed` is no view at all.
 */
export function useStatus() {
  const query = useQuery({
    queryKey: STATUS_QUERY_KEY,
    queryFn: () =>
      apiFetch<StatusView>('/api/status', undefined, 'Couldn’t load status'),
    refetchInterval: STATUS_POLL_MS,
    refetchOnWindowFocus: true,
    retry: 1,
  })
  const view = query.data ?? null
  return {
    view,
    loading: query.isPending,
    failed: !view && query.isError,
    stale: !!view && query.isError,
    /** When the shown view was read (ms). */
    readAt: query.dataUpdatedAt || null,
    failedAt: query.errorUpdatedAt || null,
    refetch: query.refetch,
    refreshing: query.isFetching,
  }
}
