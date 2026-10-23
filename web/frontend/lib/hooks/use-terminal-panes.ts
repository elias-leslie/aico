'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { paneSessionsAsSessions } from '@/lib/utils/slot'
import * as api from './terminal-panes-api'
import type {
  PaneListResponse,
  PanePlacementOptions,
  TerminalPane,
  UpdatePaneRequest,
} from './terminal-panes-types'
import {
  SESSION_REFRESH_MS,
  type TerminalSession,
} from './use-terminal-sessions'

const ACTIVE_PANES_QUERY_KEY = ['terminal-panes']
const DETACHED_PANES_QUERY_KEY = ['terminal-detached-panes']
const SESSIONS_QUERY_KEY = ['terminal-sessions']
const ACTIVE_SESSIONS_QUERY_KEY = ['terminal-sessions', false]
const ALL_SESSIONS_QUERY_KEY = ['terminal-sessions', true]

const invalidatePanesAndSessions = (qc: ReturnType<typeof useQueryClient>) => {
  qc.invalidateQueries({ queryKey: ACTIVE_PANES_QUERY_KEY })
  qc.invalidateQueries({ queryKey: DETACHED_PANES_QUERY_KEY })
  qc.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY })
}

const sortPanes = (items: TerminalPane[]) =>
  [...items].sort((a, b) => {
    if (a.pane_order !== b.pane_order) return a.pane_order - b.pane_order
    return (a.created_at ?? '').localeCompare(b.created_at ?? '')
  })

const upsertPane = (
  current: PaneListResponse | undefined,
  pane: TerminalPane,
): PaneListResponse => {
  const existingItems = current?.items ?? []
  const nextItems = existingItems.some((item) => item.id === pane.id)
    ? existingItems.map((item) => (item.id === pane.id ? pane : item))
    : [...existingItems, pane]

  return {
    ...current,
    items: sortPanes(nextItems),
    total: nextItems.length,
  }
}

const removePane = (
  current: PaneListResponse | undefined,
  paneId: string,
): PaneListResponse | undefined => {
  if (!current) return current
  const nextItems = current.items.filter((item) => item.id !== paneId)
  return {
    ...current,
    items: nextItems,
    total: nextItems.length,
  }
}

const syncPaneCaches = (
  qc: ReturnType<typeof useQueryClient>,
  pane: TerminalPane,
) => {
  if (pane.is_detached) {
    qc.setQueryData<PaneListResponse>(ACTIVE_PANES_QUERY_KEY, (current) =>
      removePane(current, pane.id),
    )
    qc.setQueryData<PaneListResponse>(DETACHED_PANES_QUERY_KEY, (current) =>
      upsertPane(current, pane),
    )
    return
  }

  qc.setQueryData<PaneListResponse>(ACTIVE_PANES_QUERY_KEY, (current) =>
    upsertPane(current, pane),
  )
  qc.setQueryData<PaneListResponse>(DETACHED_PANES_QUERY_KEY, (current) =>
    removePane(current, pane.id),
  )
}

const removePaneFromCaches = (
  qc: ReturnType<typeof useQueryClient>,
  paneId: string,
) => {
  qc.setQueryData<PaneListResponse>(ACTIVE_PANES_QUERY_KEY, (current) =>
    removePane(current, paneId),
  )
  qc.setQueryData<PaneListResponse>(DETACHED_PANES_QUERY_KEY, (current) =>
    removePane(current, paneId),
  )
}

const upsertSessions = (
  current: TerminalSession[] | undefined,
  sessions: TerminalSession[],
): TerminalSession[] => {
  const byId = new Map((current ?? []).map((session) => [session.id, session]))
  for (const session of sessions) {
    byId.set(session.id, session)
  }
  return Array.from(byId.values()).sort((a, b) => {
    if (a.display_order !== b.display_order) {
      return a.display_order - b.display_order
    }
    return (a.created_at ?? '').localeCompare(b.created_at ?? '')
  })
}

const removeSessions = (
  current: TerminalSession[] | undefined,
  sessionIds: Set<string>,
): TerminalSession[] | undefined =>
  current?.filter((session) => !sessionIds.has(session.id))

const syncSessionCaches = (
  qc: ReturnType<typeof useQueryClient>,
  pane: TerminalPane,
) => {
  const sessions = paneSessionsAsSessions(pane)
  const sessionIds = new Set(sessions.map((session) => session.id))
  if (pane.is_detached) {
    qc.setQueryData<TerminalSession[]>(ACTIVE_SESSIONS_QUERY_KEY, (current) =>
      removeSessions(current, sessionIds),
    )
  } else {
    qc.setQueryData<TerminalSession[]>(ACTIVE_SESSIONS_QUERY_KEY, (current) =>
      upsertSessions(current, sessions),
    )
  }
  qc.setQueryData<TerminalSession[]>(ALL_SESSIONS_QUERY_KEY, (current) =>
    upsertSessions(current, sessions),
  )
}

const removePaneSessionsFromCaches = (
  qc: ReturnType<typeof useQueryClient>,
  paneId: string,
) => {
  const collectIds = (data: PaneListResponse | undefined) =>
    data?.items
      .find((pane) => pane.id === paneId)
      ?.sessions.map((session) => session.id) ?? []
  const sessionIds = new Set([
    ...collectIds(qc.getQueryData<PaneListResponse>(ACTIVE_PANES_QUERY_KEY)),
    ...collectIds(qc.getQueryData<PaneListResponse>(DETACHED_PANES_QUERY_KEY)),
  ])
  if (sessionIds.size === 0) return
  qc.setQueryData<TerminalSession[]>(ACTIVE_SESSIONS_QUERY_KEY, (current) =>
    removeSessions(current, sessionIds),
  )
  qc.setQueryData<TerminalSession[]>(ALL_SESSIONS_QUERY_KEY, (current) =>
    removeSessions(current, sessionIds),
  )
}

/** Failed and never loaded. React Query puts a query with no data back to
 * pending on every refetch, so isError alone would flicker. */
const failedWithoutData = (query: {
  data: unknown
  errorUpdateCount: number
}) => query.data === undefined && query.errorUpdateCount > 0

/** Whether the session list failed to load, and a way to ask again. */
export function usePaneListError() {
  const query = useQuery({
    queryKey: ACTIVE_PANES_QUERY_KEY,
    queryFn: api.fetchPanes,
    refetchInterval: SESSION_REFRESH_MS,
  })
  return {
    isError: failedWithoutData(query),
    retry: () => void query.refetch(),
  }
}

export function useTerminalPanes() {
  const queryClient = useQueryClient()

  // Pane sessions carry Tether's session names, which Aico can change at any
  // time: refresh at the session list's pace.
  const activeQuery = useQuery({
    queryKey: ACTIVE_PANES_QUERY_KEY,
    queryFn: api.fetchPanes,
    refetchInterval: SESSION_REFRESH_MS,
  })
  const detachedQuery = useQuery({
    queryKey: DETACHED_PANES_QUERY_KEY,
    queryFn: api.fetchDetachedPanes,
    refetchInterval: SESSION_REFRESH_MS,
  })
  const { data, isError, error } = activeQuery
  const detachedData = detachedQuery.data
  const loadFailed =
    failedWithoutData(activeQuery) || failedWithoutData(detachedQuery)

  const panes = data?.items ?? []
  const detachedPanes = detachedData?.items ?? []

  const createMutation = useMutation({
    mutationFn: api.createPane,
    onSuccess: (pane) => {
      syncPaneCaches(queryClient, pane)
      syncSessionCaches(queryClient, pane)
      invalidatePanesAndSessions(queryClient)
    },
  })

  const updateMutation = useMutation({
    mutationFn: ({ paneId, ...req }: UpdatePaneRequest & { paneId: string }) =>
      api.updatePane(paneId, req),
    onSuccess: (pane) => {
      syncPaneCaches(queryClient, pane)
      syncSessionCaches(queryClient, pane)
      invalidatePanesAndSessions(queryClient)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: api.deletePane,
    onSuccess: (_result, paneId) => {
      removePaneSessionsFromCaches(queryClient, paneId)
      removePaneFromCaches(queryClient, paneId)
      invalidatePanesAndSessions(queryClient)
    },
  })

  const createProjectPane = useCallback(
    (
      name: string,
      projectId: string,
      workingDir?: string,
      agentToolSlug?: string,
      options?: PanePlacementOptions,
    ) =>
      createMutation.mutateAsync({
        pane_type: 'project',
        pane_name: name,
        project_id: projectId,
        working_dir: workingDir,
        agent_tool_slug: agentToolSlug,
        detached: options?.detached,
      }),
    [createMutation],
  )

  const setActiveMode = useCallback(
    (paneId: string, mode: string) =>
      updateMutation.mutateAsync({ paneId, active_mode: mode }),
    [updateMutation],
  )

  const renamePane = useCallback(
    (paneId: string, newName: string) =>
      updateMutation.mutateAsync({ paneId, pane_name: newName }),
    [updateMutation],
  )

  const removePane = useCallback(
    (paneId: string) => deleteMutation.mutateAsync(paneId),
    [deleteMutation],
  )

  return {
    panes,
    detachedPanes,
    // New sessions are detached panes: a link to one waits for both lists.
    isLoading:
      (activeQuery.isLoading || detachedQuery.isLoading) && !loadFailed,
    loadFailed,
    isError,
    error,
    createProjectPane,
    isCreating: createMutation.isPending,
    setActiveMode,
    renamePane,
    isUpdating: updateMutation.isPending,
    removePane,
    isDeleting: deleteMutation.isPending,
  }
}

export type {
  CreatePaneRequest,
  PanePlacementOptions,
  PaneSession,
  TerminalPane,
  UpdatePaneRequest,
} from './terminal-panes-types'
