'use client'

import { useAgentTools } from '@/lib/hooks/use-agent-tools'
import {
  contextLabel,
  useSessionContext,
} from '@/lib/hooks/use-session-context'

/** How much context the open agent session holds, from the provider's own
 * count at its latest reply (`206k`). Nothing shows until a count is read, and
 * never for a shell: unknown is not zero. A tool that draws its own status
 * line (Claude Code, Codex; the registry says so) shows it there, live, so
 * the header leaves it out; so does the wait for the registry. */
export function ContextFillBadge({
  sessionId,
  mode,
}: {
  sessionId: string | null
  mode: string | undefined
}) {
  const { agentTools, isLoading } = useAgentTools()
  const tool = agentTools.find(
    (candidate) =>
      candidate.slug === mode || (!!mode && candidate.aliases.includes(mode)),
  )
  const hidden = isLoading || tool?.status_line === true
  const tokens = useSessionContext(hidden ? null : sessionId, mode)
  if (tokens === null) return null
  const text = `Context in use: ${tokens.toLocaleString('en-US')} tokens at the latest reply`
  return (
    <span
      data-testid="context-fill"
      className="flex-none whitespace-nowrap text-xs"
      style={{ color: 'var(--mist)', fontFamily: 'var(--font-mono)' }}
      title={text}
      aria-label={text}
    >
      {contextLabel(tokens)}
    </span>
  )
}
