'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../api-fetch'
import type { Routine } from '../routines'

const ROUTINES_QUERY_KEY = ['routines']
const POLL_MS = 30_000
/** While one is running, or a Run now is on its way, the list is read this often. */
const BUSY_POLL_MS = 4_000

export type RoutineAction = 'run' | 'pause' | 'resume'

/** GET /api/routines: every routine, read often while one is running. */
export function useRoutines() {
  const query = useQuery({
    queryKey: ROUTINES_QUERY_KEY,
    queryFn: async () =>
      (
        await apiFetch<{ routines: Routine[] }>(
          '/api/routines',
          undefined,
          'Couldn’t load routines',
        )
      ).routines,
    refetchInterval: (q) =>
      q.state.data?.some((routine) => routine.running) ? BUSY_POLL_MS : POLL_MS,
    refetchOnWindowFocus: true,
    retry: 1,
  })
  return {
    routines: query.data ?? null,
    loading: query.isPending,
    failed: !query.data && query.isError,
    stale: !!query.data && query.isError,
    error: query.error instanceof Error ? query.error.message : '',
    refetch: query.refetch,
    refreshing: query.isFetching,
  }
}

/** Run now, Pause and Resume for one routine at a time; `message` is the server's word or the failure. */
export function useRoutineAction() {
  const client = useQueryClient()
  const mutation = useMutation({
    mutationFn: ({ kind, action }: { kind: string; action: RoutineAction }) =>
      apiFetch<{ message: string }>(
        `/api/routines/${action}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind }),
        },
        'Couldn’t reach Aico',
      ),
    onSettled: async () => {
      await client.invalidateQueries({ queryKey: ROUTINES_QUERY_KEY })
      // Run now is picked up at the scheduler's next tick; read again once it has had it.
      setTimeout(
        () => client.invalidateQueries({ queryKey: ROUTINES_QUERY_KEY }),
        6_000,
      )
    },
  })
  return {
    act: (kind: string, action: RoutineAction) =>
      mutation.mutate({ kind, action }),
    pending: mutation.isPending ? mutation.variables : null,
    error: mutation.isError ? mutation.error.message : '',
    failedFor: mutation.isError ? mutation.variables : null,
    done: mutation.isSuccess ? mutation.variables : null,
  }
}

export interface RoutineLog {
  ok: boolean
  truncated: boolean
  lines: string[]
}

/** The last lines of a routine's output (its Status row's log command). */
export function readRoutineLog(kind: string): Promise<RoutineLog> {
  return apiFetch<RoutineLog>(
    '/api/status/log',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: `jobs/${kind}` }),
    },
    'Couldn’t read the log',
  )
}
