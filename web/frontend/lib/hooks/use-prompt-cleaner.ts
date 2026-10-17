'use client'

import { useCallback, useState } from 'react'
import { getPromptCleanerAgentSlug } from '../utils/agent-hub-models'
import { getAgentHubProxyUrl } from '../utils/agent-hub-proxy'

interface UsePromptCleanerReturn {
  /** Clean a prompt using agent-hub */
  cleanPrompt: (prompt: string, refinement?: string) => Promise<string>
  /** Whether a clean operation is in progress */
  isLoading: boolean
  /** Last error from clean operation */
  error: string | null
  /** Clear error state */
  clearError: () => void
}

function getErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return 'Failed to clean prompt'
  return err.name === 'TimeoutError' ? 'Request timed out' : err.message
}

// The cleaning rules are the prompt-builder agent's own prompt in Agent Hub,
// which Agent Hub applies to every request for that agent. A-Term sends only
// the draft and what to change, in the shape SummitFlow's note refinement uses.
// A refinement always starts from the raw draft, so the clean-up asks ride
// along with it.
const CLEAN_UP =
  'Fix typos, grammar and punctuation and make it clearer. Keep the intent, the level of detail and any code or technical terms exactly.'

/** The user message, or null when there is nothing to send. */
function buildPromptCleanerMessage(
  prompt: string,
  refinement?: string,
): string | null {
  const extra = refinement?.trim()
  if (!prompt.trim()) return extra || null
  return `CURRENT PROMPT:\n${prompt}\n\nREFINEMENT:\n${extra ? `${CLEAN_UP}\n${extra}` : CLEAN_UP}`
}

/**
 * Hook for cleaning prompts via agent-hub's prompt-builder agent.
 */
export function usePromptCleaner(): UsePromptCleanerReturn {
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const cleanPrompt = useCallback(
    async (prompt: string, refinement?: string): Promise<string> => {
      setIsLoading(true)
      setError(null)

      try {
        const content = buildPromptCleanerMessage(prompt, refinement)
        // Nothing to clean: keep the (empty) draft
        if (content === null) return prompt.trim()

        const response = await fetch(getAgentHubProxyUrl('complete'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Source-Client': 'a-term',
            'X-Source-Path': 'frontend/lib/hooks/use-prompt-cleaner.ts',
          },
          body: JSON.stringify({
            agent_slug: getPromptCleanerAgentSlug(),
            messages: [{ role: 'user', content }],
            max_tokens: 4096,
            temperature: 0.3,
            project_id: 'a-term',
            persist_session: false,
          }),
          signal: AbortSignal.timeout(10000),
        })

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}))
          throw new Error(errorData.detail || `API error: ${response.status}`)
        }

        const data = await response.json()
        const cleanedContent = (data.content || data.message?.content)?.trim()

        if (!cleanedContent) {
          throw new Error('No content in response')
        }

        return cleanedContent
      } catch (err) {
        const message = getErrorMessage(err)
        setError(message)

        return prompt.trim()
      } finally {
        setIsLoading(false)
      }
    },
    [],
  )

  const clearError = useCallback(() => {
    setError(null)
  }, [])

  return {
    cleanPrompt,
    isLoading,
    error,
    clearError,
  }
}
