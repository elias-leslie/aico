// The words a row says about a workflow run or step, shared by the desktop tray
// and the web list. Pure.

import type { RunDecision, RunMember } from './contracts'

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
