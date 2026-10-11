'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { apiFetch } from '../api-fetch'
import type { ATermPane } from './use-a-term-panes'

// ============================================================================
// Types
// ============================================================================

/**
 * One entry of Tether's merged agent-tool registry, as A-Term serves it.
 * `argv` is authoritative; `command` is its plain-word rendering. An empty
 * argv is the bare shell. Aliases share the slug namespace (`claude` →
 * `claude-code`).
 */
export interface AgentTool {
  id: string
  name: string
  slug: string
  command: string
  argv: string[]
  process_name: string
  description: string | null
  color: string | null
  display_order: number
  is_default: boolean
  enabled: boolean
  aliases: string[]
  context_hook: string | null
  created_at: string | null
  updated_at: string | null
}

export interface CreateAgentToolInput {
  name: string
  slug: string
  command: string
  process_name?: string
  description?: string
  color?: string
  display_order?: number
  is_default?: boolean
  enabled?: boolean
  aliases?: string[]
}

export type UpdateAgentToolInput = Partial<Omit<CreateAgentToolInput, 'slug'>>

/** The Tether slug of the bare-shell registry entry. */
export const SHELL_TOOL_SLUG = 'shell'

export function isAgentTool(tool: Pick<AgentTool, 'slug'>): boolean {
  return tool.slug !== SHELL_TOOL_SLUG
}

// ============================================================================
// API Functions
// ============================================================================

async function fetchAgentTools(): Promise<AgentTool[]> {
  return apiFetch(
    '/api/a-term/agent-tools',
    undefined,
    'Failed to fetch agent tools',
  )
}

async function createAgentTool(
  input: CreateAgentToolInput,
): Promise<AgentTool> {
  return apiFetch(
    '/api/a-term/agent-tools',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
    'Failed to create agent tool',
  )
}

async function updateAgentTool(
  toolRef: string,
  input: UpdateAgentToolInput,
): Promise<AgentTool> {
  return apiFetch(
    `/api/a-term/agent-tools/${encodeURIComponent(toolRef)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
    'Failed to update agent tool',
  )
}

async function deleteAgentTool(toolRef: string): Promise<void> {
  await apiFetch(
    `/api/a-term/agent-tools/${encodeURIComponent(toolRef)}`,
    {
      method: 'DELETE',
    },
    'Failed to delete agent tool',
  )
}

async function switchPaneAgentTool(
  paneId: string,
  agentToolSlug: string,
): Promise<ATermPane> {
  return apiFetch(
    `/api/a-term/panes/${paneId}/agent-tool`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_tool_slug: agentToolSlug }),
    },
    'Failed to switch agent tool',
  )
}

// ============================================================================
// Hook
// ============================================================================

export function useAgentTools() {
  const queryClient = useQueryClient()

  const {
    data: agentTools = [],
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: ['agent-tools'],
    queryFn: fetchAgentTools,
    staleTime: 60000,
  })

  // The registry's `shell` tool is A-Term's shell mode, not an agent choice.
  const enabledTools = agentTools.filter((t) => t.enabled && isAgentTool(t))
  const defaultTool = enabledTools.find((t) => t.is_default) ?? enabledTools[0]

  const createMutation = useMutation({
    mutationFn: createAgentTool,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agent-tools'] })
    },
  })

  const updateMutation = useMutation({
    mutationFn: ({
      toolRef,
      ...input
    }: UpdateAgentToolInput & { toolRef: string }) =>
      updateAgentTool(toolRef, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agent-tools'] })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: deleteAgentTool,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agent-tools'] })
    },
  })

  const switchToolMutation = useMutation({
    mutationFn: ({ paneId, slug }: { paneId: string; slug: string }) =>
      switchPaneAgentTool(paneId, slug),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['a-term-panes'] })
      queryClient.invalidateQueries({ queryKey: ['a-term-sessions'] })
    },
  })

  const create = useCallback(
    async (input: CreateAgentToolInput) => createMutation.mutateAsync(input),
    [createMutation],
  )

  /** `toolRef` is the tool's slug (or id). */
  const update = useCallback(
    async (toolRef: string, input: UpdateAgentToolInput) =>
      updateMutation.mutateAsync({ toolRef, ...input }),
    [updateMutation],
  )

  const remove = useCallback(
    async (toolRef: string) => deleteMutation.mutateAsync(toolRef),
    [deleteMutation],
  )

  const switchTool = useCallback(
    async (paneId: string, slug: string) =>
      switchToolMutation.mutateAsync({ paneId, slug }),
    [switchToolMutation],
  )

  return {
    agentTools,
    enabledTools,
    defaultTool,
    create,
    update,
    remove,
    switchTool,
    isLoading,
    isError,
    error,
    isMutating:
      createMutation.isPending ||
      updateMutation.isPending ||
      deleteMutation.isPending ||
      switchToolMutation.isPending,
  }
}
