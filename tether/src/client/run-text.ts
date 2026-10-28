// The words a row says about a workflow run or step, shared by the desktop tray
// and the web list. Pure.

import type { TeamMember } from './teams'

// --- Workflow runs (docs/api-v1.md "Workflow runs"), types shared with clients

/**
 * A workflow run or one of its steps as a team member: the run folds under the
 * session that launched it (`coordinatorId` is that session's id), a step
 * under its run. Tether words the state; clients show it.
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
  /** The model asked for and the one that answered; both null on a run. */
  requestedModel: string | null
  servedModel: string | null
  /** A different model answered than the one asked for. */
  fallback: boolean
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

/** `opencode-go/deepseek-v4.1-flash` -> `deepseek-v4.1-flash`. */
export function shortModel(id: string | null): string | null {
  if (!id) return null
  return id.slice(id.lastIndexOf('/') + 1) || id
}

/** The model a step asked for and the one that answered: `a`, or
 * `a → b` when another model answered. Null before any model is known. */
export function modelLine(
  member: Pick<RunMember, 'requestedModel' | 'servedModel'>,
): string | null {
  const asked = shortModel(member.requestedModel)
  const answered = shortModel(member.servedModel)
  if (asked && answered && asked !== answered) return `${asked} → ${answered}`
  return answered ?? asked
}

/** `try 2 of 3` once a step has started, else null. */
export function attemptText(member: Pick<RunMember, 'attempt' | 'attemptLimit'>): string | null {
  const { attempt, attemptLimit } = member
  if (!attempt || attempt < 1) return null
  return attemptLimit ? `try ${attempt} of ${attemptLimit}` : `try ${attempt}`
}

/** What a row says after its name: a step's state, models and attempts; a run's state. */
export function runDetail(member: RunMember): string {
  const parts: (string | null)[] =
    member.kind === 'step'
      ? [member.word, modelLine(member), member.fallback ? 'fallback' : null, attemptText(member)]
      : [member.word]
  return parts.filter(Boolean).join(' · ')
}

export const DECISION_LABEL: Record<RunDecision, string> = {
  retry: 'Retry',
  skip: 'Skip',
  fail: 'Fail',
}

export const DECISIONS: readonly RunDecision[] = ['retry', 'skip', 'fail']
