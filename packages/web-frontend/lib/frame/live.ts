'use client'

// What the server knows about the sessions that are running now: the agent's
// own state and when its transcript was last written (`/api/history/live`).
// Recent reads it so a running session is never listed as finished, and the
// session rows read it for "working, quiet N min". Silence is shown, never
// treated as death: only the owner ends a session.

import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { apiFetch } from '../api-fetch'

export interface LiveSession {
  /** The Tether session. */
  session: string
  /** Its newest conversation (a history id), or null before it has one. */
  conversation: string | null
  activity: 'working' | 'idle' | 'blocked' | 'unknown'
  /** The agent's last transcript write (ms), or null when it couldn't be read. */
  lastWriteAt: number | null
}

const LIVE_QUERY_KEY = ['history', 'live'] as const
const LIVE_POLL_MS = 15_000

/** A working session that has written nothing for this long is called quiet. */
const QUIET_MINUTES = 10

export function useLiveSessions() {
  const query = useQuery({
    queryKey: LIVE_QUERY_KEY,
    queryFn: () =>
      apiFetch<{ items: LiveSession[] }>(
        '/api/history/live',
        undefined,
        'Couldn’t read the running sessions',
      ),
    refetchInterval: LIVE_POLL_MS,
    refetchOnWindowFocus: true,
    retry: 1,
  })
  const items = query.data?.items ?? null
  return useMemo(() => {
    const bySession = new Map((items ?? []).map((item) => [item.session, item]))
    const conversations = new Set(
      (items ?? []).flatMap((item) =>
        item.conversation ? [item.conversation] : [],
      ),
    )
    return {
      /** null until the first read; unknown is not "nothing is running". */
      items,
      bySession,
      conversations,
      failed: !items && query.isError,
      stale: !!items && query.isError,
    }
  }, [items, query.isError])
}

/** Minutes a working session has been quiet, or null when it isn't (or can't be known). */
export function quietMinutes(
  live: Pick<LiveSession, 'activity' | 'lastWriteAt'> | undefined,
  now: number,
): number | null {
  if (!live || live.activity !== 'working' || live.lastWriteAt === null)
    return null
  const minutes = Math.floor((now - live.lastWriteAt) / 60_000)
  return minutes >= QUIET_MINUTES ? minutes : null
}
