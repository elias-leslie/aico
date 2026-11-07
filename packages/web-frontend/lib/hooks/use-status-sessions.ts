'use client'

import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { apiFetch } from '../api-fetch'
import type { SessionInfo } from '../status'
import { useTerminalSessions } from './use-terminal-sessions'

const RECOVERY_POLL_MS = 30_000
export const RECOVERY_QUERY_KEY = ['status-recovery']

interface RecoveryAnswer {
  items: { id: string; resumable: boolean }[]
}

/**
 * The sessions a Status row can name: their names (from the session list the app already keeps) and
 * which ones stopped and wait on Resume (GET /api/recovery). A list that is loading or couldn’t be
 * read gives `names: null`, so an id is never called “ended” on a guess; recovery that can’t be read
 * only leaves Resume out.
 */
export function useStatusSessions(): SessionInfo {
  const { sessions, isLoading, isError } = useTerminalSessions({
    includeDetached: true,
  })
  const recovery = useQuery({
    queryKey: RECOVERY_QUERY_KEY,
    queryFn: () => apiFetch<RecoveryAnswer>('/api/recovery'),
    refetchInterval: RECOVERY_POLL_MS,
    retry: false,
  })
  const unknown = isLoading || (isError && sessions.length === 0)
  return useMemo(
    () => ({
      names: unknown
        ? null
        : new Map(sessions.map((session) => [session.id, session.name])),
      resumable: new Set(
        (recovery.data?.items ?? [])
          .filter((item) => item.resumable)
          .map((item) => item.id),
      ),
    }),
    [unknown, sessions, recovery.data],
  )
}
