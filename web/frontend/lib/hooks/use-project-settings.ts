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

// ============================================================================
// API Functions
// ============================================================================

async function fetchProjects(): Promise<ProjectSetting[]> {
  return apiFetch('/api/projects', undefined, 'Failed to fetch projects')
}

async function switchProjectMode(
  projectId: string,
  mode: string,
): Promise<ProjectSetting> {
  return apiFetch(
    `/api/projects/${projectId}/mode`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    },
    'Failed to switch mode',
  )
}

// ============================================================================
// Hook
// ============================================================================

/** Aico's projects (for New session and session names) and each project's
 * shell/agent mode. */
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
  // Derived: only enabled projects, sorted by display_order
  const enabledProjects = projects
    .filter((p) => p.a_term_enabled)
    .sort((a, b) => a.display_order - b.display_order)

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

  // Switch project mode (shell <-> agent tool)
  const switchMode = useCallback(
    async (projectId: string, mode: string) => {
      return switchModeMutation.mutateAsync({ projectId, mode })
    },
    [switchModeMutation],
  )

  return {
    projects,
    enabledProjects,
    switchMode,
    isLoading,
    isError,
    error,
    refetch,
    isUpdating: switchModeMutation.isPending,
  }
}
