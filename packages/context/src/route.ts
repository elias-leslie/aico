// route(): the options for launching a job, one row per tool: model, effort,
// Daybreak, context, alternates, whether a deny row refuses it, and, given usage
// facts, what each subscription has left, until when, and the last refusal.
// Facts only: nothing here ranks or picks; the coordinator chooses. Same answers
// as Agent Hub's launch-defaults (policy v5), field for field, so `--json` matches.

import {
  type Credit,
  type Facts,
  optionUsage,
  type Reading,
  type Refusal,
  type Usage,
  type Window,
  windowFacts,
} from '@aico/usage'
import type { DenyRule, Job, LaunchPolicy, Provider, ToolEntry } from './launch'
import type { Catalog } from './models'

export type { Credit, Facts, Reading, Refusal, Usage, Window }

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

// -- the table -------------------------------------------------------------------------------

/** A job name, or the job a registered work role launches as. */
function jobOf(policy: LaunchPolicy, role: string): Job | undefined {
  return (
    policy.jobs.find((job) => job.name === role) ??
    policy.jobs.find((job) => job.workRoles.includes(role))
  )
}

/** Whether launching `model` through `tool` counts as this provider. */
function countsAs(
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
function denyReason(
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
  /** Why there are no usage facts (Aico has not collected them, or usage.db could not be read). */
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

/** The subscription a tool/model draws on: a model id's prefix when listed, else the tool's. */
function usageProvider(policy: LaunchPolicy, tool: string, model: string | null): string | null {
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
function lastRefusal(catalog: Catalog, model: string | null, refusals: Refusal[]): Refusal | null {
  if (!model) return null
  const names = new Set([bare(model), bare(catalog.resolve(model))])
  const mine = refusals.filter((refusal) => names.has(bare(refusal.requested_model)))
  if (!mine.length) return null
  const newest = mine[0] as Refusal
  return { ...newest, count: mine.reduce((sum, refusal) => sum + refusal.count, 0) }
}

function usageOf(
  policy: LaunchPolicy,
  facts: Facts,
  windows: Record<string, Window[]>,
  tool: string,
  model: string | null,
): Usage {
  const provider = usageProvider(policy, tool, model)
  const unreadable = provider ? facts.unreadable?.[provider] : undefined
  // Stale or failed facts say nothing: unknown, never zero used and never room.
  return unreadable
    ? { provider, status: 'unknown', windows: [], credits: null, unknown_windows: [], unreadable }
    : optionUsage(provider, windows, facts.credits)
}

/** What the subscription behind `tool` and `model` has left, as the route rows show it. */
export function modelUsage(
  policy: LaunchPolicy,
  facts: Facts,
  tool: string,
  model: string | null,
  now: string,
): Usage {
  return usageOf(policy, facts, windowFacts(facts.readings, now), tool, model)
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
    row.usage = usageOf(policy, facts, windows, row.tool, row.model)
    row.last_refusal = row.allowed ? lastRefusal(catalog, row.model, facts.refusals) : null
    for (const alt of row.alternates)
      alt.last_refusal = row.allowed
        ? lastRefusal(catalog, (alt.model as string | null) ?? null, facts.refusals)
        : null
  }
  payload.facts_as_of = facts.collected_at ?? now
}
