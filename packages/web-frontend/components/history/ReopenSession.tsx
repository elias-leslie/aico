'use client'

import { ExternalLink, RotateCcw } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import type { LiveSession } from '@/lib/frame/live'
import { type HistorySession, toolName } from '@/lib/history'
import { useAgentTools } from '@/lib/hooks/use-agent-tools'
import { useProjectSettings } from '@/lib/hooks/use-project-settings'
import { useTerminalPanes } from '@/lib/hooks/use-terminal-panes'

/** The tool's own conversation id: a history id is `tool:id`. */
function conversationId(historyId: string): string {
  return historyId.slice(historyId.indexOf(':') + 1)
}

/**
 * A past session's way back in: Open when a session runs it now, else Reopen, which starts
 * its tool again on the same conversation in the same folder (Tether's native resume).
 */
export function ReopenSession({
  session,
  liveHere,
  working,
}: {
  session: HistorySession
  liveHere: LiveSession | undefined
  /** Its transcript was written to a moment ago. */
  working: boolean
}) {
  const router = useRouter()
  const { enabledTools } = useAgentTools()
  const { projects } = useProjectSettings()
  const { createProjectPane } = useTerminalPanes()
  const [starting, setStarting] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  if (liveHere)
    return (
      <Link
        href={`/?session=${encodeURIComponent(liveHere.session)}`}
        className="lantern-btn small primary"
        title="A session is running this conversation: open it"
      >
        <ExternalLink
          className="h-3.5 w-3.5"
          strokeWidth={1.7}
          aria-hidden="true"
        />
        Open
      </Link>
    )

  const tool = enabledTools.find((item) => item.slug === session.tool)
  const cwd = session.cwd?.replace(/\/+$/, '')
  const project =
    projects.find((item) => item.root_path?.replace(/\/+$/, '') === cwd) ??
    projects.find((item) => item.id === session.project)
  // A subagent has no conversation of its own to reopen; one written to a moment ago may
  // still be open somewhere Aico doesn't run (a terminal of the owner's).
  if (!tool || !cwd || !project || session.parentId !== null || working)
    return null

  const reopen = async () => {
    setStarting(true)
    setFailure(null)
    try {
      const pane = await createProjectPane(
        project.name,
        project.id,
        cwd,
        tool.slug,
        { resumeId: conversationId(session.id) },
      )
      const next = pane.sessions.find((item) => item.mode !== 'shell')
      if (next) router.push(`/?session=${encodeURIComponent(next.id)}`)
    } catch (error) {
      setFailure(
        error instanceof Error && error.message
          ? error.message
          : `Couldn’t reopen it in ${toolName(session.tool)}.`,
      )
    } finally {
      setStarting(false)
    }
  }

  return (
    <>
      <button
        type="button"
        className="lantern-btn small primary"
        disabled={starting}
        title={`Start ${tool.name} again on this conversation in ${project.name}`}
        onClick={() => void reopen()}
      >
        <RotateCcw
          className="h-3.5 w-3.5"
          strokeWidth={1.7}
          aria-hidden="true"
        />
        {starting ? 'Reopening…' : 'Reopen'}
      </button>
      {failure && (
        <span role="alert" className="status-chip bad" title={failure}>
          {failure}
        </span>
      )}
    </>
  )
}
