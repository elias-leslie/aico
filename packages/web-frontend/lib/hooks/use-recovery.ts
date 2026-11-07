'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../api-fetch'
import type { RecoveryView, ResumeAnswer } from '../recovery'

const RECOVERY_QUERY_KEY = ['recovery']
const IDLE_POLL_MS = 30_000
/** While something is waiting or just resumed, the page watches it come back. */
const BUSY_POLL_MS = 5_000

/** GET /api/recovery, and POST /api/recovery/resume (everything waiting on the owner). */
export function useRecovery() {
  const client = useQueryClient()
  const query = useQuery({
    queryKey: RECOVERY_QUERY_KEY,
    queryFn: () =>
      apiFetch<RecoveryView>(
        '/api/recovery',
        { cache: 'no-store' },
        'Couldn’t check on stopped sessions',
      ),
    refetchInterval: (q) =>
      q.state.data?.items.some((item) => item.outcome === 'waiting')
        ? BUSY_POLL_MS
        : IDLE_POLL_MS,
    refetchOnWindowFocus: true,
    retry: 1,
  })
  const resume = useMutation({
    mutationFn: () =>
      apiFetch<ResumeAnswer>(
        '/api/recovery/resume',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        },
        'Couldn’t resume',
      ),
    onSettled: () => client.invalidateQueries({ queryKey: RECOVERY_QUERY_KEY }),
  })
  const view = query.data ?? null
  return {
    view,
    loading: query.isPending,
    failed: !view && query.isError,
    stale: !!view && query.isError,
    readAt: query.dataUpdatedAt || null,
    refetch: query.refetch,
    refreshing: query.isFetching,
    resume,
  }
}
