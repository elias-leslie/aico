// Workflow runs in the desktop: Tether lists the runs the sessions launched.
// A step that is running or waiting for the owner is a child agent of the
// session that launched the run (a tray row like any other); a run itself is
// not listed. A run that needs the owner raises the signal sessions raise
// (tray icon, phone push). Opening a step reads its latest attempt, read-only.
//
// Run state belongs to Agent Hub and is read by Tether; this holds the last
// answer and feeds the attention tracker.

import { childAgents, type RunMember, type RunsAnswer } from 'tether/client'
import { type AgentState, stateAge } from './attention'
import { toolDisplayName, traySessionLabel } from './session-catalog'
import type { TrayWidget } from './tray'

interface RunsDeps {
  attention: {
    updateId(id: string, state: AgentState, at: number | null): void
    removed(id: string): void
  }
  /** Rebuild the tray. */
  tray(): void
  /** Aico's agent tools, for the names on step rows. */
  tools(): readonly { slug: string; name: string }[]
  /** Read a step's latest attempt in a window with no input. */
  openStep(viewer: { runId: string; stepKey: string; title: string }): void
  now?: () => number
}

/** The app state a run member gives the attention tracker. */
function stateOf(member: RunMember): AgentState {
  return member.group === 'needs-you' ? 'blocked' : member.group === 'working' ? 'working' : 'idle'
}

export function createRuns(deps: RunsDeps) {
  let answer: RunsAnswer | null = null
  /** Runs handed to the attention tracker. */
  let tracked = new Set<string>()

  /** A fresh answer from Tether. A run that needs the owner raises the same
   * signal a session does; one that is gone clears it. Nothing is cleared
   * from an answer that holds no look at Agent Hub. */
  function apply(next: RunsAnswer): void {
    answer = next
    if (next.status !== 'unavailable') {
      const now = new Set<string>()
      for (const member of next.items) {
        if (member.kind !== 'run') continue
        now.add(member.id)
        deps.attention.updateId(member.id, stateOf(member), member.at)
      }
      for (const id of tracked) if (!now.has(id)) deps.attention.removed(id)
      tracked = now
    }
    deps.tray()
  }

  /** The steps to list, as tray rows under the session that launched the run. */
  function widgets(): TrayWidget[] {
    const now = (deps.now ?? Date.now)()
    return childAgents(answer?.items ?? []).map((member) => {
      const tool = toolDisplayName(member.tool ?? '', deps.tools())
      const state = member.group === 'needs-you' ? 'blocked' : 'working'
      return {
        id: member.id,
        label: traySessionLabel(member.title, tool),
        title: member.title,
        tool,
        open: false,
        group: member.group,
        detail: stateAge(state, member.group, member.at, now),
        at: member.at,
        coordinator: false,
        coordinatorId: member.coordinatorId,
        run: member,
      }
    })
  }

  /** A line for the top of the tray when the runs may be out of date; null when fresh. */
  function notice(): string | null {
    if (!answer || answer.status === 'ok') return null
    const why = answer.error ?? 'Agent Hub is not reachable'
    return answer.status === 'stale'
      ? `Workflow runs may be out of date: ${why}`
      : `Workflow runs unavailable: ${why}`
  }

  /** Open a step's current attempt, read-only. */
  function openStep(runId: string, stepKey: string): void {
    const step = answer?.items.find((m) => m.runId === runId && m.stepKey === stepKey)
    if (!step?.session) return
    const run = answer?.items.find((m) => m.runId === runId && m.kind === 'run')
    deps.openStep({ runId, stepKey, title: run ? `${step.title} — ${run.title}` : step.title })
  }

  return {
    apply,
    widgets,
    notice,
    openStep,
    /** A listed run by its member id. */
    member: (id: string): RunMember | undefined => answer?.items.find((m) => m.id === id),
  }
}
