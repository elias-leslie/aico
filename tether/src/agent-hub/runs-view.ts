// A workflow run as Aico shows it: one member for the run and one per step
// (contracts.ts `RunMember`). Pure: the tracker (runs.ts) feeds it Agent Hub's
// run view and the session that launched the run.
//
// State words, in the owner's terms:
//   run   running -> working, needs_owner -> needs you, completed -> finished,
//         failed or cancelled -> ended (no status group, the word says which);
//   step  running -> working with its live phase (thinking, writing, tool x),
//         waiting on the owner -> needs you, pending and done -> idle,
//         failed, refused or cancelled -> ended.

import type { RunView, StepAttempt, StepView } from '@agent-hub/sdk'
import type { RunMember, TeamGroup } from '../client'

/** Where plan changes happen. They stay with the coordinator. */
export const FOLLOW_UP_HINT =
  'Change the plan from the coordinator: st workflow add-step, revise or remove-step.'

const ACTIVE_RUN = new Set(['running', 'needs_owner'])
const ENDED_RUN = new Set(['completed', 'failed', 'cancelled'])

export const isActiveRun = (state: string | undefined | null): boolean =>
  ACTIVE_RUN.has(state ?? '')
export const isEndedRun = (state: string | undefined | null): boolean => ENDED_RUN.has(state ?? '')

/** Agent Hub sends ISO times, sometimes without a zone (UTC). */
export function parseTime(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null
  const zoned = /(Z|[+-]\d\d:?\d\d)$/.test(value) ? value : `${value}Z`
  const at = Date.parse(zoned)
  return Number.isFinite(at) ? at : null
}

/** `provider_retry` -> `provider retry`, `tool:bash` -> `tool bash`. */
export function phaseWord(phase: unknown): string | null {
  if (typeof phase !== 'string' || !phase) return null
  if (phase.startsWith('tool:')) return `tool ${phase.slice(5)}`
  return phase.replaceAll('_', ' ')
}

const plain = (text: unknown): string | null =>
  typeof text === 'string' && text ? text.replaceAll('_', ' ') : null

/** The failure's own words when it has any. */
function failureText(failure: unknown): string | null {
  if (typeof failure === 'string') return plain(failure)
  if (failure && typeof failure === 'object') {
    const f = failure as { reason?: unknown; message?: unknown }
    return plain(f.reason) ?? plain(f.message)
  }
  return null
}

interface Context {
  /** The launching session's Tether id. */
  launcherId: string
  /** The run page. */
  url: string
}

const RUN_WORD: Record<string, string> = {
  running: 'running',
  needs_owner: 'waiting for you',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
}

const RUN_GROUP: Record<string, TeamGroup> = {
  running: 'working',
  needs_owner: 'needs-you',
  completed: 'finished',
  failed: 'no-status',
  cancelled: 'no-status',
}

const STEP_WORD: Record<string, string> = {
  pending: 'pending',
  running: 'running',
  needs_owner: 'waiting for you',
  completed: 'done',
  skipped: 'skipped',
  cancelled: 'cancelled',
  failed: 'failed',
  refused: 'refused',
}

const STEP_GROUP: Record<string, TeamGroup> = {
  pending: 'idle',
  running: 'working',
  needs_owner: 'needs-you',
  completed: 'idle',
  skipped: 'idle',
  cancelled: 'no-status',
  failed: 'no-status',
  refused: 'no-status',
}

const SUMMARY_ORDER = [
  'running',
  'waiting for you',
  'pending',
  'done',
  'skipped',
  'failed',
  'refused',
  'cancelled',
] as const

export const runMemberId = (runId: string): string => `run:${runId}`
export const stepMemberId = (runId: string, key: string): string => `step:${runId}:${key}`

/** The steps the owner is asked about, with the time each began waiting. */
function waitingSteps(view: RunView): Map<string, { at: number | null; reason: string | null }> {
  const pause = view.pause
  const out = new Map<string, { at: number | null; reason: string | null }>()
  if (view.state !== 'needs_owner' || !pause) return out
  // A pause saved before the list existed names its one step itself.
  const stepKey = typeof pause.step_key === 'string' ? pause.step_key : null
  const listed =
    pause.waiting ??
    (stepKey && pause.reason !== 'step_failed' && pause.reason !== 'blocked_dependencies'
      ? { [stepKey]: null }
      : {})
  for (const [key, entry] of Object.entries(listed)) {
    out.set(key, {
      at: parseTime((entry as { at?: unknown } | null)?.at) ?? parseTime(pause.at),
      reason: plain((entry as { reason?: unknown } | null)?.reason) ?? plain(pause.reason),
    })
  }
  return out
}

/** The attempt the step is on now (the latest), if it has one. */
function latestAttempt(step: StepView): StepAttempt | null {
  const history = step.attempt_history
  return history && history.length ? (history[history.length - 1] ?? null) : null
}

function stepMember(
  view: RunView,
  step: StepView,
  waiting: ReturnType<typeof waitingSteps>,
  runAt: number | null,
  decidable: boolean,
  ctx: Context,
): RunMember {
  const wait = waiting.get(step.key)
  const status = String(step.status)
  const attempt = latestAttempt(step)
  const live = step.live as { phase?: unknown } | null | undefined
  const running = status === 'running'
  const word = wait
    ? 'waiting for you'
    : ((running ? phaseWord(live?.phase) : null) ?? STEP_WORD[status] ?? status)
  const requested = attempt?.requested_model ?? step.chain?.[0] ?? step.chosen_model ?? null
  const served =
    attempt?.served_model ?? (status === 'completed' ? (attempt?.effective_model ?? null) : null)
  const finished = ['completed', 'skipped', 'cancelled'].includes(status)
  const cancelling = step.cancelling === true
  const ended = isEndedRun(view.state)
  const outcomeReason = plain((step.outcome as { reason?: unknown } | null | undefined)?.reason)
  return {
    id: stepMemberId(view.id, step.key),
    kind: 'step',
    coordinator: false,
    coordinatorId: runMemberId(view.id),
    runId: view.id,
    stepKey: step.key,
    title: step.key,
    group: wait ? 'needs-you' : (STEP_GROUP[status] ?? 'no-status'),
    at: wait?.at ?? runAt,
    word,
    status,
    url: ctx.url,
    agent: step.agent_slug ?? null,
    requestedModel: requested,
    servedModel: served,
    fallback:
      attempt?.fallback_used === true || Boolean(requested && served && requested !== served),
    attempt: typeof step.attempts === 'number' ? step.attempts : null,
    attemptLimit: typeof step.attempt_limit === 'number' ? step.attempt_limit : null,
    reason: wait?.reason ?? (status === 'failed' || status === 'refused' ? outcomeReason : null),
    can: {
      decide: Boolean(wait) && decidable,
      cancel: !ended && !cancelling && !finished && !['failed', 'refused'].includes(status),
      dismiss: false,
    },
    cancelling,
    hint: null,
    summary: null,
  }
}

/** `2 done · 1 working`, counting the steps in the owner's words. */
export function stepSummary(steps: readonly RunMember[]): string | null {
  if (!steps.length) return null
  const counts = new Map<string, number>()
  for (const step of steps) {
    const key =
      step.status === 'running'
        ? 'running'
        : step.group === 'needs-you'
          ? 'waiting for you'
          : (STEP_WORD[step.status] ?? step.status)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const known = SUMMARY_ORDER.filter((word) => counts.has(word))
  const other = [...counts.keys()].filter(
    (word) => !(SUMMARY_ORDER as readonly string[]).includes(word),
  )
  return [...known, ...other]
    .map((word) => `${counts.get(word)} ${word === 'running' ? 'working' : word}`)
    .join(' · ')
}

/** The run, then its steps in plan order. */
export function runMembers(view: RunView, ctx: Context): RunMember[] {
  const state = String(view.state)
  const waiting = waitingSteps(view)
  const blocked = view.pause?.reason === 'blocked_dependencies'
  const runAt =
    parseTime(view.pause?.at && state === 'needs_owner' ? view.pause.at : null) ??
    parseTime(view.last_activity_at) ??
    parseTime(view.created_at)
  const steps = [...(view.steps ?? [])]
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((step) => stepMember(view, step, waiting, runAt, !blocked, ctx))
  const cancelling = view.cancelling === true
  const goal = typeof view.goal === 'string' && view.goal ? view.goal : 'Workflow run'
  const run: RunMember = {
    id: runMemberId(view.id),
    kind: 'run',
    coordinator: false,
    coordinatorId: ctx.launcherId,
    runId: view.id,
    stepKey: null,
    title: goal,
    group: RUN_GROUP[state] ?? 'no-status',
    at: runAt,
    word: cancelling ? 'cancelling' : (RUN_WORD[state] ?? state),
    status: state,
    url: ctx.url,
    agent: null,
    requestedModel: null,
    servedModel: null,
    fallback: false,
    attempt: null,
    attemptLimit: null,
    reason:
      state === 'needs_owner'
        ? plain(view.pause?.reason)
        : state === 'failed'
          ? failureText(view.failure)
          : null,
    can: {
      // A pause that names no step (a merge conflict) is decided on the run.
      decide: state === 'needs_owner' && waiting.size === 0 && !blocked,
      cancel: isActiveRun(state) && !cancelling,
      dismiss: isEndedRun(state),
    },
    cancelling,
    hint: isActiveRun(state) ? FOLLOW_UP_HINT : null,
    summary: stepSummary(steps),
  }
  return [run, ...steps]
}
