'use client'

import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../api-fetch'

/** Tether reads transcripts every 15 seconds; asking more often sees nothing new. */
const CONTEXT_REFRESH_MS = 20_000

interface HistorySummary {
  tool: string
  startedAt: number | null
  endedAt?: number | null
  contextTokens?: number | null
}

/** The session's current conversation's context fill, or null while unknown:
 * the conversation Tether bound to the session that wrote last (a short side
 * run of the same tool, like a hook's `claude -p`, starts later but stops
 * at once), unless it has no reading yet (a missing number is unknown, never
 * zero). */
export function contextTokensOf(
  items: HistorySummary[],
  mode?: string,
): number | null {
  // A session can also own side runs of other tools (an agent's `codex exec`); prefer its own tool's.
  const own = mode ? items.filter((i) => sameTool(i.tool, mode)) : []
  const newest = [...(own.length ? own : items)].sort(
    (a, b) => lastWrite(b) - lastWrite(a),
  )[0]
  return newest?.contextTokens ?? null
}
function lastWrite(item: HistorySummary): number {
  return item.endedAt ?? item.startedAt ?? 0
}
function sameTool(tool: string, mode: string): boolean {
  return (
    tool === mode || tool.startsWith(`${mode}-`) || mode.startsWith(`${tool}-`)
  )
}

/** How many tokens of context a live agent session holds at its latest reply
 * (the provider's own count, from Tether's session history). A shell has none. */
export function useSessionContext(
  sessionId: string | null,
  mode: string | undefined,
) {
  const enabled = !!sessionId && !!mode && mode !== 'shell'
  const query = useQuery({
    queryKey: ['session-context', sessionId],
    queryFn: async () =>
      contextTokensOf(
        (
          await apiFetch<{ items?: HistorySummary[] }>(
            `/api/history?session=${encodeURIComponent(sessionId ?? '')}&limit=5`,
          )
        ).items ?? [],
        mode,
      ),
    enabled,
    staleTime: CONTEXT_REFRESH_MS,
    refetchInterval: CONTEXT_REFRESH_MS,
    retry: false,
  })
  return enabled ? (query.data ?? null) : null
}

/** `206k` for 206,151; one decimal below 10k; whole tokens below 1k. */
export function contextLabel(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  const thousands = tokens / 1000
  return `${thousands < 10 ? thousands.toFixed(1).replace(/\.0$/, '') : Math.round(thousands)}k`
}
