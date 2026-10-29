// Workflow runs in the desktop: the runs and steps Tether lists (a run under the
// session that launched it, its steps under the run) as tray rows, the signal a
// run raises when it needs the owner, and what the owner can do to one.
//
// Run state belongs to Agent Hub and is read by Tether; this holds the last
// answer, feeds it to the same attention tracker sessions use (a run that
// needs the owner lights the tray icon and sends the same phone push), and
// turns a tray choice into a Tether call.

import {
  type RunMember,
  type RunsAnswer,
  runDetail,
  TetherError,
  TetherUnavailable,
} from 'tether/client'
import type { AgentState } from './attention'
import type { RunAction, TrayWidget } from './tray'

interface RunsDeps {
  attention: {
    updateId(id: string, state: AgentState, at: number | null): void
    removed(id: string): void
  }
  /** Rebuild the tray. */
  tray(): void
  tether: {
    resumeRun(
      runId: string,
      action: 'retry' | 'skip' | 'fail',
      stepKey?: string | null,
    ): Promise<unknown>
    cancelRun(runId: string, stepKey?: string | null): Promise<unknown>
  }
  /** Read the runs again now. */
  refresh(): Promise<unknown>
  openExternal(url: string): Promise<unknown>
  /** Read a step's latest attempt in a window with no input. */
  openStep(viewer: { runId: string; stepKey: string; title: string }): void
  dialog: {
    showMessageBox(options: Electron.MessageBoxOptions): Promise<{ response: number }>
    showErrorBox(title: string, content: string): void
  }
}

/** A tray choice's failure in the owner's words. */
export function runFailure(error: unknown): string {
  if (error instanceof TetherUnavailable) return 'Tether is not reachable.'
  if (error instanceof TetherError) {
    const reason = error.reason
    switch (error.code) {
      case 'agent_hub_unavailable':
        return 'Agent Hub is not reachable.'
      case 'agent_hub_refused':
        return reason ? `Agent Hub did not accept it: ${reason}` : 'Agent Hub did not accept it.'
      case 'unknown_run':
      case 'unknown_step':
        return 'That run is no longer listed. It may have ended.'
      case 'not_allowed':
        return reason ?? 'That is not possible now.'
    }
  }
  return 'Something went wrong; the run was not changed.'
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

  /** Runs and steps as tray rows. */
  function widgets(): TrayWidget[] {
    return (answer?.items ?? []).map((member) => ({
      id: member.id,
      label: member.title,
      open: false,
      group: member.group,
      detail: runDetail(member),
      at: member.at,
      coordinator: false,
      coordinatorId: member.coordinatorId,
      kind: member.kind,
      summary: member.summary ?? null,
      run: member,
    }))
  }

  /** A line for the top of the tray when the runs may be out of date; null when fresh. */
  function notice(): string | null {
    if (!answer || answer.status === 'ok') return null
    const why = answer.error ?? 'Agent Hub is not reachable'
    return answer.status === 'stale'
      ? `Workflow runs may be out of date: ${why}`
      : `Workflow runs unavailable: ${why}`
  }

  async function confirm(message: string, detail: string, button: string): Promise<boolean> {
    const response = await deps.dialog.showMessageBox({
      type: 'warning',
      buttons: ['Keep going', button],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: button,
      message,
      detail,
    })
    return response.response === 1
  }

  function find(runId: string, stepKey: string | null): RunMember | undefined {
    return answer?.items.find((m) => m.runId === runId && m.stepKey === stepKey)
  }

  async function handle(action: RunAction): Promise<void> {
    try {
      switch (action.type) {
        case 'open': {
          const url = new URL(action.url)
          if (url.protocol !== 'http:' && url.protocol !== 'https:') return
          await deps.openExternal(url.toString())
          return
        }
        case 'openStep': {
          const step = find(action.runId, action.stepKey)
          const run = find(action.runId, null)
          if (!step?.session) return
          deps.openStep({
            runId: action.runId,
            stepKey: action.stepKey,
            title: run ? `${step.title} — ${run.title}` : step.title,
          })
          return
        }
        case 'resume': {
          const target = find(action.runId, action.stepKey)
          const name = target?.title ?? 'this'
          if (
            action.action === 'fail' &&
            !(await confirm(
              `Fail ${target?.kind === 'step' ? 'step' : 'run'} ${name}?`,
              'The workflow records it as failed and carries on without it.',
              'Fail it',
            ))
          )
            return
          await deps.tether.resumeRun(action.runId, action.action, action.stepKey)
          break
        }
        case 'cancel': {
          const target = find(action.runId, action.stepKey)
          const what = action.stepKey ? 'step' : 'run'
          if (
            !(await confirm(
              `Cancel ${what} ${target?.title ?? ''}?`.replace('  ', ' '),
              action.stepKey
                ? 'The step stops. The rest of the run carries on.'
                : 'The run and its steps stop. This cannot be undone.',
              `Cancel ${what}`,
            ))
          )
            return
          await deps.tether.cancelRun(action.runId, action.stepKey)
          break
        }
      }
      await deps.refresh()
    } catch (error) {
      deps.dialog.showErrorBox('Workflow run', runFailure(error))
      await deps.refresh().catch(() => undefined)
    }
  }

  return {
    apply,
    widgets,
    notice,
    handle,
    /** A listed run or step by its member id. */
    member: (id: string): RunMember | undefined => answer?.items.find((m) => m.id === id),
  }
}
