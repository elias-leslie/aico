'use client'

import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../api-fetch'
import type { UsageReport } from '../quota-usage'

const USAGE_POLL_MS = 60_000
const USAGE_QUERY_KEY = ['usage']

/**
 * GET /api/usage: the one read of the providers' windows, shared by the Quota page, the Panel's
 * quota bars and the side's glance, so they all show the same numbers.
 */
export function useUsage() {
  const query = useQuery({
    queryKey: USAGE_QUERY_KEY,
    queryFn: () =>
      apiFetch<UsageReport>('/api/usage', undefined, 'Aico did not answer'),
    refetchInterval: USAGE_POLL_MS,
    refetchOnWindowFocus: true,
    retry: 1,
  })
  const report = query.data ?? null
  return {
    query,
    report,
    loading: query.isPending,
    failed: !report && query.isError,
    /** A report kept from an earlier read while the latest one failed. */
    stale: !!report && query.isError,
  }
}
