'use client'

import { useCallback, useState } from 'react'
import { getAgentHubProxyUrl } from '../utils/agent-hub-proxy'
import { getPromptCleanerModel } from '../utils/agent-hub-models'

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

// System prompt for cleaning
const SYSTEM_PROMPT = `You are a prompt formatting assistant. Your task is to clean and improve user prompts.

Rules:
1. Fix typos, grammar, and punctuation
2. Improve clarity and structure
3. Maintain the original intent
4. Keep the same level of detail unless refinement requests otherwise
5. Return ONLY the cleaned prompt, no explanations or preambles
6. If the prompt mentions code or technical terms, preserve them exactly`

/**
 * Hook for cleaning prompts via agent-hub.
 * Uses Claude Haiku for fast, cheap processing.
 */
export function usePromptCleaner(): UsePromptCleanerReturn {
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const cleanPrompt = useCallback(
    async (prompt: string, refinement?: string): Promise<string> => {
      setIsLoading(true)
      setError(null)

      try {
        const endpoint = getAgentHubProxyUrl('complete')
        if (!endpoint) {
          // Agent-hub not configured - return original prompt
          return prompt.trim()
        }

        // Build the user message
        let userMessage = `Clean and improve this prompt:\n\n${prompt}`
        if (refinement) {
          userMessage += `\n\nAdditional instruction: ${refinement}`
        }

        const model = await getPromptCleanerModel()

        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Source-Client': 'terminal',
            'X-Source-Path': 'frontend/lib/hooks/use-prompt-cleaner.ts',
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: userMessage },
            ],
            max_tokens: 4096,
            temperature: 0.3,
            project_id: 'terminal-prompt-cleaner',
            persist_session: false,
          }),
          signal: AbortSignal.timeout(10000),
        })

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}))
          throw new Error(errorData.detail || `API error: ${response.status}`)
        }

        const data = await response.json()
        const cleanedContent = data.content || data.message?.content

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
