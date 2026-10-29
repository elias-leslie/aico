'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { apiFetch } from '../api-fetch'
import type { TerminalPane } from './use-terminal-panes'

// ============================================================================
// Types
// ============================================================================

/**
 * One entry of Tether's merged agent-tool registry, as the web server serves it.
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

/** The Tether slug of the bare-shell registry entry. */
export const SHELL_TOOL_SLUG = 'shell'

/** The Tether slug of the Agent Hub chat entry: a chat, not a command in a pane. */
export const CHAT_TOOL_SLUG = 'agent-hub'

export function isAgentTool(tool: Pick<AgentTool, 'slug'>): boolean {
  return tool.slug !== SHELL_TOOL_SLUG
}

// ============================================================================
// API Functions
// ============================================================================

async function fetchAgentTools(): Promise<AgentTool[]> {
  return apiFetch('/api/agent-tools', undefined, 'Failed to fetch agent tools')
}

async function switchPaneAgentTool(
  paneId: string,
  agentToolSlug: string,
): Promise<TerminalPane> {
  return apiFetch(
    `/api/panes/${paneId}/agent-tool`,
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

  // The registry's `shell` tool is the web app's shell mode, not an agent choice.
  const enabledTools = agentTools.filter((t) => t.enabled && isAgentTool(t))
  const defaultTool = enabledTools.find((t) => t.is_default) ?? enabledTools[0]

  const switchToolMutation = useMutation({
    mutationFn: ({ paneId, slug }: { paneId: string; slug: string }) =>
      switchPaneAgentTool(paneId, slug),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['terminal-panes'] })
      queryClient.invalidateQueries({ queryKey: ['terminal-sessions'] })
    },
  })

  const switchTool = useCallback(
    async (paneId: string, slug: string) =>
      switchToolMutation.mutateAsync({ paneId, slug }),
    [switchToolMutation],
  )

  return {
    agentTools,
    enabledTools,
    defaultTool,
    switchTool,
    isLoading,
    isError,
    error,
    isMutating: switchToolMutation.isPending,
  }
}
