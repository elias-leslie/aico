'use client'

import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../api-fetch'
import type { NightshiftViewResult } from '../health'

/** How often the pill re-reads Nightshift's view (its checks run every few minutes). */
export const HEALTH_POLL_MS = 60_000

/** Nightshift's owner view, read through the web server. */
export function useHealth() {
  const query = useQuery({
    queryKey: ['nightshift-view'],
    queryFn: () =>
      apiFetch<NightshiftViewResult>(
        '/api/nightshift/view',
        undefined,
        'Couldn’t load health',
      ),
    staleTime: 30_000,
    refetchInterval: HEALTH_POLL_MS,
  })
  return {
    result: query.data,
    isLoading: query.isLoading,
    // A failed refresh after a good read still counts: the old view is not current.
    isError: query.isError,
    refetch: query.refetch,
  }
}
