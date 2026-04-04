'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { apiFetch } from '../api-fetch'

// ============================================================================
// Types
// ============================================================================

export interface ProjectSetting {
  id: string
  name: string
  root_path: string | null
  terminal_enabled: boolean
  mode: string // Active mode (shell or agent tool slug)
  display_order: number
}

interface ProjectSettingsUpdate {
  enabled?: boolean
  active_mode?: string
  display_order?: number
}

// ============================================================================
// API Functions
// ============================================================================

async function fetchProjects(): Promise<ProjectSetting[]> {
  return apiFetch('/api/terminal/projects', undefined, 'Failed to fetch projects')
}

async function updateProjectSettings(
  projectId: string,
  update: ProjectSettingsUpdate,
): Promise<ProjectSetting> {
  return apiFetch(
    `/api/terminal/project-settings/${projectId}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(update),
    },
    'Failed to update settings',
  )
}

async function bulkUpdateOrder(
  projectIds: string[],
): Promise<ProjectSetting[]> {
  return apiFetch(
    '/api/terminal/project-settings/bulk-order',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_ids: projectIds }),
    },
    'Failed to update order',
  )
}

async function switchProjectMode(
  projectId: string,
  mode: string,
): Promise<ProjectSetting> {
  return apiFetch(
    `/api/terminal/projects/${projectId}/mode`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    },
    'Failed to switch mode',
  )
}

async function disableProjectTerminal(projectId: string): Promise<ProjectSetting> {
  return apiFetch(
    `/api/terminal/projects/${projectId}/disable`,
    {
      method: 'POST',
    },
    'Failed to disable terminal',
  )
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Hook for managing terminal project settings.
 *
 * Provides:
 * - projects: List of all projects with terminal settings
 * - enabledProjects: Only projects where terminal_enabled=true
 * - updateSettings: Update enabled/mode/order for a project
 * - updateOrder: Bulk update display order (for drag-and-drop)
 * - isLoading, isError: Query state
 *
 * @example
 * ```tsx
 * const { projects, updateSettings, updateOrder } = useProjectSettings();
 *
 * // Toggle a project
 * await updateSettings(projectId, { enabled: !project.terminal_enabled });
 *
 * // Reorder after drag-drop
 * await updateOrder(newOrderedIds);
 * ```
 */
export function useProjectSettings() {
  const queryClient = useQueryClient()

  // Query: fetch projects with settings
  const {
    data: projects = [],
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['terminal-projects'],
    queryFn: fetchProjects,
    staleTime: 30000, // Consider fresh for 30s
  })

  // Derived: only enabled projects, sorted by display_order
  const enabledProjects = projects
    .filter((p) => p.terminal_enabled)
    .sort((a, b) => a.display_order - b.display_order)

  // Mutation: update single project settings
  const updateMutation = useMutation({
    mutationFn: ({
      projectId,
      ...update
    }: ProjectSettingsUpdate & { projectId: string }) =>
      updateProjectSettings(projectId, update),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['terminal-projects'] })
    },
  })

  // Mutation: bulk update order
  const orderMutation = useMutation({
    mutationFn: bulkUpdateOrder,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['terminal-projects'] })
    },
  })

  // Mutation: switch project mode
  const switchModeMutation = useMutation({
    mutationFn: ({
      projectId,
      mode,
    }: {
      projectId: string
      mode: string
    }) => switchProjectMode(projectId, mode),
    onMutate: async ({ projectId, mode }) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: ['terminal-projects'] })
      // Snapshot the previous value
      const previousProjects = queryClient.getQueryData<ProjectSetting[]>([
        'terminal-projects',
      ])
      // Optimistically update to the new mode
      queryClient.setQueryData<ProjectSetting[]>(['terminal-projects'], (old) =>
        old?.map((p) => (p.id === projectId ? { ...p, mode: mode } : p)),
      )
      return { previousProjects }
    },
    onError: (_err, _variables, context) => {
      // Rollback on error
      if (context?.previousProjects) {
        queryClient.setQueryData(
          ['terminal-projects'],
          context.previousProjects,
        )
      }
    },
    onSettled: () => {
      // Always refetch to ensure consistency
      queryClient.invalidateQueries({ queryKey: ['terminal-projects'] })
    },
  })

  const disableMutation = useMutation({
    mutationFn: disableProjectTerminal,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['terminal-projects'] })
      queryClient.invalidateQueries({ queryKey: ['terminal-sessions'] })
      queryClient.invalidateQueries({ queryKey: ['terminal-panes'] })
    },
  })

  // Update settings for a project
  const updateSettings = useCallback(
    async (projectId: string, update: ProjectSettingsUpdate) => {
      return updateMutation.mutateAsync({ projectId, ...update })
    },
    [updateMutation],
  )

  // Bulk update order (for drag-and-drop)
  const updateOrder = useCallback(
    async (projectIds: string[]) => {
      return orderMutation.mutateAsync(projectIds)
    },
    [orderMutation],
  )

  // Switch project mode (shell <-> agent tool)
  const switchMode = useCallback(
    async (projectId: string, mode: string) => {
      return switchModeMutation.mutateAsync({ projectId, mode })
    },
    [switchModeMutation],
  )

  const disableProject = useCallback(
    async (projectId: string) => {
      return disableMutation.mutateAsync(projectId)
    },
    [disableMutation],
  )

  return {
    projects,
    enabledProjects,
    updateSettings,
    updateOrder,
    switchMode,
    disableProject,
    isLoading,
    isError,
    error,
    refetch,
    isUpdating:
      updateMutation.isPending ||
      orderMutation.isPending ||
      switchModeMutation.isPending ||
      disableMutation.isPending,
  }
}
