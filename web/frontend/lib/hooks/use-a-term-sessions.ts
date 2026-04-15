'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { apiFetch } from '../api-fetch'

export interface ATermSession {
  id: string
  name: string
  user_id: string | null
  project_id: string | null
  working_dir: string | null
  mode: string
  display_order: number
  is_alive: boolean
  created_at: string | null
  last_accessed_at: string | null
  agent_state?: 'not_started' | 'starting' | 'running' | 'stopped' | 'error'
  claude_state?: 'not_started' | 'starting' | 'running' | 'stopped' | 'error'
  tmux_session_name?: string | null
  tmux_pane_id?: string | null
  is_external?: boolean
  source?: string | null
}

interface SessionListResponse {
  items: ATermSession[]
  total: number
}

interface UseATermSessionsOptions {
  includeDetached?: boolean
}

interface UpdateSessionRequest {
  name?: string
  display_order?: number
}

export interface DeleteSessionResult {
  deleted: boolean
  id: string
  next_session_id: string | null
  pane_id: string | null
  pane_deleted: boolean
  is_external: boolean
}

const jsonHeaders = { 'Content-Type': 'application/json' }

const fetchSessions = async (
  includeDetached = false,
): Promise<ATermSession[]> => {
  const params = new URLSearchParams()
  if (includeDetached) {
    params.set('include_detached', 'true')
  }
  const query = params.toString()
  const path = query ? `/api/a-term/sessions?${query}` : '/api/a-term/sessions'
  return (await apiFetch<SessionListResponse>(path)).items
}

const updateSession = (sessionId: string, req: UpdateSessionRequest) =>
  apiFetch<ATermSession>(`/api/a-term/sessions/${sessionId}`, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify(req),
  })

const deleteSession = (sessionId: string) =>
  apiFetch<DeleteSessionResult>(`/api/a-term/sessions/${sessionId}`, {
    method: 'DELETE',
  })

const resetSession = (sessionId: string) =>
  apiFetch<ATermSession>(`/api/a-term/sessions/${sessionId}/reset`, {
    method: 'POST',
  })

const resetAllSessions = () =>
  apiFetch<{ reset_count: number }>('/api/a-term/reset-all', { method: 'POST' })

const invalidatePanesAndSessions = (
  queryClient: ReturnType<typeof useQueryClient>,
) => {
  queryClient.invalidateQueries({ queryKey: ['a-term-panes'] })
  queryClient.invalidateQueries({ queryKey: ['a-term-sessions'] })
}

/** Hook for managing aTerm sessions with backend sync */
export function useATermSessions(options: UseATermSessionsOptions = {}) {
  const { includeDetached = false } = options
  const queryClient = useQueryClient()
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['a-term-sessions'] })

  const {
    data: sessions = [],
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: ['a-term-sessions', includeDetached],
    queryFn: () => fetchSessions(includeDetached),
  })

  const updateMutation = useMutation({
    mutationFn: ({
      sessionId,
      ...request
    }: UpdateSessionRequest & { sessionId: string }) =>
      updateSession(sessionId, request),
    onSuccess: invalidate,
  })

  const deleteMutation = useMutation({
    mutationFn: deleteSession,
    onSuccess: () => invalidatePanesAndSessions(queryClient),
  })

  const resetMutation = useMutation({
    mutationFn: resetSession,
    onMutate: async (oldSessionId) => {
      await queryClient.cancelQueries({ queryKey: ['a-term-sessions'] })
      return {
        oldSessionId,
        previousSessions: queryClient.getQueryData<ATermSession[]>([
          'a-term-sessions',
        ]),
      }
    },
    onSuccess: (newSession, oldSessionId) => {
      queryClient.setQueryData<ATermSession[]>(['a-term-sessions'], (old) =>
        old
          ? [...old.filter((s) => s.id !== oldSessionId), newSession]
          : [newSession],
      )
    },
    onError: (_err, _oldSessionId, ctx) =>
      ctx?.previousSessions &&
      queryClient.setQueryData(['a-term-sessions'], ctx.previousSessions),
    onSettled: invalidate,
  })

  const resetAllMutation = useMutation({
    mutationFn: resetAllSessions,
    onSuccess: () => invalidatePanesAndSessions(queryClient),
  })

  const update = useCallback(
    (sessionId: string, updates: UpdateSessionRequest) =>
      updateMutation.mutateAsync({ sessionId, ...updates }),
    [updateMutation],
  )

  const remove = useCallback(
    (sessionId: string) => deleteMutation.mutateAsync(sessionId),
    [deleteMutation],
  )

  const reset = useCallback(
    (sessionId: string) => resetMutation.mutateAsync(sessionId),
    [resetMutation],
  )

  const resetAll = useCallback(
    () => resetAllMutation.mutateAsync(),
    [resetAllMutation],
  )

  return {
    sessions,
    update,
    remove,
    reset,
    resetAll,
    isLoading,
    isError,
    error,
    isDeleting: deleteMutation.isPending,
    isResetting: resetMutation.isPending || resetAllMutation.isPending,
  }
}
