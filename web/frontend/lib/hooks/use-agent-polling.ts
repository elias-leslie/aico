'use client'

import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { buildApiUrl } from '../api-config'

/** Poll interval for agent state check (500ms) */
export const AGENT_POLL_INTERVAL_MS = 500

/** Max time to poll before giving up (15 seconds - slightly longer than backend verify) */
export const AGENT_POLL_TIMEOUT_MS = 15000

interface UseAgentPollingReturn {
  /** Start an agent in a session and poll for confirmation */
  startAgent: (sessionId: string) => Promise<boolean>
  /** Whether polling is currently active */
  isPolling: boolean
  /** Stop any active polling */
  stopPolling: () => void
}

/** Helper: delay for specified ms */
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Hook for starting an agent in a a-term session and polling for state changes.
 *
 * Uses the /start-agent and /agent-state endpoints.
 */
export function useAgentPolling(): UseAgentPollingReturn {
  const queryClient = useQueryClient()
  const abortControllerRef = useRef<AbortController | null>(null)
  const [isPolling, setIsPolling] = useState(false)

  const stopPolling = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
    setIsPolling(false)
  }, [])

  useEffect(() => {
    return () => {
      stopPolling()
    }
  }, [stopPolling])

  const pollForAgentState = useCallback(
    async (sessionId: string): Promise<void> => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
        abortControllerRef.current = null
      }

      const controller = new AbortController()
      abortControllerRef.current = controller
      setIsPolling(true)

      const pollStart = Date.now()

      while (!controller.signal.aborted) {
        if (Date.now() - pollStart > AGENT_POLL_TIMEOUT_MS) {
          queryClient.invalidateQueries({ queryKey: ['aTerm-sessions'] })
          break
        }

        await delay(AGENT_POLL_INTERVAL_MS)

        if (controller.signal.aborted) break

        try {
          const stateRes = await fetch(
            buildApiUrl(`/api/a-term/sessions/${sessionId}/agent-state`),
            { signal: controller.signal },
          )
          if (stateRes.ok) {
            const stateData = await stateRes.json()
            // Note: backend returns 'claude_state' field for backward compatibility
            if (
              stateData.claude_state === 'running' ||
              stateData.claude_state === 'error'
            ) {
              queryClient.invalidateQueries({ queryKey: ['a-term-sessions'] })
              break
            }
          }
        } catch (e) {
          if (e instanceof Error && e.name === 'AbortError') break
        }
      }

      queryClient.invalidateQueries({ queryKey: ['a-term-sessions'] })
      setIsPolling(false)
      abortControllerRef.current = null
    },
    [queryClient],
  )

  const startAgent = useCallback(
    async (sessionId: string): Promise<boolean> => {
      try {
        stopPolling()
        const res = await fetch(
          buildApiUrl(`/api/a-term/sessions/${sessionId}/start-agent`),
          { method: 'POST' },
        )

        if (!res.ok) {
          console.error('Failed to start agent:', await res.text())
          return false
        }

        const data = await res.json()

        queryClient.invalidateQueries({ queryKey: ['a-term-sessions'] })

        // Note: backend returns 'claude_state' field for backward compatibility
        if (data.claude_state === 'starting') {
          // Fire and forget - don't await
          pollForAgentState(sessionId)
        }

        return data.started || data.message?.includes('already running')
      } catch (e) {
        console.error('Failed to start agent:', e)
        return false
      }
    },
    [pollForAgentState, queryClient, stopPolling],
  )

  return {
    startAgent,
    isPolling,
    stopPolling,
  }
}
