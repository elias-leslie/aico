'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { type QuotaGlance, quotaGlances, toolGlance } from '@/lib/frame/quota'
import { type AgentTool, useAgentTools } from '@/lib/hooks/use-agent-tools'
import { useTerminalPanes } from '@/lib/hooks/use-terminal-panes'
import { useUsage } from '@/lib/hooks/use-usage'
import type { PaneSlot, TerminalSlot } from '@/lib/utils/slot'
import { getSlotSessionId } from '@/lib/utils/slot'

/** The usage glance for the session's tool: its mode is the tool slug (`claude-code`), the glance id a name or alias (`claude`). */
function ownGlance(
  glances: readonly QuotaGlance[],
  mode: string,
  tool: AgentTool | undefined,
): QuotaGlance | undefined {
  return toolGlance(glances, tool ? [tool.slug, ...tool.aliases] : [mode])
}

/**
 * The agent tools that could take over from `mode`'s: another enabled tool whose
 * subscription still has room (time left, or paid by credits). The tool and its
 * subscription share a name (`claude`, `codex`) in the usage report.
 */
export function continueTargets(
  mode: string,
  glances: readonly QuotaGlance[],
  tools: readonly AgentTool[],
): AgentTool[] {
  const named = (tool: AgentTool) => [tool.slug, ...tool.aliases]
  const active = tools.find((tool) => named(tool).includes(mode))
  const own = ownGlance(glances, mode, active)
  if (own?.state !== 'used_up' && own?.state !== 'no_plan') return []
  const open = new Set(
    glances
      .filter(
        (glance) =>
          !glance.stale &&
          (glance.state === 'left' || glance.state === 'credits'),
      )
      .map((glance) => glance.id),
  )
  return tools.filter(
    (tool) =>
      !named(tool).includes(mode) && named(tool).some((name) => open.has(name)),
  )
}

/**
 * A session whose subscription is used up: one line docked above it, with a button per tool
 * that could carry on. The new session starts from a recap of this one (Tether builds it). Only
 * for an agent session in a project tab on this computer, and only once the usage report says so.
 */
export function ContinueNotice({ slot }: { slot: TerminalSlot | PaneSlot }) {
  const router = useRouter()
  const { report } = useUsage()
  const { enabledTools } = useAgentTools()
  const { createProjectPane } = useTerminalPanes()
  const [starting, setStarting] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const sessionId = getSlotSessionId(slot)
  if (slot.type !== 'project' || slot.chat || slot.host || !sessionId)
    return null
  const glances = quotaGlances(report)
  const targets = continueTargets(slot.activeMode, glances, enabledTools)
  if (targets.length === 0) return null
  const own = ownGlance(
    glances,
    slot.activeMode,
    enabledTools.find((tool) =>
      [tool.slug, ...tool.aliases].includes(slot.activeMode),
    ),
  )

  const start = async (tool: AgentTool) => {
    setStarting(tool.slug)
    setFailure(null)
    try {
      const pane = await createProjectPane(
        slot.projectName,
        slot.projectId,
        slot.rootPath ?? undefined,
        tool.slug,
        { continueFrom: sessionId },
      )
      const next = pane.sessions.find((session) => session.mode !== 'shell')
      if (next) router.push(`/?session=${encodeURIComponent(next.id)}`)
    } catch (error) {
      setFailure(
        error instanceof Error && error.message
          ? error.message
          : `Couldn’t start ${tool.name}.`,
      )
    } finally {
      setStarting(null)
    }
  }

  return (
    <div
      className="lantern-model-bar warn"
      role="status"
      aria-live="polite"
      data-testid="continue-notice"
    >
      <p className="line">
        <span aria-hidden="true" className="dot" />
        <span className="t" title={own?.meaning}>
          {failure ??
            `${own?.name ?? 'This tool'} ${own?.state === 'no_plan' ? 'has no plan' : 'is used up'}`}
        </span>
        {targets.map((tool) => (
          <button
            key={tool.slug}
            type="button"
            className="lantern-btn small primary more"
            disabled={starting !== null}
            title={`Start a ${tool.name} session here with a recap of this one`}
            onClick={() => void start(tool)}
          >
            {starting === tool.slug ? 'Starting…' : `Continue in ${tool.name}`}
          </button>
        ))}
      </p>
    </div>
  )
}
