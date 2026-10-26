'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../api-fetch'

/** What the session menu's "Check in later" shows. `unsupported`: Aico cannot
 * tell when this session is idle (a shell, say), so it cannot check in. */
export interface CheckInMenu {
  status: 'ready' | 'unsupported'
  choices: { label: string; time: string; dueAt: number }[]
  pending: { id: string; time: string; dueAt: number }[]
}

/** A check-in kept past its session's End; it starts a new session when due. */
export interface KeptCheckIn {
  id: string
  dueAt: number
  time: string
  /** `Project — Task` of the ended session. */
  session: string
  /** The last restart failed. */
  failed: boolean
}

const KEPT_REFRESH_MS = 15_000

export function useCheckInMenu(sessionId: string) {
  return useQuery({
    queryKey: ['check-in-menu', sessionId],
    queryFn: () =>
      apiFetch<CheckInMenu>(
        `/api/sessions/${sessionId}/check-ins`,
        undefined,
        'Could not load check-in times',
      ),
    // The quick choices are times from now: never reuse a stale answer.
    gcTime: 0,
    retry: false,
  })
}

/** Set and cancel check-ins; the session list picks the change up at once. */
export function useCheckInActions(sessionId?: string) {
  const queryClient = useQueryClient()
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['terminal-panes'] })
    queryClient.invalidateQueries({ queryKey: ['terminal-sessions'] })
    queryClient.invalidateQueries({ queryKey: ['kept-check-ins'] })
    if (sessionId)
      queryClient.invalidateQueries({ queryKey: ['check-in-menu', sessionId] })
  }
  const set = useMutation({
    mutationFn: (dueAt: number) =>
      apiFetch<{ id: string; dueAt: number; time: string }>(
        `/api/sessions/${sessionId}/check-ins`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dueAt }),
        },
        'Could not set the check-in',
      ),
    onSuccess: refresh,
  })
  const cancel = useMutation({
    mutationFn: (wakeId: string) =>
      apiFetch<{ deleted: true }>(
        `/api/check-ins/${wakeId}`,
        { method: 'DELETE' },
        'Could not cancel the check-in',
      ),
    onSuccess: refresh,
  })
  return { set, cancel }
}

export function useKeptCheckIns() {
  return useQuery({
    queryKey: ['kept-check-ins'],
    queryFn: async () =>
      (
        await apiFetch<{ items: KeptCheckIn[] }>(
          '/api/check-ins/kept',
          undefined,
          'Could not load kept check-ins',
        )
      ).items,
    refetchInterval: KEPT_REFRESH_MS,
    refetchOnWindowFocus: true,
  })
}

/** `5:30 PM and Tue 9:00 AM`, for the End dialog. */
export function timesLabel(times: string[]): string {
  return times.length > 1
    ? `${times.slice(0, -1).join(', ')} and ${times.at(-1)}`
    : (times[0] ?? '')
}
