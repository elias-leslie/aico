// The launch policy (policy v5's `launch` section, owner decisions
// 2026-11-01): for each job, the model, effort, Daybreak and context it launches
// with per tool; the tools; which tool/model pairs count as a provider; and the
// deny rows (hard rules). Jobs are rows of `roles` (with `tools` set); the rest
// lives in launch_tools, launch_providers, launch_deny and settings.launch.

import { type Database, getSetting, json } from './db'

export interface Alternate {
  model: string | null
  effort: string | null
  when: string
}

/** What one tool launches a job with. */
export interface ToolEntry {
  model: string | null
  effort: string | null
  daybreak?: boolean
  launchable?: boolean
  alternates?: Alternate[]
  when?: string
  why: string
  /** Per-project defaults laid over this entry. */
  projects?: Record<string, { model: string; effort: string; why: string }>
}

export interface Job {
  name: string
  label: string
  description: string
  /** The work roles whose launches default to this job. */
  workRoles: string[]
  context: string
  /** The native subagent definition to use for this job, if any. */
  subagent: string | null
  tools: Record<string, ToolEntry>
}

export interface Tool {
  name: string
  label: string
  usageProvider: string | null
  note: string | null
  /** The entry for jobs that name no row for this tool. */
  defaultRow: ToolEntry | null
}

export interface Provider {
  name: string
  label: string
  tools: string[]
  catalogProviders: string[]
  nameTokens: string[]
  why: string
}

/** A hard rule: a launch matching every selector the row names is refused on `provider`. */
export interface DenyRule {
  jobs?: string[]
  work_roles?: string[]
  projects?: string[]
  provider: string
  reason: string
  source: string
}

export interface LaunchPolicy {
  version: number
  about: string
  /** Model-id prefixes that name the subscription they draw on ("opencode-go/..."). */
  usageProviders: string[]
  /** Every registered work role, in their registry order. */
  workRoles: string[]
  jobs: Job[]
  tools: Tool[]
  providers: Record<string, Provider>
  deny: DenyRule[]
}

interface LaunchSetting {
  version: number
  about: string
  usage_providers: string[]
  work_roles: string[]
}

/** The stored policy, or null when context.db has none. */
export function loadPolicy(db: Database): LaunchPolicy | null {
  const setting = getSetting<LaunchSetting>(db, 'launch')
  if (!setting) return null
  const jobs = (
    db
      .prepare(
        `SELECT name, label, description, work_roles, context, subagent, tools FROM roles
         WHERE context IS NOT NULL ORDER BY position`,
      )
      .all() as unknown as {
      name: string
      label: string
      description: string
      work_roles: string
      context: string
      subagent: string | null
      tools: string
    }[]
  ).map((row) => ({
    name: row.name,
    label: row.label,
    description: row.description,
    workRoles: json<string[]>(row.work_roles, []),
    context: row.context,
    subagent: row.subagent,
    tools: json<Record<string, ToolEntry>>(row.tools, {}),
  }))
  const tools = (
    db
      .prepare(
        'SELECT name, label, usage_provider, note, default_row FROM launch_tools ORDER BY position',
      )
      .all() as unknown as {
      name: string
      label: string
      usage_provider: string | null
      note: string | null
      default_row: string | null
    }[]
  ).map((row) => ({
    name: row.name,
    label: row.label,
    usageProvider: row.usage_provider,
    note: row.note,
    defaultRow: json<ToolEntry | null>(row.default_row, null),
  }))
  const providers: Record<string, Provider> = {}
  for (const row of db
    .prepare('SELECT name, label, tools, catalog_providers, name_tokens, why FROM launch_providers')
    .all() as unknown as Record<string, string>[]) {
    providers[row.name] = {
      name: row.name,
      label: row.label,
      tools: json(row.tools, []),
      catalogProviders: json(row.catalog_providers, []),
      nameTokens: json(row.name_tokens, []),
      why: row.why,
    }
  }
  const deny = (
    db
      .prepare(
        'SELECT jobs, work_roles, projects, provider, reason, source FROM launch_deny ORDER BY position',
      )
      .all() as unknown as Record<string, string | null>[]
  ).map((row) => {
    const rule: DenyRule = {
      provider: row.provider as string,
      reason: row.reason as string,
      source: row.source as string,
    }
    if (row.jobs) rule.jobs = JSON.parse(row.jobs)
    if (row.work_roles) rule.work_roles = JSON.parse(row.work_roles)
    if (row.projects) rule.projects = JSON.parse(row.projects)
    return rule
  })
  return {
    version: setting.version,
    about: setting.about,
    usageProviders: setting.usage_providers,
    workRoles: setting.work_roles,
    jobs,
    tools,
    providers,
    deny,
  }
}
