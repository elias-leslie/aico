'use client'

import { useQueryClient } from '@tanstack/react-query'
import { useRouter, useSearchParams } from 'next/navigation'
import { type MutableRefObject, useCallback } from 'react'
import { getAgentState } from '../utils/agent-state'
import type { ATermPane } from './use-a-term-panes'
import type { ATermSession } from './use-a-term-sessions'
import { useAgentPolling } from './use-agent-polling'

/** Pane list response type for query cache access */
interface PaneListResponse {
  items: ATermPane[]
  total: number
  max_panes: number
}

/** Delay before scrolling tab into view */
const TAB_SCROLL_DELAY_MS = 100

interface SwitchProjectModeParams {
  projectId: string
  mode: string
  /** All sessions for this project */
  projectSessions: ATermSession[]
  /** Pane ID if available (for direct pane mode switching) */
  paneId?: string
  /** Concrete pane snapshot for just-created or just-attached panes */
  pane?: ATermPane
}

interface UseProjectModeSwitchOptions {
  /** Function to switch mode in backend (from useProjectATerms) */
  switchMode: (projectId: string, mode: string) => Promise<void>
  /** Refs to project tabs for scroll-into-view */
  projectTabRefs: MutableRefObject<Map<string, HTMLDivElement>>
  /** Panes array (new architecture) */
  panes: ATermPane[]
  /** Function to set active mode on a pane */
  setActiveMode: (paneId: string, mode: string) => Promise<ATermPane>
  /** Function to switch agent tool on a pane (kills old tmux, creates new session) */
  switchAgentTool?: (paneId: string, slug: string) => Promise<ATermPane>
}

interface UseProjectModeSwitchReturn {
  /** Switch project mode with full orchestration */
  switchProjectMode: (params: SwitchProjectModeParams) => Promise<void>
  /** Whether polling is currently active */
  isPolling: boolean
}

/**
 * Hook for orchestrating project mode switches (shell <-> agent tool).
 *
 * Handles the 6-step orchestration:
 * 1. Update backend mode
 * 2. Determine/create target session
 * 3. Check agent state (if switching into agent mode)
 * 4. Start the agent and poll for confirmation
 * 5. Navigate to session via URL
 * 6. Scroll tab into view
 *
 * @example
 * ```tsx
 * const { switchProjectMode } = useProjectModeSwitch({
 *   switchMode,
 *   projectTabRefs,
 * });
 *
 * // In mode dropdown handler:
 * await switchProjectMode({
 *   projectId: "my-project",
 *   mode: "claude",
 *   projectSessions: [...], // all sessions for this project
 * });
 * ```
 */
export function useProjectModeSwitch({
  switchMode,
  projectTabRefs,
  panes,
  setActiveMode,
  switchAgentTool,
}: UseProjectModeSwitchOptions): UseProjectModeSwitchReturn {
  const router = useRouter()
  const searchParams = useSearchParams()
  const queryClient = useQueryClient()

  // Agent polling hook for starting agents and polling for state changes
  const { startAgent, isPolling } = useAgentPolling()

  // Helper to update URL with session param
  const navigateToSession = useCallback(
    (sessionId: string) => {
      const params = new URLSearchParams(searchParams.toString())
      params.set('session', sessionId)
      router.push(`?${params.toString()}`, { scroll: false })
    },
    [searchParams, router],
  )

  // Main orchestration function
  const switchProjectMode = useCallback(
    async (params: SwitchProjectModeParams): Promise<void> => {
      const { projectId, mode, projectSessions, paneId, pane: paneSnapshot } =
        params

      // Get fresh pane data from query cache to avoid stale closure issues
      // This is critical after operations like Close All where the panes array
      // in the closure may be outdated
      const freshPanesData = queryClient.getQueryData<PaneListResponse>([
        'a-term-panes',
      ])
      const freshDetachedPanesData = queryClient.getQueryData<PaneListResponse>([
        'a-term-detached-panes',
      ])
      const freshPanes = [
        ...(freshPanesData?.items ?? panes),
        ...(freshDetachedPanesData?.items ?? []),
      ]

      // 1. Find pane - prefer by paneId (exact match), fallback to projectId
      const pane =
        paneSnapshot ??
        (paneId
          ? freshPanes.find((p) => p.id === paneId)
          : freshPanes.find((p) => p.project_id === projectId))

      if (pane) {
        // Check if we need to swap agent tool sessions (switching between different agent tools)
        const currentAgentSession = pane.sessions.find(
          (s) => s.mode !== 'shell',
        )
        const isAgentToAgentSwitch =
          mode !== 'shell' &&
          currentAgentSession &&
          currentAgentSession.mode !== mode &&
          switchAgentTool

        let updatedPane: ATermPane

        if (isAgentToAgentSwitch) {
          // Switching between agent tools: replace the agent session entirely.
          updatedPane = await switchAgentTool(pane.id, mode)
        } else {
          // Simple toggle (shell ↔ agent): just update active_mode
          updatedPane = await setActiveMode(pane.id, mode)
        }

        // Find the target session in the updated pane
        const targetSession = updatedPane.sessions.find((s) => s.mode === mode)
        if (!targetSession) {
          console.error('Pane missing session for mode:', mode, updatedPane)
          return
        }

        if (mode !== 'shell') {
          const agentState =
            getAgentState(targetSession) ??
            getAgentState(
              projectSessions.find((s) => s.id === targetSession.id),
            )
          const needsAgentStart =
            agentState !== 'running' && agentState !== 'starting'

          if (needsAgentStart) {
            await startAgent(targetSession.id)
          }
        }

        // Navigate to the session
        navigateToSession(targetSession.id)
      } else {
        // Session-based fallback kept for safety until all callers are pane-backed.
        await switchMode(projectId, mode)

        const matchingSession = projectSessions.find((s) => s.mode === mode)
        if (matchingSession) {
          if (mode !== 'shell') {
            const agentState = getAgentState(matchingSession)
            const needsAgentStart =
              agentState !== 'running' && agentState !== 'starting'
            if (needsAgentStart) {
              await startAgent(matchingSession.id)
            }
          }
          navigateToSession(matchingSession.id)
        }
      }

      // 6. Scroll tab into view after mode switch
      setTimeout(() => {
        projectTabRefs.current.get(projectId)?.scrollIntoView({
          behavior: 'smooth',
          block: 'nearest',
          inline: 'nearest',
        })
      }, TAB_SCROLL_DELAY_MS)
    },
    [
      queryClient,
      panes,
      setActiveMode,
      switchAgentTool,
      switchMode,
      startAgent,
      navigateToSession,
      projectTabRefs,
    ],
  )

  return {
    switchProjectMode,
    isPolling,
  }
}
