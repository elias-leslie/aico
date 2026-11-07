'use client'

import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../api-fetch'
import type { BackupEntry } from '../backups'

const BACKUPS_POLL_MS = 60_000

/**
 * GET /api/backups for the Panel's glance: every copy of every source. `entries` is null while
 * unread, never an empty list standing in for unknown; `stale` keeps the last list while a read fails.
 */
export function useBackups() {
  const query = useQuery({
    queryKey: ['backups', 'glance'],
    queryFn: () =>
      apiFetch<{ entries: BackupEntry[] }>(
        '/api/backups',
        undefined,
        'Couldn’t read backups',
      ),
    refetchInterval: BACKUPS_POLL_MS,
    refetchOnWindowFocus: true,
    retry: 1,
  })
  const entries = query.data?.entries ?? null
  return {
    entries,
    loading: query.isPending,
    failed: !entries && query.isError,
    stale: !!entries && query.isError,
  }
}
