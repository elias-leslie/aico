// A workflow run or step as Tether lists it, and which steps the session lists
// show: only a step that is running or waiting for the owner, as a child agent
// of the session that launched the run. Shared by the desktop tray and the web
// list. Pure.

import type { TeamMember } from './teams'

// --- Workflow runs (docs/api-v1.md "Workflow runs"), types shared with clients

/**
 * A workflow run or one of its steps as a team member. A run names the session
 * that launched it (`coordinatorId`); so does a step, which shows under that
 * session as a child agent. Tether words the state; clients show it.
 */
export interface RunMember extends TeamMember {
  kind: 'run' | 'step'
  coordinator: false
  coordinatorId: string
  runId: string
  /** The step's key; null on a run. */
  stepKey: string | null
  /** The run's goal, or the step's key. */
  title: string
  /** What the row is doing: `thinking`, `tool bash`, `waiting for you`, `failed`. */
  word: string
  /** The run's state or the step's status as Agent Hub names it. */
  status: string
  /** The run page in Agent Hub. */
  url: string
  agent: string | null
  /** A step: the Aico tool slug of what runs it (`pi`, `codex`, `claude-code`,
   * `agent-hub`); null on a run. */
  tool: string | null
  /** The model asked for and the one that answered; both null on a run. */
  requestedModel: string | null
  servedModel: string | null
  /** A different model answered than the one asked for. */
  fallback: boolean
  /** A step: its latest attempt has a session to read. */
  session: boolean
  /** A run: `2 of 5 done`. */
  progress: string | null
  /** A run's state in words: `lint-fix needs a decision`. */
  headline: string | null
  /** The current attempt and how many the step may use. */
  attempt: number | null
  attemptLimit: number | null
  /** Why it waits or failed, in plain words. */
  reason: string | null
  /** What the owner may do here; Tether checks again when asked. */
  can: { decide: boolean; cancel: boolean; dismiss: boolean }
  cancelling: boolean
  /** How to change the plan (it stays with the coordinator); on a live run. */
  hint: string | null
}

/** `GET /v1/runs`: `stale` shows the last answer after a failed look,
 * `unavailable` means Agent Hub was never reached since Tether started. */
export interface RunsAnswer {
  status: 'ok' | 'stale' | 'unavailable'
  /** Why the last look failed, in plain words; null when it worked. */
  error: string | null
  /** When the last look succeeded (ms), or null. */
  updatedAt: number | null
  items: RunMember[]
}

export type RunDecision = 'retry' | 'skip' | 'fail'

/** The steps a session list shows, as child agents of the session that launched
 * the run: those running or waiting for the owner (a failed step that paused the
 * run waits for a decision). Pending, finished, skipped, cancelled and failed
 * steps do not show, and neither does a run. */
export function childAgents(items: readonly RunMember[]): RunMember[] {
  return items.filter(
    (m) => m.kind === 'step' && (m.group === 'working' || m.group === 'needs-you'),
  )
}
