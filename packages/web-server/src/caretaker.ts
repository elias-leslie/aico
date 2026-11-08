// `aico caretaker`: the agent nobody has to watch. When a Status problem outlasts self-healing, one
// question to a good model (Antigravity first, the Gemini free tier when the subscription isn't
// there), one action from a list kept as data, and one look to see whether it cleared.
//
// The leash is the shape, not a prompt: the model has no tools and answers with an action id; only
// ids listed for that row do anything, and the command comes from data/caretaker.json, run without a
// shell. One attempt per problem, a daily limit on actions and on model calls, every step logged and
// the last one on a Status row. A row that major.ts counts as an outage, or one the policy calls
// serious, gets one phone notice when the action didn't clear it, under the key of Status's own
// sustained notice, so the owner hears once. A backup still failing reaches the phone only through
// that sustained notice, after its retry window.

import { maskSecrets } from '@aico/shared/secrets'
import { type Action, majorOf } from '@aico/status'
import policyData from '../data/caretaker.json' with { type: 'json' }

export interface CaretakerAction {
  id: string
  what: string
  /** Row ids this action may be used for (`*` matches anything). */
  rows: string[]
  argv: string[]
  verify_minutes?: number
}

export type Policy = typeof policyData & { actions: CaretakerAction[] }
export const POLICY = policyData as Policy

export interface ProblemRow {
  id: string
  what: string
  kind: string
  machine: string
  shown: string
  machine_off?: true
  meaning?: string
  actions?: Action[]
}

interface Episode {
  at: number
  action: string
  verifyAt: number
  /** waiting: the action ran, its look is due. done: nothing more this round. */
  stage: 'waiting' | 'done'
  noticeKey?: string
}

export interface CaretakerState {
  /** When each bad row was first seen bad. */
  seen: Record<string, number>
  episodes: Record<string, Episode>
  day: string
  actions: number
  calls: number
  /** Things said once a day (limit reached, no model answering). */
  said: string[]
}

export const emptyState = (): CaretakerState => ({
  seen: {},
  episodes: {},
  day: '',
  actions: 0,
  calls: 0,
  said: [],
})

export interface Answer {
  diagnosis: string
  action: string
}

export type ModelAnswer = Answer & { model: string }

export interface CaretakerDeps {
  now(): number
  /** The rows as a reader sees them. */
  rows(): Promise<ProblemRow[]>
  /** One question through the chain, or why nothing answered. */
  ask(question: string): Promise<ModelAnswer | { failed: string }>
  /** Runs a command from the policy, or a read-only evidence command; exit code and output. */
  run(argv: string[]): Promise<{ code: number; output: string }>
  notify(notice: Record<string, unknown>): Promise<void>
  resolve(key: string, text: string): Promise<void>
  log(event: CaretakerEvent): void
}

export interface CaretakerEvent {
  at: string
  row?: string
  /** noticed, diagnosed, refused, acted, cleared, stayed, skipped, limit, no-model, notified */
  what: string
  text: string
  model?: string
}

const glob = (pattern: string, text: string) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`).test(text)
const matches = (patterns: readonly string[], text: string) =>
  patterns.some((pattern) => glob(pattern, text))

/** The actions the model may name for this row. */
export const actionsFor = (policy: Policy, rowId: string): CaretakerAction[] =>
  policy.actions.filter((action) => matches(action.rows, rowId))

function isProblem(policy: Policy, row: ProblemRow): boolean {
  return (
    !row.machine_off &&
    policy.kinds.includes(row.kind) &&
    policy.states.includes(row.shown) &&
    !matches(policy.ignore, row.id)
  )
}

/** Whether the owner hears about this row from us when the action didn't clear it. */
function isSerious(policy: Policy, row: ProblemRow): boolean {
  return majorOf(row, new Map()) === 'outage' || matches(policy.serious, row.id)
}

/** The key of Status's own sustained notice (status-actions.ts sustainedKey): the owner hears once. */
const noticeKey = (rowId: string) => `status-sustained:${rowId}`.slice(0, 200)

/** The read-only commands a row names for itself that the policy allows, as argv. */
function evidenceCommands(policy: Policy, row: ProblemRow): string[][] {
  const refs = (row.actions ?? []).filter((a) => a.kind === 'log').map((a) => a.ref)
  return refs
    .filter((ref) => policy.evidence.some((pattern) => new RegExp(pattern).test(ref)))
    .map((ref) => ref.split(' '))
}

async function evidence(policy: Policy, row: ProblemRow, deps: CaretakerDeps): Promise<string> {
  const parts: string[] = []
  for (const argv of evidenceCommands(policy, row)) {
    const { code, output } = await deps.run(argv)
    parts.push(`$ ${argv.join(' ')} (exit ${code})\n${output}`)
  }
  const text = maskSecrets(parts.join('\n\n'))
  return text.slice(-policy.evidence_bytes)
}

export function question(
  policy: Policy,
  row: ProblemRow,
  candidates: CaretakerAction[],
  logs: string,
): string {
  const list = candidates.map((a) => `- ${a.id}: ${a.what}`).join('\n') || '(none for this row)'
  return [
    policy.prompt.join('\n'),
    `Actions:\n${list}`,
    `Row:\n${maskSecrets(JSON.stringify({ id: row.id, what: row.what, kind: row.kind, machine: row.machine, shown: row.shown, meaning: row.meaning }))}`,
    `Logs:\n${logs || '(no log this row allows)'}`,
  ].join('\n\n')
}

/** What the model may answer with. `action` stays a plain string: the list is enforced in code, where a refusal is logged. */
export const ANSWER_SCHEMA = {
  type: 'object',
  properties: { diagnosis: { type: 'string' }, action: { type: 'string' } },
  required: ['diagnosis', 'action'],
}

/** The chain: each Antigravity model through `ask`, then the free-tier key. */
export async function askChain(
  policy: Policy,
  text: string,
  via: {
    sub(model: string, text: string): Promise<{ data?: unknown; text?: string; failed?: string }>
    free(model: string, text: string): Promise<string>
  },
): Promise<ModelAnswer | { failed: string }> {
  const failures: string[] = []
  for (const model of policy.models) {
    const out = await via.sub(model, text)
    const answer = parseAnswer(out.data ?? out.text)
    if (answer) return { ...answer, model }
    failures.push(`${model}: ${out.failed ?? 'answer did not fit'}`)
  }
  for (const model of policy.free_tier_models) {
    try {
      const answer = parseAnswer(
        await via.free(
          model,
          `${text}\n\nAnswer with only a JSON object with the string fields diagnosis and action.`,
        ),
      )
      if (answer) return { ...answer, model }
      failures.push(`${model}: answer did not fit`)
    } catch (error) {
      failures.push(`${model}: ${(error as Error).message}`)
    }
  }
  return { failed: failures.join('; ') }
}

export function parseAnswer(raw: unknown): Answer | null {
  let value = raw
  if (typeof value === 'string') {
    const start = value.indexOf('{')
    const end = value.lastIndexOf('}')
    if (start < 0 || end < start) return null
    try {
      value = JSON.parse(value.slice(start, end + 1))
    } catch {
      return null
    }
  }
  const { diagnosis, action } = (value ?? {}) as Record<string, unknown>
  return typeof diagnosis === 'string' && typeof action === 'string'
    ? { diagnosis: diagnosis.slice(0, 600), action: action.trim() }
    : null
}

const iso = (ms: number) => new Date(ms).toISOString()

/** One pass: note what's bad, look at earlier actions, act on what has settled. */
export async function pass(
  policy: Policy,
  state: CaretakerState,
  deps: CaretakerDeps,
): Promise<void> {
  const now = deps.now()
  const today = iso(now).slice(0, 10)
  if (state.day !== today) Object.assign(state, { day: today, actions: 0, calls: 0, said: [] })
  const say = (event: Omit<CaretakerEvent, 'at'>) => deps.log({ at: iso(deps.now()), ...event })
  const sayOnce = (key: string, event: Omit<CaretakerEvent, 'at'>) => {
    if (state.said.includes(key)) return
    state.said.push(key)
    say(event)
  }

  const rows = await deps.rows()
  const bad = new Map(rows.filter((row) => isProblem(policy, row)).map((row) => [row.id, row]))
  const byId = new Map(rows.map((row) => [row.id, row]))

  for (const id of Object.keys(state.seen)) if (!bad.has(id)) delete state.seen[id]
  for (const id of bad.keys()) state.seen[id] ??= now

  const tell = async (row: ProblemRow, episode: Episode, detail: string) => {
    if (!isSerious(policy, row)) return
    const key = noticeKey(row.id)
    await deps.notify({
      v: 1,
      source: 'aico',
      kind: 'alert',
      severity: 'critical',
      title: `${row.what} is still down`.slice(0, 200),
      body: detail.slice(0, 1000),
      key,
      cooldown: 7 * 24 * 3600,
      push: 'phone',
      interrupt: 'needs-you',
    })
    episode.noticeKey = key
    say({ row: row.id, what: 'notified', text: `Told the owner: ${detail}` })
  }

  // Earlier actions: cleared, or still bad once their look is due.
  for (const [id, episode] of Object.entries(state.episodes)) {
    const row = bad.get(id)
    if (!row) {
      const shown = byId.get(id)?.shown
      if (episode.stage === 'waiting' && shown !== 'off')
        say({ row: id, what: 'cleared', text: `${episode.action} cleared it.` })
      if (episode.noticeKey) await deps.resolve(episode.noticeKey, 'Back to normal.')
      // A problem that comes straight back is the same problem until retry_after_hours has passed.
      if (now - episode.at >= policy.retry_after_hours * 3600_000) delete state.episodes[id]
      else {
        episode.stage = 'done'
        delete episode.noticeKey
      }
      continue
    }
    if (episode.stage === 'waiting' && now >= episode.verifyAt) {
      episode.stage = 'done'
      const text = `${episode.action} did not clear it; stopping here.`
      say({ row: id, what: 'stayed', text })
      await tell(
        row,
        episode,
        `${row.meaning ?? row.what} Caretaker tried ${episode.action}; it did not help.`,
      )
    }
  }

  // What has settled and has had no attempt.
  for (const [id, row] of bad) {
    if (state.episodes[id]) continue
    if (now - (state.seen[id] as number) < policy.settle_minutes * 60_000) continue
    const candidates = actionsFor(policy, id)
    const serious = isSerious(policy, row)
    if (!candidates.length && !serious) {
      sayOnce(`skip:${id}`, { row: id, what: 'skipped', text: 'Nothing on the list for this row.' })
      continue
    }
    if (state.calls >= policy.max_model_calls_per_day) {
      sayOnce('limit:calls', { what: 'limit', text: 'Daily limit on model calls reached.' })
      continue
    }
    if (candidates.length && state.actions >= policy.max_actions_per_day) {
      sayOnce('limit:actions', { what: 'limit', text: 'Daily limit on actions reached.' })
      continue
    }
    state.calls += 1
    const logs = await evidence(policy, row, deps)
    const answer = await deps.ask(question(policy, row, candidates, logs))
    if ('failed' in answer) {
      sayOnce('no-model', {
        row: id,
        what: 'no-model',
        text: `No model answered: ${answer.failed}`,
      })
      continue
    }
    const { diagnosis, model } = answer
    say({ row: id, what: 'diagnosed', text: diagnosis, model })
    const episode: Episode = { at: now, action: answer.action, verifyAt: now, stage: 'done' }
    state.episodes[id] = episode
    const chosen = candidates.find((action) => action.id === answer.action)
    if (!chosen) {
      if (answer.action !== 'none')
        say({
          row: id,
          what: 'refused',
          text: `Refused "${answer.action}": not on the list for this row.`,
          model,
        })
      await tell(row, episode, `${row.meaning ?? row.what} ${diagnosis}`)
      continue
    }
    state.actions += 1
    const { code, output } = await deps.run(chosen.argv)
    say({ row: id, what: 'acted', text: `Ran ${chosen.id} (exit ${code}).`, model })
    if (code !== 0) {
      say({
        row: id,
        what: 'stayed',
        text: `${chosen.id} failed: ${maskSecrets(output).slice(-300)}`,
      })
      await tell(row, episode, `${row.meaning ?? row.what} ${chosen.id} failed. ${diagnosis}`)
      continue
    }
    episode.stage = 'waiting'
    episode.verifyAt = now + (chosen.verify_minutes ?? policy.verify_minutes) * 60_000
  }
}
