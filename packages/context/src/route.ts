// route(): the options for launching a job, one row per tool: model, effort,
// Daybreak, context, alternates, whether a deny row refuses it, and, given usage
// facts, what each subscription has left, until when, and the last refusal.
// Facts only: nothing here ranks or picks; the coordinator chooses. Same answers
// as Agent Hub's launch-defaults (policy v5), field for field, so `--json` matches.

import type { DenyRule, Job, LaunchPolicy, Provider, ToolEntry } from './launch'
import type { Catalog } from './models'

/** One usage-window reading of a subscription. */
export interface Reading {
  provider: string
  window_minutes: number
  observed_at: string
  used_percent: number
  resets_at: string | null
  source: string
}

export interface Credit {
  balance: number
  pace_per_day_7d: number
  earliest_expiry: string | null
}

/** Refusals of one requested model: the newest one's details and how many there are. */
export interface Refusal {
  requested_model: string
  at: string
  role: string | null
  project: string | null
  category: string | null
  count: number
}

export interface Facts {
  readings: Reading[]
  credits: Record<string, Credit>
  /** Newest first. */
  refusals: Refusal[]
}

export interface RouteRequest {
  /** A job or a work role. */
  role?: string
  tool?: string
  /** Check this model instead of the table's. */
  model?: string
  /** The project the agent works in (deny rows and defaults can be per project). */
  project?: string
}

export class UnknownLaunchKey extends Error {}

const WINDOW_LABELS: Record<number, string> = { 300: '5h', 10080: 'weekly', 43200: 'monthly' }

/** An ISO time in microseconds since the epoch (Date keeps only milliseconds). */
function micros(iso: string): number {
  const match = /\.(\d+)/.exec(iso)
  const fraction = match ? Number((match[1] as string).padEnd(6, '0').slice(0, 6)) : 0
  return Date.parse(iso.replace(/\.\d+/, '')) * 1000 + fraction
}

const seconds = (fromMicros: number, toMicros: number) =>
  Math.max(Math.floor((toMicros - fromMicros) / 1e6), 0)
const round1 = (value: number) => Math.round(value * 10) / 10

// -- the table -------------------------------------------------------------------------------

/** A job name, or the job a registered work role launches as. */
export function jobOf(policy: LaunchPolicy, role: string): Job | undefined {
  return (
    policy.jobs.find((job) => job.name === role) ??
    policy.jobs.find((job) => job.workRoles.includes(role))
  )
}

/** Whether launching `model` through `tool` counts as this provider. */
export function countsAs(
  provider: Provider,
  catalog: Catalog,
  tool: string | null,
  model: string | null | undefined,
): boolean {
  if (tool && provider.tools.includes(tool)) return true
  if (!model) return false
  const entry = catalog.get(model)
  if (entry && provider.catalogProviders.includes(entry.provider)) return true
  const names = [model.toLowerCase(), catalog.resolve(model).toLowerCase()]
  return provider.nameTokens.some((token) => names.some((name) => name.includes(token)))
}

function denyRows(
  policy: LaunchPolicy,
  job: string | null,
  workRole: string | null,
  project: string | null,
): DenyRule[] {
  return policy.deny.filter(
    (row) =>
      (!row.jobs || (job !== null && row.jobs.includes(job))) &&
      (!row.work_roles || (workRole !== null && row.work_roles.includes(workRole))) &&
      (!row.projects || (project !== null && row.projects.includes(project))),
  )
}

/** Why this launch is refused, or null when no deny row covers it. */
export function denyReason(
  policy: LaunchPolicy,
  catalog: Catalog,
  where: { job: string | null; workRole: string | null; project: string | null },
  tool: string | null,
  model: string | null | undefined,
): string | null {
  for (const row of denyRows(policy, where.job, where.workRole, where.project)) {
    const provider = policy.providers[row.provider]
    // Fail closed: a rule naming a provider Aico does not know, or a model it
    // cannot place, refuses rather than lets the launch through.
    if (!provider) return `${row.reason} (provider '${row.provider}' is not in the launch policy)`
    if (countsAs(provider, catalog, tool, model)) return row.reason
    if (model && !catalog.get(model))
      return `Unknown model '${model}': it is not in Aico's model list, so it cannot be checked against this rule: ${row.reason}`
  }
  return null
}

function withProjectDefault(
  row: ToolEntry,
  project: string | null,
): ToolEntry & { project_default?: string } {
  const override = project ? row.projects?.[project] : undefined
  if (!override) return row
  const merged = { ...row, ...override, project_default: project as string }
  merged.alternates = (row.alternates ?? []).filter(
    (alt) => alt.model !== merged.model || alt.effort !== merged.effort,
  )
  return merged
}

export interface LaunchRow {
  job: string
  label: string
  tool: string
  model: string | null
  effort: string | null
  daybreak: boolean | null
  context: string
  use: boolean
  launchable: boolean
  /** The tool's other choices, each with when to pick it (and its last refusal, with facts). */
  alternates: Record<string, unknown>[]
  subagent: string | null
  work_roles: string[]
  why: string | null
  note: string | null
  allowed: boolean
  deny_reason: string | null
  project_default: string | null
  when: string | null
  usage?: Usage
  last_refusal?: Refusal | null
}

function launchRow(
  policy: LaunchPolicy,
  catalog: Catalog,
  job: Job,
  tool: string,
  workRole: string | null,
  model: string | null,
  project: string | null,
): LaunchRow {
  const toolDef = policy.tools.find((entry) => entry.name === tool)
  const base: ToolEntry & { use?: boolean } = job.tools[tool] ??
    toolDef?.defaultRow ?? {
      model: null,
      effort: null,
      use: false,
      why: `No ${tool} entry for this job.`,
    }
  const row = withProjectDefault(base, project) as ToolEntry & {
    use?: boolean
    project_default?: string
  }
  const denied = denyReason(
    policy,
    catalog,
    { job: job.name, workRole, project },
    tool,
    model ?? row.model,
  )
  return {
    job: job.name,
    label: job.label,
    tool,
    model: row.model ?? null,
    effort: row.effort ?? null,
    daybreak: row.daybreak ?? null,
    context: job.context,
    use: denied === null && (row.use ?? true),
    launchable: row.launchable ?? true,
    alternates: (row.alternates ?? []).map((alt) => ({ ...alt })),
    subagent: job.subagent,
    work_roles: job.workRoles,
    why: denied ?? row.why ?? null,
    note: toolDef?.note ?? null,
    allowed: denied === null,
    deny_reason: denied,
    project_default: row.project_default ?? null,
    when: row.when ?? null,
  }
}

export interface RoutePayload {
  version: number
  role: string | null
  work_role: string | null
  work_roles: string[]
  about: string
  rows: LaunchRow[]
  model_notes: Record<string, unknown>
  facts_as_of?: string
  /** Why there are no usage facts (the source did not answer), as Agent Hub reports it. */
  facts_error?: string
}

/**
 * The launch table's rows, optionally for one job/work role and one tool, each
 * saying whether the launch is allowed (the table's model, or `model`, checked
 * against the deny rows), with usage facts and the last refusal when `facts` is given.
 */
export function route(
  policy: LaunchPolicy,
  catalog: Catalog,
  request: RouteRequest,
  facts: Facts | null = null,
  now: string = new Date().toISOString(),
): RoutePayload {
  if (request.tool !== undefined && !policy.tools.some((tool) => tool.name === request.tool))
    throw new UnknownLaunchKey(
      `Unknown tool '${request.tool}'; use one of: ${policy.tools.map((tool) => tool.name).join(', ')}`,
    )
  let jobs = policy.jobs
  if (request.role !== undefined) {
    const job = jobOf(policy, request.role)
    if (!job) {
      const others = policy.jobs
        .map((entry) => entry.name)
        .filter((name) => !policy.workRoles.includes(name))
        .sort()
      throw new UnknownLaunchKey(
        `Unknown work role or job '${request.role}'. Work roles: ${policy.workRoles.join(', ')}. Other jobs: ${others.join(', ')}.`,
      )
    }
    jobs = [job]
  }
  const tools = request.tool !== undefined ? [request.tool] : policy.tools.map((tool) => tool.name)
  const workRole =
    request.role !== undefined && policy.workRoles.includes(request.role) ? request.role : null
  const rows = jobs.flatMap((job) =>
    tools.map((tool) =>
      launchRow(
        policy,
        catalog,
        job,
        tool,
        workRole,
        request.model ?? null,
        request.project ?? null,
      ),
    ),
  )
  const payload: RoutePayload = {
    version: policy.version,
    role: request.role ?? null,
    work_role: workRole,
    work_roles: policy.workRoles,
    about: policy.about,
    rows,
    model_notes: {},
  }
  if (facts) attachFacts(payload, policy, catalog, facts, now)
  return payload
}

// -- usage facts ------------------------------------------------------------------------------

export interface Window {
  window_minutes: number
  label: string
  observed_at: string
  age_seconds: number
  source: string
  used_percent: number | null
  left_percent: number | null
  resets_at: string | null
  resets_in_seconds: number | null
  state: 'ok' | 'used_up' | 'unknown' | 'not_reported'
}

export interface Usage {
  provider: string | null
  status: 'ok' | 'partly_unknown' | 'used_up' | 'on_credits' | 'unknown' | 'untracked'
  windows: Window[]
  credits:
    | (Credit & {
        lasts_days: number | null
        reset_at: string | null
        lasts_past_reset: boolean | null
      })
    | null
  unknown_windows: string[]
}

const resetPassed = (reading: Reading, now: number) =>
  reading.resets_at !== null && micros(reading.resets_at) <= now

/**
 * Per provider, one entry per window of its latest readings, shortest first. A
 * reading is unknown only once its reset passed; then "not reported" when the
 * provider has since read another window that is still current.
 */
export function windowFacts(readings: Reading[], now: string): Record<string, Window[]> {
  const at = micros(now)
  const byProvider = new Map<string, Reading[]>()
  for (const reading of readings)
    byProvider.set(reading.provider, [...(byProvider.get(reading.provider) ?? []), reading])
  const out: Record<string, Window[]> = {}
  for (const [provider, rows] of byProvider) {
    const current = rows.filter((reading) => !resetPassed(reading, at))
    out[provider] = [...rows]
      .sort((a, b) => a.window_minutes - b.window_minutes)
      .map((reading) => {
        const base = {
          window_minutes: reading.window_minutes,
          label: WINDOW_LABELS[reading.window_minutes] ?? `${reading.window_minutes}m`,
          observed_at: reading.observed_at,
          age_seconds: seconds(micros(reading.observed_at), at),
          source: reading.source,
          used_percent: null,
          left_percent: null,
          resets_at: null,
          resets_in_seconds: null,
        }
        if (resetPassed(reading, at)) {
          const superseded = current.some(
            (other) => micros(other.observed_at) > micros(reading.observed_at),
          )
          return { ...base, state: superseded ? 'not_reported' : 'unknown' } as Window
        }
        const used = round1(reading.used_percent)
        return {
          ...base,
          state: used >= 100 ? 'used_up' : 'ok',
          used_percent: used,
          left_percent: round1(Math.max(100 - used, 0)),
          resets_at: reading.resets_at,
          resets_in_seconds: reading.resets_at ? seconds(at, micros(reading.resets_at)) : null,
        } as Window
      })
  }
  return out
}

export function optionUsage(
  provider: string | null,
  windows: Record<string, Window[]>,
  credits: Record<string, Credit>,
): Usage {
  if (provider === null)
    return { provider: null, status: 'untracked', windows: [], credits: null, unknown_windows: [] }
  const own = windows[provider] ?? []
  const credit = credits[provider]
  const usedUp = own.filter((window) => window.state === 'used_up')
  let status: Usage['status']
  if (usedUp.length) status = credit && credit.balance > 0 ? 'on_credits' : 'used_up'
  else if (own.some((window) => window.state === 'ok'))
    status = own.some((window) => window.state === 'unknown') ? 'partly_unknown' : 'ok'
  else status = 'unknown'
  let outCredit: Usage['credits'] = null
  if (credit) {
    // Until the used-up window resets, else the week: do the credits last that long?
    const ref = usedUp.length
      ? usedUp.reduce((best, window) =>
          (window.resets_in_seconds ?? 0) > (best.resets_in_seconds ?? 0) ? window : best,
        )
      : own.find((window) => window.window_minutes === 10080 && window.state === 'ok')
    const resetIn = ref ? ref.resets_in_seconds : null
    const empty = credit.balance <= 0
    const days = empty
      ? 0
      : credit.pace_per_day_7d > 0
        ? credit.balance / credit.pace_per_day_7d
        : null
    outCredit = {
      ...credit,
      lasts_days: days === null ? null : round1(days),
      reset_at: ref ? ref.resets_at : null,
      lasts_past_reset: empty
        ? false
        : resetIn === null
          ? null
          : days === null || days * 86400 > resetIn,
    }
  }
  return {
    provider,
    status,
    windows: own,
    credits: outCredit,
    unknown_windows: own
      .filter((window) => window.state === 'unknown')
      .map((window) => window.label),
  }
}

/** The subscription a tool/model draws on: a model id's prefix when listed, else the tool's. */
export function usageProvider(
  policy: LaunchPolicy,
  tool: string,
  model: string | null,
): string | null {
  const prefix = model?.includes('/') ? (model.split('/')[0] as string) : null
  if (prefix && policy.usageProviders.includes(prefix)) return prefix
  return policy.tools.find((entry) => entry.name === tool)?.usageProvider ?? null
}

/** A model without provider prefix, case or dated snapshot suffix. */
function bare(model: string): string {
  return (
    model
      .trim()
      .toLowerCase()
      .split('/')
      .pop()
      ?.replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8})$/, '') ?? ''
  )
}

/** The newest refusal of this model and how many are recorded; never changes `allowed`. */
export function lastRefusal(
  catalog: Catalog,
  model: string | null,
  refusals: Refusal[],
): Refusal | null {
  if (!model) return null
  const names = new Set([bare(model), bare(catalog.resolve(model))])
  const mine = refusals.filter((refusal) => names.has(bare(refusal.requested_model)))
  if (!mine.length) return null
  const newest = mine[0] as Refusal
  return { ...newest, count: mine.reduce((sum, refusal) => sum + refusal.count, 0) }
}

/** Adds usage and the last refusal to every row; a denied row gets no refusal (the rule already says no). */
function attachFacts(
  payload: RoutePayload,
  policy: LaunchPolicy,
  catalog: Catalog,
  facts: Facts,
  now: string,
): void {
  const windows = windowFacts(facts.readings, now)
  for (const row of payload.rows) {
    row.usage = optionUsage(usageProvider(policy, row.tool, row.model), windows, facts.credits)
    row.last_refusal = row.allowed ? lastRefusal(catalog, row.model, facts.refusals) : null
    for (const alt of row.alternates)
      alt.last_refusal = row.allowed
        ? lastRefusal(catalog, (alt.model as string | null) ?? null, facts.refusals)
        : null
  }
  payload.facts_as_of = now
}

/**
 * Usage facts from an Agent Hub launch-defaults answer (`st models route --json`):
 * the source until Aico collects usage itself (M8). Window states are kept by
 * giving passed readings a past reset; refusals keep each model's newest one and count.
 */
export function factsFromAgentHub(payload: { rows?: unknown }): Facts {
  const readings = new Map<string, Reading>()
  const credits: Record<string, Credit> = {}
  const refusals = new Map<string, Refusal>()
  const rows = Array.isArray(payload.rows) ? (payload.rows as Record<string, unknown>[]) : []
  const addRefusal = (value: unknown) => {
    if (!value || typeof value !== 'object') return
    const refusal = value as Refusal
    refusals.set(`${refusal.requested_model}\n${refusal.at}`, { ...refusal })
  }
  for (const row of rows) {
    const usage = row.usage as Usage | undefined
    if (usage?.provider) {
      for (const window of usage.windows) {
        const passed = window.state === 'unknown' || window.state === 'not_reported'
        readings.set(`${usage.provider}\n${window.window_minutes}`, {
          provider: usage.provider,
          window_minutes: window.window_minutes,
          observed_at: window.observed_at,
          used_percent: window.used_percent ?? 0,
          resets_at: passed ? window.observed_at : window.resets_at,
          source: window.source,
        })
      }
      if (usage.credits)
        credits[usage.provider] = {
          balance: usage.credits.balance,
          pace_per_day_7d: usage.credits.pace_per_day_7d,
          earliest_expiry: usage.credits.earliest_expiry,
        }
    }
    addRefusal(row.last_refusal)
    for (const alt of (row.alternates as Record<string, unknown>[] | undefined) ?? [])
      addRefusal(alt.last_refusal)
  }
  return {
    readings: [...readings.values()],
    credits,
    refusals: [...refusals.values()].sort((a, b) => micros(b.at) - micros(a.at)),
  }
}
