'use client'

import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../api-fetch'
import { rememberWorkstation } from '../machine-name'
import type { StatusView } from '../status'
import { useClock } from './use-clock'

/** Rows report every few minutes; the page and the badge read them this often. */
const STATUS_POLL_MS = 30_000
export const STATUS_QUERY_KEY = ['status']
/** A view read longer ago than this is old, whatever the reason (a sleeping tab, say). */
const STATUS_OLD_MS = 3 * STATUS_POLL_MS

/**
 * GET /api/status, shared by the Status page and the sidebar badge. `stale` is a view kept from
 * an earlier read while the latest one failed; `failed` is no view at all.
 */
export function useStatus() {
  const now = useClock(STATUS_POLL_MS)
  const query = useQuery({
    queryKey: STATUS_QUERY_KEY,
    queryFn: () =>
      apiFetch<StatusView>('/api/status', undefined, 'Couldn’t load status'),
    refetchInterval: STATUS_POLL_MS,
    refetchOnWindowFocus: true,
    retry: 1,
  })
  const view = query.data ?? null
  rememberWorkstation(view?.machine)
  return {
    view,
    loading: query.isPending,
    failed: !view && query.isError,
    stale: !!view && query.isError,
    /** Read longer ago than STATUS_OLD_MS: the badge shows its count muted. */
    old:
      !!view &&
      !!query.dataUpdatedAt &&
      now - query.dataUpdatedAt > STATUS_OLD_MS,
    /** When the shown view was read (ms). */
    readAt: query.dataUpdatedAt || null,
    failedAt: query.errorUpdatedAt || null,
    refetch: query.refetch,
    refreshing: query.isFetching,
  }
}
