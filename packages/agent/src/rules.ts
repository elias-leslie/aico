// Role rules for one run, read from the context database (models and deny rows through route())
// and data/harness.json (which providers this harness may register, tool level, guard,
// egress). They fail closed: anything unreadable, unknown or not allowed is a typed
// refusal, and nothing runs.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { Catalog, type LaunchPolicy, loadPolicy, openContext, route } from '@aico/context'
import harnessData from '../data/harness.json' with { type: 'json' }
import type { Contain } from './tools'

export type Harness = typeof harnessData
export const HARNESS: Harness = harnessData

export type RefusalReason =
  | 'rules_unreadable'
  | 'unknown_role'
  | 'model_unknown'
  | 'model_denied'
  | 'provider_not_allowed'
  | 'no_model'
  | 'unenforceable'
  | 'project_unknown'
  | 'egress_denied'

export interface Refused {
  kind: 'refused'
  reason: RefusalReason
  detail: string
}

/** One model the role may run on, in chain order. */
export interface ChainModel {
  /** Aico's catalog id, e.g. codex/gpt-6.1-sol. */
  id: string
  /** The pi-ai provider that serves it. */
  piProvider: string
  /** The model id inside that provider. */
  piModel: string
  effort: string | null
}

export interface RoleRules {
  role: string
  chain: ChainModel[]
  level: string
  tools: string[]
  /** The publication guard hook every bash call goes through, or null when the role runs without it. */
  guardHook: string | null
  /** The egress profile's name. */
  egress: string
  /** The hosts models may be reached at, or null for any host. */
  hosts: string[] | null
  /** How a contained role's tools run (bash in a sandbox, writes kept to the working folder), or null when they run on the host. */
  contain: Contain | null
}

const refused = (reason: RefusalReason, detail: string): Refused => ({
  kind: 'refused',
  reason,
  detail,
})

/** A registered project: its id and the folder it lives in. */
export interface ProjectRoot {
  id: string
  root: string
}

export interface ContextRules {
  policy: LaunchPolicy
  projects: ProjectRoot[]
}

/** The launch policy and project roots in the context database, or a refusal: a missing or unreadable file never means "allow". */
export function readPolicy(dbPath: string): ContextRules | Refused {
  if (!existsSync(dbPath))
    return refused(
      'rules_unreadable',
      `no context database at ${dbPath}; nothing runs without role rules`,
    )
  try {
    const db = openContext(dbPath)
    try {
      const policy = loadPolicy(db)
      if (!policy)
        return refused(
          'rules_unreadable',
          `the context database at ${dbPath} has no launch policy; run aico context import-agent-hub`,
        )
      const projects = (
        db
          .prepare(
            "SELECT project_id, root_path FROM project_permissions WHERE coalesce(root_path, '') != ''",
          )
          .all() as { project_id: string; root_path: string }[]
      ).map((row) => ({ id: row.project_id, root: row.root_path }))
      return { policy, projects }
    } finally {
      db.close()
    }
  } catch (error) {
    return refused(
      'rules_unreadable',
      `the context database at ${dbPath} could not be read: ${(error as Error).message}`,
    )
  }
}

/** The registered project whose root holds `cwd` (the deepest one), as `st` resolves it from the working folder. */
export function projectFor(projects: readonly ProjectRoot[], cwd: string): string | undefined {
  const here = resolve(cwd)
  let best: ProjectRoot | undefined
  for (const project of projects) {
    const root = resolve(project.root)
    const inside = here === root || here.startsWith(root === sep ? root : `${root}${sep}`)
    if (inside && (!best || root.length > resolve(best.root).length)) best = project
  }
  return best?.id
}

export interface RulesRequest {
  role: string
  model?: string
  project?: string
  /** The working folder; the project comes from it when `project` is not given. */
  cwd?: string
}

/** Why `model` may not run for this role in this harness, or null. */
function modelRefusal(
  policy: LaunchPolicy,
  catalog: Catalog,
  harness: Harness,
  request: RulesRequest,
  model: string,
): Refused | null {
  const entry = catalog.get(model)
  if (!entry) return refused('model_unknown', `'${model}' is not in Aico's model list`)
  const row = route(policy, catalog, {
    role: request.role,
    tool: harness.launch_tool,
    model: entry.id,
    ...(request.project && { project: request.project }),
  }).rows[0]
  if (!row) return refused('rules_unreadable', `no launch row for role '${request.role}'`)
  if (row.deny_reason) return refused('model_denied', `${entry.id}: ${row.deny_reason}`)
  // roleRules refuses a policy without the Claude entry before any model is checked.
  const claude = policy.providers[harness.claude_provider]
  const names = [entry.id, model].map((name) => name.toLowerCase())
  if (
    entry.provider === harness.claude_provider ||
    claude?.nameTokens.some((token) => names.some((name) => name.includes(token)))
  )
    return refused(
      'provider_not_allowed',
      `${entry.id}: Claude runs only through claude -p, never in this harness`,
    )
  if (!(entry.provider in harness.providers))
    return refused(
      'provider_not_allowed',
      `${entry.id}: provider '${entry.provider}' is not registered in this harness`,
    )
  return null
}

function chainModel(
  catalog: Catalog,
  harness: Harness,
  model: string,
  effort: string | null,
): ChainModel {
  const entry = catalog.get(model) as NonNullable<ReturnType<Catalog['get']>>
  const prefix = `${entry.provider}/`
  return {
    id: entry.id,
    piProvider: harness.providers[entry.provider as keyof Harness['providers']],
    piModel: entry.id.startsWith(prefix) ? entry.id.slice(prefix.length) : entry.id,
    effort,
  }
}

/** The refusal when the role has deny rows for projects and no project is known (the working folder is in no registered one). */
export function projectGap(policy: LaunchPolicy, role: string): Refused | null {
  const job =
    policy.jobs.find((entry) => entry.name === role) ??
    policy.jobs.find((entry) => entry.workRoles.includes(role))
  const workRole = policy.workRoles.includes(role) ? role : null
  const scoped = policy.deny.find(
    (row) =>
      row.projects?.length &&
      (!row.jobs || (job !== undefined && row.jobs.includes(job.name))) &&
      (!row.work_roles || (workRole !== null && row.work_roles.includes(workRole))),
  )
  return scoped
    ? refused(
        'project_unknown',
        `role '${role}' has deny rules for projects (${scoped.projects?.join(', ')}), and the working folder is in no registered project`,
      )
    : null
}

/**
 * The rules for one run: the model chain (`--model` first when given, then the role's
 * launch rows for the harness's tools and their alternates, each checked against the
 * deny rows), tool level, guard and egress. A refusal names what failed.
 */
export function roleRules(
  policy: LaunchPolicy,
  catalog: Catalog,
  harness: Harness,
  request: RulesRequest,
): RoleRules | Refused {
  if (!policy.jobs.some((job) => job.name === request.role || job.workRoles.includes(request.role)))
    return refused('unknown_role', `unknown role '${request.role}'`)
  const roleData = (
    harness.roles as Record<string, { level: string; guard: boolean; egress: string }>
  )[request.role]
  if (!roleData)
    return refused(
      'unknown_role',
      `role '${request.role}' has no harness rules (data/harness.json)`,
    )

  if (!(harness.claude_provider in policy.providers))
    return refused(
      'rules_unreadable',
      `the launch policy has no '${harness.claude_provider}' provider entry, so Claude models cannot be told apart`,
    )
  if (!request.project) {
    const gap = projectGap(policy, request.role)
    if (gap) return gap
  }

  const wanted: { model: string; effort: string | null }[] = []
  if (request.model) {
    const why = modelRefusal(policy, catalog, harness, request, request.model)
    if (why) return why
    wanted.push({ model: request.model, effort: null })
  }
  for (const tool of harness.chain_tools) {
    const row = route(policy, catalog, {
      role: request.role,
      tool,
      ...(request.project && { project: request.project }),
    }).rows[0]
    if (!row?.model || !row.allowed) continue
    wanted.push({ model: row.model, effort: row.effort })
    for (const alt of row.alternates)
      if (typeof alt.model === 'string')
        wanted.push({ model: alt.model, effort: (alt.effort as string) ?? row.effort })
  }
  const chain: ChainModel[] = []
  for (const { model, effort } of wanted) {
    if (modelRefusal(policy, catalog, harness, request, model)) continue
    const next = chainModel(catalog, harness, model, effort)
    const same = chain.find((entry) => entry.id === next.id)
    if (same) same.effort ??= next.effort
    else chain.push(next)
  }
  if (!chain.length)
    return refused('no_model', `role '${request.role}' has no model this harness may run`)

  const hosts = (harness.egress_profiles as Record<string, string[]>)[roleData.egress]
  if (!hosts?.length)
    return refused(
      'unenforceable',
      `role '${request.role}' needs egress profile '${roleData.egress}', which data/harness.json does not define`,
    )
  const open = hosts.includes('*')
  if (!open && !contains(harness.contain_command))
    return refused(
      'unenforceable',
      `role '${request.role}' runs its tools contained, and '${harness.contain_command.join(' ')}' does not work on this host`,
    )
  const tools = (harness.levels as Record<string, string[]>)[roleData.level]
  if (!tools)
    return refused(
      'unenforceable',
      `role '${request.role}' names unknown tool level '${roleData.level}'`,
    )
  if (roleData.guard && !existsSync(harness.guard_hook))
    return refused(
      'unenforceable',
      `role '${request.role}' needs the publication guard, not found at ${harness.guard_hook}`,
    )
  return {
    role: request.role,
    chain,
    level: roleData.level,
    tools,
    guardHook: roleData.guard ? harness.guard_hook : null,
    egress: roleData.egress,
    hosts: open ? null : hosts,
    contain: open
      ? null
      : {
          command: harness.contain_command,
          hide: harness.contain_hide,
          unsetEnv: harness.contain_unset_env,
        },
  }
}

const containChecked = new Map<string, boolean>()

/** Whether `command true` runs here (the sandbox needs unprivileged user namespaces). */
function contains(command: readonly string[]): boolean {
  const key = command.join('\0')
  let works = containChecked.get(key)
  if (works === undefined) {
    const [file, ...args] = command
    works =
      Boolean(file) &&
      spawnSync(file as string, [...args, 'true'], { stdio: 'ignore', timeout: 5000 }).status === 0
    containChecked.set(key, works)
  }
  return works
}

/** The context database's rules for one run, or why not. The project comes from `request.cwd` unless given. */
export function loadRoleRules(
  dbPath: string,
  request: RulesRequest,
  harness: Harness = HARNESS,
  catalog: Catalog = new Catalog(),
): RoleRules | Refused {
  const context = readPolicy(dbPath)
  if ('kind' in context) return context
  const project =
    request.project ?? (request.cwd ? projectFor(context.projects, request.cwd) : undefined)
  try {
    return roleRules(context.policy, catalog, harness, { ...request, ...(project && { project }) })
  } catch (error) {
    return refused('rules_unreadable', (error as Error).message)
  }
}
