'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { MAX_PANES } from '@/lib/constants/a-term'
import * as api from './a-term-panes-api'
import type {
  PaneListResponse,
  UpdatePaneRequest,
} from './a-term-panes-types'

const invalidatePanesAndSessions = (qc: ReturnType<typeof useQueryClient>) => {
  qc.invalidateQueries({ queryKey: ['a-term-panes'] })
  qc.invalidateQueries({ queryKey: ['a-term-detached-panes'] })
  qc.invalidateQueries({ queryKey: ['a-term-sessions'] })
}

export function useATermPanes() {
  const queryClient = useQueryClient()

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['a-term-panes'],
    queryFn: api.fetchPanes,
  })
  const { data: detachedData } = useQuery({
    queryKey: ['a-term-detached-panes'],
    queryFn: api.fetchDetachedPanes,
  })

  const panes = data?.items ?? []
  const detachedPanes = detachedData?.items ?? []
  const maxPanes = data?.max_panes ?? MAX_PANES
  const atLimit = panes.length >= maxPanes

  const createMutation = useMutation({
    mutationFn: api.createPane,
    onSuccess: () => invalidatePanesAndSessions(queryClient),
  })

  const updateMutation = useMutation({
    mutationFn: ({ paneId, ...req }: UpdatePaneRequest & { paneId: string }) =>
      api.updatePane(paneId, req),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['a-term-panes'] }),
  })

  const deleteMutation = useMutation({
    mutationFn: api.deletePane,
    onSuccess: () => invalidatePanesAndSessions(queryClient),
  })
  const detachMutation = useMutation({
    mutationFn: api.detachPane,
    onSuccess: () => invalidatePanesAndSessions(queryClient),
  })
  const attachMutation = useMutation({
    mutationFn: api.attachPane,
    onSuccess: () => invalidatePanesAndSessions(queryClient),
  })

  const swapMutation = useMutation({
    mutationFn: api.swapPanes,
    onMutate: async ({ pane_id_a, pane_id_b }) => {
      await queryClient.cancelQueries({ queryKey: ['a-term-panes'] })
      const previous = queryClient.getQueryData<PaneListResponse>(['a-term-panes'])

      if (previous) {
        const paneA = previous.items.find((p) => p.id === pane_id_a)
        const paneB = previous.items.find((p) => p.id === pane_id_b)
        if (paneA && paneB) {
          const items = previous.items.map((p) =>
            p.id === pane_id_a ? { ...p, pane_order: paneB.pane_order } :
            p.id === pane_id_b ? { ...p, pane_order: paneA.pane_order } : p
          )
          items.sort((a, b) => a.pane_order - b.pane_order)
          queryClient.setQueryData(['a-term-panes'], { ...previous, items })
        }
      }
      return { previous }
    },
    onError: (_e, _v, ctx) => ctx?.previous && queryClient.setQueryData(['a-term-panes'], ctx.previous),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['a-term-panes'] }),
  })

  const layoutMutation = useMutation({ mutationFn: api.updateAllLayouts })

  const createProjectPane = useCallback(
    (
      name: string,
      projectId: string,
      workingDir?: string,
      agentToolSlug?: string,
    ) =>
      createMutation.mutateAsync({
        pane_type: 'project',
        pane_name: name,
        project_id: projectId,
        working_dir: workingDir,
        agent_tool_slug: agentToolSlug,
      }),
    [createMutation]
  )

  const createAdHocPane = useCallback(
    (name: string, workingDir?: string) =>
      createMutation.mutateAsync({ pane_type: 'adhoc', pane_name: name, working_dir: workingDir }),
    [createMutation]
  )

  const setActiveMode = useCallback(
    (paneId: string, mode: string) =>
      updateMutation.mutateAsync({ paneId, active_mode: mode }),
    [updateMutation]
  )

  const renamePane = useCallback(
    (paneId: string, newName: string) =>
      updateMutation.mutateAsync({ paneId, pane_name: newName }),
    [updateMutation]
  )

  const removePane = useCallback(
    (paneId: string) => deleteMutation.mutateAsync(paneId),
    [deleteMutation]
  )
  const detachPane = useCallback(
    (paneId: string) => detachMutation.mutateAsync(paneId),
    [detachMutation]
  )
  const attachPane = useCallback(
    (paneId: string) => attachMutation.mutateAsync(paneId),
    [attachMutation]
  )

  const swapPanePositions = useCallback(
    (paneIdA: string, paneIdB: string) =>
      swapMutation.mutateAsync({ pane_id_a: paneIdA, pane_id_b: paneIdB }),
    [swapMutation]
  )

  const saveLayouts = useCallback(
    (layouts: Array<{ paneId: string; widthPercent?: number; heightPercent?: number }>) =>
      layoutMutation.mutateAsync({
        layouts: layouts.map((l) => ({
          pane_id: l.paneId,
          width_percent: l.widthPercent,
          height_percent: l.heightPercent,
        })),
      }),
    [layoutMutation]
  )

  return {
    panes,
    detachedPanes,
    maxPanes,
    atLimit,
    isLoading,
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
  PaneSession,
  CreatePaneRequest,
  UpdatePaneRequest,
  SwapPanesRequest,
} from './a-term-panes-types'
