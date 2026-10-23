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
  a_term_enabled: boolean
  mode: string // Active mode (shell or agent tool slug)
  display_order: number
}

interface ProjectCreateRequest {
  root_path: string
  name?: string
}

interface ProjectSettingsUpdate {
  enabled?: boolean
  active_mode?: string
  display_order?: number
}

interface ProjectRegistryContext {
  source: 'local' | 'companion'
  can_register: boolean
}

// ============================================================================
// API Functions
// ============================================================================

async function fetchProjects(): Promise<ProjectSetting[]> {
  return apiFetch('/api/a-term/projects', undefined, 'Failed to fetch projects')
}

async function fetchProjectRegistryContext(): Promise<ProjectRegistryContext> {
  return apiFetch(
    '/api/a-term/projects/context',
    undefined,
    'Failed to fetch project registry status',
  )
}

async function createProject(
  payload: ProjectCreateRequest,
): Promise<ProjectSetting> {
  return apiFetch(
    '/api/a-term/projects',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
    'Failed to register project',
  )
}

async function updateProjectSettings(
  projectId: string,
  update: ProjectSettingsUpdate,
): Promise<ProjectSetting> {
  return apiFetch(
    `/api/a-term/project-settings/${projectId}`,
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
    '/api/a-term/project-settings/bulk-order',
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
    `/api/a-term/projects/${projectId}/mode`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    },
    'Failed to switch mode',
  )
}

async function disableProjectATerm(projectId: string): Promise<ProjectSetting> {
  return apiFetch(
    `/api/a-term/projects/${projectId}/disable`,
    {
      method: 'POST',
    },
    'Failed to disable a-term',
  )
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Hook for managing aTerm project settings.
 *
 * Provides:
 * - projects: List of all projects with aTerm settings
 * - enabledProjects: Only projects where a_term_enabled=true
 * - updateSettings: Update enabled/mode/order for a project
 * - updateOrder: Bulk update display order (for drag-and-drop)
 * - isLoading, isError: Query state
 *
 * @example
 * ```tsx
 * const { projects, updateSettings, updateOrder } = useProjectSettings();
 *
 * // Toggle a project
 * await updateSettings(projectId, { enabled: !project.a_term_enabled });
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
    queryKey: ['a-term-projects'],
    queryFn: fetchProjects,
    staleTime: 30000, // Consider fresh for 30s
  })
  const { data: registryContext } = useQuery({
    queryKey: ['a-term-project-registry-context'],
    queryFn: fetchProjectRegistryContext,
    staleTime: 30000,
  })

  // Derived: only enabled projects, sorted by display_order
  const enabledProjects = projects
    .filter((p) => p.a_term_enabled)
    .sort((a, b) => a.display_order - b.display_order)

  // Mutation: update single project settings
  const updateMutation = useMutation({
    mutationFn: ({
      projectId,
      ...update
    }: ProjectSettingsUpdate & { projectId: string }) =>
      updateProjectSettings(projectId, update),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['a-term-projects'] })
    },
  })

  // Mutation: bulk update order
  const orderMutation = useMutation({
    mutationFn: bulkUpdateOrder,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['a-term-projects'] })
    },
  })

  // Mutation: switch project mode
  const switchModeMutation = useMutation({
    mutationFn: ({ projectId, mode }: { projectId: string; mode: string }) =>
      switchProjectMode(projectId, mode),
    onMutate: async ({ projectId, mode }) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: ['a-term-projects'] })
      // Snapshot the previous value
      const previousProjects = queryClient.getQueryData<ProjectSetting[]>([
        'a-term-projects',
      ])
      // Optimistically update to the new mode
      queryClient.setQueryData<ProjectSetting[]>(['a-term-projects'], (old) =>
        old?.map((p) => (p.id === projectId ? { ...p, mode: mode } : p)),
      )
      return { previousProjects }
    },
    onError: (_err, _variables, context) => {
      // Rollback on error
      if (context?.previousProjects) {
        queryClient.setQueryData(['a-term-projects'], context.previousProjects)
      }
    },
    onSettled: () => {
      // Always refetch to ensure consistency
      queryClient.invalidateQueries({ queryKey: ['a-term-projects'] })
    },
  })

  const disableMutation = useMutation({
    mutationFn: disableProjectATerm,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['a-term-projects'] })
      queryClient.invalidateQueries({ queryKey: ['a-term-sessions'] })
      queryClient.invalidateQueries({ queryKey: ['a-term-panes'] })
    },
  })

  const createMutation = useMutation({
    mutationFn: createProject,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['a-term-projects'] })
      queryClient.invalidateQueries({
        queryKey: ['a-term-project-registry-context'],
      })
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

  const registerProject = useCallback(
    async (payload: ProjectCreateRequest) => {
      return createMutation.mutateAsync(payload)
    },
    [createMutation],
  )

  return {
    projects,
    enabledProjects,
    projectRegistrySource: registryContext?.source ?? 'companion',
    canRegisterProjects: registryContext?.can_register ?? false,
    registerProject,
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
      disableMutation.isPending ||
      createMutation.isPending,
  }
}
