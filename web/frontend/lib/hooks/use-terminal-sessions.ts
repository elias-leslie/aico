'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { apiFetch } from '../api-fetch'
import type { CoordinatorFields } from '../utils/coordinator-badge'

/**
 * A session as the web app lists it (the server's session response, used by
 * the Sessions and Panes APIs alike). Ids are Tether's 8-hex session ids; an
 * Own tmux session (`source: 'tmux_external'`) keeps its tmux session name.
 *
 * What the UI may offer comes from `can_*`; `source`, `is_root` and
 * `is_external` are informational.
 */
/** A pending check-in; `time` reads `5:30 PM`, with the weekday when not today. */
export interface SessionCheckIn {
  id: string
  due_at: number
  time: string
}

export interface SessionAsk {
  id: string
  question: string
  blocking: boolean
  created_at: number
}

export interface TerminalSession extends CoordinatorFields {
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
  /** Pending check-ins, oldest first. */
  check_ins?: SessionCheckIn[]
  /** Open owner asks from this session, oldest first; a blocking one means it needs the owner. */
  asks?: SessionAsk[]
  source?: string | null
  /** The app that created the session in Tether ('a-term', 'aico', ...). */
  origin?: string | null
  /** Tether status: running | pending | uncertain. */
  status?: string | null
  generation?: string | null
  /** The web app pane this session belongs to, if any. */
  pane_id?: string | null
  /** Tether's agent state (tether docs/agent-state.md). */
  activity?: 'working' | 'idle' | 'blocked' | 'unknown'
  activity_previous?: 'working' | 'idle' | 'blocked' | 'unknown'
  /** When the activity began (ms since the epoch). */
  activity_at?: number | null
  /** Why blocked: `permission prompt`, `input needed`, ... */
  activity_detail?: string | null
  /** When the owner last had it open on any device (ms, the server's clock). */
  seen_at?: number | null
  /** The session can be renamed (in Tether). */
  can_rename: boolean
  /** The session can be reset (respawned) or switch tools. */
  can_respawn: boolean
  /** The session can be ended from the web app. */
  can_end: boolean
  /** `agent-hub`: a chat on an Agent Hub agent, shown as a chat, not a terminal. */
  backend?: 'agent-hub' | null
  /** The remote host the session runs on; null on this computer. */
  host?: string | null
  /** Set while that host cannot be reached (`offline`, `connecting`, ...). */
  peer?: { state: string; since: number } | null
}

interface SessionListResponse {
  items: TerminalSession[]
  total: number
}

interface UseTerminalSessionsOptions {
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
): Promise<TerminalSession[]> => {
  const params = new URLSearchParams()
  if (includeDetached) {
    params.set('include_detached', 'true')
  }
  const query = params.toString()
  const path = query ? `/api/sessions?${query}` : '/api/sessions'
  return (await apiFetch<SessionListResponse>(path)).items
}

const updateSession = (sessionId: string, req: UpdateSessionRequest) =>
  apiFetch<TerminalSession>(`/api/sessions/${sessionId}`, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify(req),
  })

export interface EndSessionRequest {
  sessionId: string
  /** "End, keep check-in": its check-ins outlive the session. */
  keepCheckIns?: boolean
}

const deleteSession = ({ sessionId, keepCheckIns }: EndSessionRequest) =>
  apiFetch<DeleteSessionResult>(
    `/api/sessions/${sessionId}${keepCheckIns ? '?keepWakes=true' : ''}`,
    { method: 'DELETE' },
  )

const resetSession = (sessionId: string) =>
  apiFetch<TerminalSession>(`/api/sessions/${sessionId}/reset`, {
    method: 'POST',
  })

const resetAllSessions = () =>
  apiFetch<{ reset_count: number }>('/api/reset-all', { method: 'POST' })

const invalidatePanesAndSessions = (
  queryClient: ReturnType<typeof useQueryClient>,
) => {
  queryClient.invalidateQueries({ queryKey: ['terminal-panes'] })
  queryClient.invalidateQueries({ queryKey: ['terminal-detached-panes'] })
  queryClient.invalidateQueries({ queryKey: ['terminal-sessions'] })
}

/** Hook for managing terminal sessions with backend sync */
export function useTerminalSessions(options: UseTerminalSessionsOptions = {}) {
  const { includeDetached = false } = options
  const queryClient = useQueryClient()
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['terminal-sessions'] })

  const {
    data: sessions = [],
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: ['terminal-sessions', includeDetached],
    queryFn: () => fetchSessions(includeDetached),
    // Agent state (needs you, working, ...) changes without any web app
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
    onSuccess: (_result, { sessionId }) => {
      // Unlisted at once: until the refetch lands, the ended session would
      // still be found as the one this browser had open and shown again.
      queryClient.setQueriesData<TerminalSession[]>(
        { queryKey: ['terminal-sessions'] },
        (old) => old?.filter((session) => session.id !== sessionId),
      )
      invalidatePanesAndSessions(queryClient)
      // A kept check-in outlives the session it was set on.
      queryClient.invalidateQueries({ queryKey: ['kept-check-ins'] })
    },
  })

  const resetMutation = useMutation({
    mutationFn: resetSession,
    onMutate: async (oldSessionId) => {
      await queryClient.cancelQueries({ queryKey: ['terminal-sessions'] })
      return {
        oldSessionId,
        previousSessions: queryClient.getQueryData<TerminalSession[]>([
          'terminal-sessions',
        ]),
      }
    },
    onSuccess: (newSession, oldSessionId) => {
      queryClient.setQueryData<TerminalSession[]>(
        ['terminal-sessions'],
        (old) =>
          old
            ? [...old.filter((s) => s.id !== oldSessionId), newSession]
            : [newSession],
      )
    },
    onError: (_err, _oldSessionId, ctx) =>
      ctx?.previousSessions &&
      queryClient.setQueryData(['terminal-sessions'], ctx.previousSessions),
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
    (sessionId: string, options: { keepCheckIns?: boolean } = {}) =>
      deleteMutation.mutateAsync({ sessionId, ...options }),
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
