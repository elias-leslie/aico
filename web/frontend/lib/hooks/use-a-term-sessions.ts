'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { apiFetch } from '../api-fetch'
import type { CoordinatorFields } from '../utils/coordinator-badge'

/**
 * A session as A-Term lists it (the backend's ATermSessionResponse, used by
 * the Sessions and Panes APIs alike). Ids are Tether's 8-hex session ids; an
 * Own tmux session (`source: 'tmux_external'`) keeps its tmux session name.
 *
 * What the UI may offer comes from `can_*`; `source`, `is_root` and
 * `is_external` are informational.
 */
export interface ATermSession extends CoordinatorFields {
  id: string
  /** `Project — Task`, the title Aico shows; `task` is Tether's name alone. */
  name: string
  user_id: string | null
  project_id: string | null
  working_dir: string | null
  mode: string
  display_order: number
  session_number?: number
  is_alive: boolean
  created_at: string | null
  last_accessed_at: string | null
  agent_state?: 'not_started' | 'starting' | 'running' | 'stopped' | 'error'
  claude_state?: 'not_started' | 'starting' | 'running' | 'stopped' | 'error'
  tmux_session_name?: string | null
  tmux_pane_id?: string | null
  tmux_socket?: string | null
  tmux_source?: string | null
  tmux_source_label?: string | null
  is_external?: boolean
  is_root?: boolean
  source?: string | null
  /** The app that created the session in Tether ('a-term', 'aico', ...). */
  origin?: string | null
  /** Tether status: running | pending | uncertain. */
  status?: string | null
  generation?: string | null
  /** The A-Term pane this session belongs to, if any. */
  pane_id?: string | null
  /** Tether's agent state (tether docs/agent-state.md). */
  activity?: 'working' | 'idle' | 'blocked' | 'unknown'
  activity_previous?: 'working' | 'idle' | 'blocked' | 'unknown'
  /** When the activity began (ms since the epoch). */
  activity_at?: number | null
  /** Why blocked: `permission prompt`, `input needed`, ... */
  activity_detail?: string | null
  /** The session can be renamed (in Tether). */
  can_rename: boolean
  /** The session can be reset (respawned) or switch tools. */
  can_respawn: boolean
  /** The session can be ended from A-Term. */
  can_end: boolean
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

/** How often the session list (and its agent states) refreshes. */
export const SESSION_REFRESH_MS = 5_000

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
  queryClient.invalidateQueries({ queryKey: ['a-term-detached-panes'] })
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
    // Agent state (needs you, working, ...) changes without any A-Term
    // action, so keep the list fresh while the app is open.
    refetchInterval: SESSION_REFRESH_MS,
    refetchOnWindowFocus: true,
  })

  const updateMutation = useMutation({
    mutationFn: ({
      sessionId,
      ...request
    }: UpdateSessionRequest & { sessionId: string }) =>
      updateSession(sessionId, request),
    onSuccess: () => invalidatePanesAndSessions(queryClient),
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
