'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { MAX_PANES } from '@/lib/constants/a-term'
import * as api from './a-term-panes-api'
import type {
  ATermPane,
  AttachPaneRequest,
  PaneListResponse,
  PanePlacementOptions,
  UpdatePaneRequest,
} from './a-term-panes-types'
import type { ATermSession } from './use-a-term-sessions'

const ACTIVE_PANES_QUERY_KEY = ['a-term-panes']
const DETACHED_PANES_QUERY_KEY = ['a-term-detached-panes']
const SESSIONS_QUERY_KEY = ['a-term-sessions']
const ACTIVE_SESSIONS_QUERY_KEY = ['a-term-sessions', false]
const ALL_SESSIONS_QUERY_KEY = ['a-term-sessions', true]

const invalidatePanesAndSessions = (qc: ReturnType<typeof useQueryClient>) => {
  qc.invalidateQueries({ queryKey: ACTIVE_PANES_QUERY_KEY })
  qc.invalidateQueries({ queryKey: DETACHED_PANES_QUERY_KEY })
  qc.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY })
}

const sortPanes = (items: ATermPane[]) =>
  [...items].sort((a, b) => {
    if (a.pane_order !== b.pane_order) return a.pane_order - b.pane_order
    return (a.created_at ?? '').localeCompare(b.created_at ?? '')
  })

const upsertPane = (
  current: PaneListResponse | undefined,
  pane: ATermPane,
): PaneListResponse => {
  const existingItems = current?.items ?? []
  const nextItems = existingItems.some((item) => item.id === pane.id)
    ? existingItems.map((item) => (item.id === pane.id ? pane : item))
    : [...existingItems, pane]

  return {
    items: sortPanes(nextItems),
    total: nextItems.length,
    max_panes: current?.max_panes ?? MAX_PANES,
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
  pane: ATermPane,
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

const buildSessionsFromPane = (pane: ATermPane): ATermSession[] =>
  pane.sessions.map((session, index) => ({
    id: session.id,
    name: session.name,
    user_id: null,
    project_id: pane.project_id,
    working_dir: session.working_dir,
    mode: session.mode,
    display_order: index,
    is_alive: session.is_alive,
    created_at: pane.created_at,
    last_accessed_at: pane.created_at,
    agent_state: session.agent_state,
    claude_state: session.claude_state,
  }))

const upsertSessions = (
  current: ATermSession[] | undefined,
  sessions: ATermSession[],
): ATermSession[] => {
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
  current: ATermSession[] | undefined,
  sessionIds: Set<string>,
): ATermSession[] | undefined =>
  current?.filter((session) => !sessionIds.has(session.id))

const syncSessionCaches = (
  qc: ReturnType<typeof useQueryClient>,
  pane: ATermPane,
) => {
  const sessions = buildSessionsFromPane(pane)
  const sessionIds = new Set(sessions.map((session) => session.id))
  if (pane.is_detached) {
    qc.setQueryData<ATermSession[]>(ACTIVE_SESSIONS_QUERY_KEY, (current) =>
      removeSessions(current, sessionIds),
    )
  } else {
    qc.setQueryData<ATermSession[]>(ACTIVE_SESSIONS_QUERY_KEY, (current) =>
      upsertSessions(current, sessions),
    )
  }
  qc.setQueryData<ATermSession[]>(ALL_SESSIONS_QUERY_KEY, (current) =>
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
  qc.setQueryData<ATermSession[]>(ACTIVE_SESSIONS_QUERY_KEY, (current) =>
    removeSessions(current, sessionIds),
  )
  qc.setQueryData<ATermSession[]>(ALL_SESSIONS_QUERY_KEY, (current) =>
    removeSessions(current, sessionIds),
  )
}

export function useATermPanes() {
  const queryClient = useQueryClient()

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ACTIVE_PANES_QUERY_KEY,
    queryFn: api.fetchPanes,
  })
  const { data: detachedData } = useQuery({
    queryKey: DETACHED_PANES_QUERY_KEY,
    queryFn: api.fetchDetachedPanes,
  })

  const panes = data?.items ?? []
  const detachedPanes = detachedData?.items ?? []
  const maxPanes = data?.max_panes ?? MAX_PANES
  const atLimit = panes.length >= maxPanes

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
  const detachMutation = useMutation({
    mutationFn: api.detachPane,
    onSuccess: (pane) => {
      syncPaneCaches(queryClient, pane)
      syncSessionCaches(queryClient, pane)
      invalidatePanesAndSessions(queryClient)
    },
  })
  const attachMutation = useMutation({
    mutationFn: ({
      paneId,
      request,
    }: {
      paneId: string
      request?: AttachPaneRequest
    }) => api.attachPane(paneId, request),
    onSuccess: (pane) => {
      syncPaneCaches(queryClient, pane)
      syncSessionCaches(queryClient, pane)
      invalidatePanesAndSessions(queryClient)
    },
  })

  const swapMutation = useMutation({
    mutationFn: api.swapPanes,
    onMutate: async ({ pane_id_a, pane_id_b }) => {
      await queryClient.cancelQueries({ queryKey: ACTIVE_PANES_QUERY_KEY })
      const previous = queryClient.getQueryData<PaneListResponse>([
        'a-term-panes',
      ])

      if (previous) {
        const paneA = previous.items.find((p) => p.id === pane_id_a)
        const paneB = previous.items.find((p) => p.id === pane_id_b)
        if (paneA && paneB) {
          const items = previous.items.map((p) =>
            p.id === pane_id_a
              ? { ...p, pane_order: paneB.pane_order }
              : p.id === pane_id_b
                ? { ...p, pane_order: paneA.pane_order }
                : p,
          )
          items.sort((a, b) => a.pane_order - b.pane_order)
          queryClient.setQueryData(ACTIVE_PANES_QUERY_KEY, {
            ...previous,
            items,
          })
        }
      }
      return { previous }
    },
    onError: (_e, _v, ctx) =>
      ctx?.previous &&
      queryClient.setQueryData(ACTIVE_PANES_QUERY_KEY, ctx.previous),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ACTIVE_PANES_QUERY_KEY }),
  })

  const layoutMutation = useMutation({ mutationFn: api.updateAllLayouts })

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
        pane_order: options?.paneOrder,
        width_percent: options?.widthPercent,
        height_percent: options?.heightPercent,
        grid_row: options?.gridRow,
        grid_col: options?.gridCol,
      }),
    [createMutation],
  )

  const createAdHocPane = useCallback(
    (name: string, workingDir?: string, options?: PanePlacementOptions) =>
      createMutation.mutateAsync({
        pane_type: 'adhoc',
        pane_name: name,
        working_dir: workingDir,
        detached: options?.detached,
        pane_order: options?.paneOrder,
        width_percent: options?.widthPercent,
        height_percent: options?.heightPercent,
        grid_row: options?.gridRow,
        grid_col: options?.gridCol,
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
  const detachPane = useCallback(
    (paneId: string) => detachMutation.mutateAsync(paneId),
    [detachMutation],
  )
  const attachPane = useCallback(
    (paneId: string, request?: AttachPaneRequest) =>
      attachMutation.mutateAsync({ paneId, request }),
    [attachMutation],
  )

  const swapPanePositions = useCallback(
    (paneIdA: string, paneIdB: string) =>
      swapMutation.mutateAsync({ pane_id_a: paneIdA, pane_id_b: paneIdB }),
    [swapMutation],
  )

  const saveLayouts = useCallback(
    (
      layouts: Array<{
        paneId: string
        widthPercent?: number
        heightPercent?: number
      }>,
    ) =>
      layoutMutation.mutateAsync({
        layouts: layouts.map((l) => ({
          pane_id: l.paneId,
          width_percent: l.widthPercent,
          height_percent: l.heightPercent,
        })),
      }),
    [layoutMutation],
  )

  return {
    panes,
    detachedPanes,
    maxPanes,
    atLimit,
    isLoading,
    detachedLoadedOnce: detachedData !== undefined,
    hasLoadedOnce: data !== undefined,
    isError,
    error,
    createProjectPane,
    createAdHocPane,
    isCreating: createMutation.isPending,
    setActiveMode,
    renamePane,
    isUpdating: updateMutation.isPending,
    removePane,
    isDeleting: deleteMutation.isPending,
    detachPane,
    attachPane,
    isDetaching: detachMutation.isPending,
    isAttaching: attachMutation.isPending,
    swapPanePositions,
    isSwapping: swapMutation.isPending,
    saveLayouts,
    isSavingLayouts: layoutMutation.isPending,
  }
}

export type {
  ATermPane,
  AttachPaneRequest,
  CreatePaneRequest,
  PanePlacementOptions,
  PaneSession,
  SwapPanesRequest,
  UpdatePaneRequest,
} from './a-term-panes-types'
