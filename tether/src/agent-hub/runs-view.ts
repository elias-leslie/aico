// A workflow run as Aico shows it: one member for the run and one per step
// (contracts.ts `RunMember`). Pure: the tracker (runs.ts) feeds it Agent Hub's
// run view and the session that launched the run. Both name that session as
// their coordinator; the session lists show only the steps (client `childAgents`).
//
// State words, in the owner's terms:
//   run   running -> working, needs_owner -> needs you, completed -> finished,
//         failed or cancelled -> ended (no status group, the word says which);
//   step  running -> working with its live phase (thinking, writing, tool x),
//         waiting on the owner -> needs you, pending and done -> idle,
//         failed, refused or cancelled -> ended.

import type { RunView, StepAttempt, StepView } from '@agent-hub/sdk'
import { executorTool, type RunMember, type TeamGroup } from '../client/index'

/** Where plan changes happen. They stay with the coordinator. */
export const FOLLOW_UP_HINT =
  'Change the plan from the coordinator: st workflow add-step, revise or remove-step.'

const ACTIVE_RUN = new Set(['running', 'needs_owner'])
const ENDED_RUN = new Set(['completed', 'failed', 'cancelled'])

export const isActiveRun = (state: string | undefined | null): boolean =>
  ACTIVE_RUN.has(state ?? '')
export const isEndedRun = (state: string | undefined | null): boolean => ENDED_RUN.has(state ?? '')

/** Agent Hub sends ISO times, sometimes without a zone (UTC), and a pause's
 * time as epoch seconds. */
export function parseTime(value: unknown): number | null {
  if (typeof value === 'number')
    return Number.isFinite(value) ? (value < 1e11 ? value * 1000 : value) : null
  if (typeof value !== 'string' || !value) return null
  const zoned = /(Z|[+-]\d\d:?\d\d)$/.test(value) ? value : `${value}Z`
  const at = Date.parse(zoned)
  return Number.isFinite(at) ? at : null
}

/** `provider_retry` -> `provider retry`, `tool:bash` -> `tool bash`. */
export function phaseWord(phase: unknown): string | null {
  if (typeof phase !== 'string' || !phase) return null
  if (phase.startsWith('tool:')) return `tool ${phase.slice(5)}`
  // Agent Hub's phase before the harness has said anything; "waiting" alone
  // would read as waiting for the owner.
  if (phase === 'waiting') return 'waiting for output'
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

export const runMemberId = (runId: string): string => `run:${runId}`
export const stepMemberId = (runId: string, key: string): string => `step:${runId}:${key}`

/** The steps the owner is asked about, with the time each began waiting.
 * A step that failed is listed in `pause.failed`, not `pause.waiting`; a pause
 * saved before either existed names its one step itself. */
function waitingSteps(view: RunView): Map<string, { at: number | null; reason: string | null }> {
  const pause = view.pause
  const out = new Map<string, { at: number | null; reason: string | null }>()
  if (view.state !== 'needs_owner' || !pause) return out
  const stepKey = typeof pause.step_key === 'string' ? pause.step_key : null
  const failed = pause.reason === 'step_failed' ? asEntries(pause.failed) : null
  const listed =
    asEntries(pause.waiting) ??
    failed ??
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

function asEntries(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** The attempt the step is on now (the latest), if it has one. */
function latestAttempt(step: StepView): StepAttempt | null {
  const history = step.attempt_history
  return history?.length ? (history[history.length - 1] ?? null) : null
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
    // A step shows under the session that launched the run.
    coordinatorId: ctx.launcherId,
    runId: view.id,
    stepKey: step.key,
    title: step.key,
    group: wait ? 'needs-you' : (STEP_GROUP[status] ?? 'no-status'),
    at: wait?.at ?? (running ? parseTime(attempt?.started_at) : null) ?? runAt,
    word,
    status,
    url: ctx.url,
    agent: step.agent_slug ?? null,
    tool: executorTool(attempt?.executor ?? step.executor),
    requestedModel: requested,
    servedModel: served,
    // Agent Hub's own answer wins; names are compared only when it gives none (ids come in several spellings).
    fallback:
      typeof attempt?.fallback_used === 'boolean'
        ? attempt.fallback_used
        : Boolean(requested && served && requested !== served),
    attempt: typeof step.attempts === 'number' ? step.attempts : null,
    attemptLimit: typeof step.attempt_limit === 'number' ? step.attempt_limit : null,
    reason: wait?.reason ?? (status === 'failed' || status === 'refused' ? outcomeReason : null),
    session: Boolean(attempt?.session_id),
    can: {
      decide: Boolean(wait) && decidable,
      cancel: !ended && !cancelling && !finished && !['failed', 'refused'].includes(status),
      dismiss: false,
    },
    cancelling,
    hint: null,
    progress: null,
    headline: null,
  }
}

/** `2 of 5 done`: the steps that are over (done or skipped) of all of them. */
export function runProgress(steps: readonly RunMember[]): string | null {
  if (!steps.length) return null
  const over = steps.filter((s) => s.status === 'completed' || s.status === 'skipped').length
  return `${over} of ${steps.length} done`
}

/** `lint-fix needs a decision`: the run's state in words, naming the steps
 * that need the owner or are working. */
function runHeadline(
  view: RunView,
  steps: readonly RunMember[],
  waiting: ReturnType<typeof waitingSteps>,
  blocked: boolean,
): string {
  const state = String(view.state)
  const names = (keys: string[], one: string, many: string): string =>
    keys.length === 1
      ? `${keys[0]} ${one}`
      : keys.length <= 3
        ? `${keys.join(', ')} ${many}`
        : `${keys.length} steps ${many}`
  if (view.cancelling === true) return 'cancelling'
  if (state === 'needs_owner') {
    if (blocked) return 'blocked by a step that did not finish'
    if (waiting.size) return names([...waiting.keys()], 'needs a decision', 'need a decision')
    const why = plain(view.pause?.reason)
    return why ? `needs a decision: ${why}` : 'needs a decision'
  }
  if (state === 'running') {
    const working = steps.filter((s) => s.status === 'running').map((s) => s.title)
    return working.length ? names(working, 'working', 'working') : 'running'
  }
  if (state === 'completed') return 'finished'
  if (state === 'failed') {
    const why = failureText(view.failure)
    return why ? `failed: ${why}` : 'failed'
  }
  if (state === 'cancelled') return 'cancelled'
  return RUN_WORD[state] ?? state
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
  const progress = runProgress(steps)
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
    tool: null,
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
    session: false,
    cancelling,
    hint: isActiveRun(state) ? FOLLOW_UP_HINT : null,
    progress,
    headline: runHeadline(view, steps, waiting, blocked),
  }
  return [run, ...steps]
}

// --- the note to the coordinator ----------------------------------------------------

/** What the launching session is told when a run waits for the owner. */
export interface PauseNotice {
  /** Names this pause; a new pause on the same run has another key. */
  key: string
  /** One line, at most `maxChars` characters. */
  text: string
}

const MAX_STEP_COMMANDS = 3

/**
 * The note for a run that has just paused: which run and step, why, and the
 * exact command that answers it. The coordinator asks the owner and runs it
 * only on their word. Null while the run is not waiting for the owner.
 */
export function pauseNotice(view: RunView, maxChars: number): PauseNotice | null {
  if (view.state !== 'needs_owner') return null
  const waiting = waitingSteps(view)
  const blocked = view.pause?.reason === 'blocked_dependencies'
  const keys = [...waiting.keys()]
  const key = `${view.pause?.at ?? ''}|${view.pause?.reason ?? ''}|${[...keys].sort().join(',')}`
  const resume = (stepKey: string | null) =>
    `st workflow resume ${view.id}${stepKey ? ` --step ${stepKey}` : ''} --action retry|skip|fail`
  const build = (goalMax: number, withReasons: boolean): string => {
    const goal = clipText(
      typeof view.goal === 'string' && view.goal ? view.goal : 'Workflow run',
      goalMax,
    )
    const head = `Workflow run "${goal}" (${view.id})`
    if (blocked)
      return `${head} is blocked: a step depends on one that did not finish. Change the plan (st workflow revise or remove-step) or ask the owner.`
    const shown = keys.slice(0, MAX_STEP_COMMANDS)
    const why = (stepKey: string): string => {
      const reason = withReasons ? waiting.get(stepKey)?.reason : null
      return reason ? ` (${clipText(reason, 60)})` : ''
    }
    const what = keys.length
      ? `needs the owner to decide: ${shown.map((k) => `step ${k}${why(k)}`).join(', ')}${keys.length > shown.length ? ` and ${keys.length - shown.length} more` : ''}`
      : `needs the owner to decide${withReasons && plain(view.pause?.reason) ? ` (${plain(view.pause?.reason)})` : ''}`
    const commands = keys.length ? shown.map(resume) : [resume(null)]
    return `${head} ${what}. Ask the owner, then run only their answer: ${commands.join(' ; ')}`
  }
  let text = build(60, true)
  if (text.length > maxChars) text = build(60, false)
  if (text.length > maxChars) text = build(24, false)
  if (text.length > maxChars) text = text.slice(0, maxChars)
  // One line of plain characters, as a wake note must be.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  text = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim()
  return { key, text }
}

function clipText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
