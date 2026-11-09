import policyData from '../data/shopping-repair.json' with { type: 'json' }

export interface ShoppingPolicy {
  project: string
  release: 'portfolio' | 'dadbot' | 'managed'
  machine?: string
  sshHost?: string
  releaseFile?: string
  replay?: { user: string; python: string; pythonPath: string; module: string; config: string }
}

// These values reach subprocess and SSH arguments. Reject malformed policy at
// startup rather than guessing an alternative project or destination.
function loadPolicy(data: unknown): {
  defaultProject: string
  corrections: Record<string, string[]>
  areas: Record<string, string>
  projects: Record<string, ShoppingPolicy>
} {
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new Error('Invalid Shopping repair policy')
  const value = data as Record<string, unknown>
  if (
    typeof value.defaultProject !== 'string' ||
    !value.corrections ||
    typeof value.corrections !== 'object' ||
    Array.isArray(value.corrections) ||
    !value.areas ||
    typeof value.areas !== 'object' ||
    Array.isArray(value.areas) ||
    !value.projects ||
    typeof value.projects !== 'object' ||
    Array.isArray(value.projects)
  )
    throw new Error('Invalid Shopping repair policy')
  const projects = value.projects as Record<string, unknown>
  const result: Record<string, ShoppingPolicy> = {}
  for (const [key, raw] of Object.entries(projects)) {
    if (!/^[a-z0-9_-]+$/.test(key) || !raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('Invalid Shopping repair project')
    const project = raw as Record<string, unknown>
    if (
      project.project !== key ||
      !['portfolio', 'dadbot', 'managed'].includes(String(project.release))
    )
      throw new Error('Invalid Shopping repair project')
    if (project.release === 'dadbot') {
      const replay = project.replay as Record<string, unknown> | undefined
      const path = (x: unknown) => typeof x === 'string' && /^\/[A-Za-z0-9/._-]+$/.test(x)
      if (
        typeof project.machine !== 'string' ||
        !/^[A-Za-z0-9._-]+$/.test(project.machine) ||
        typeof project.sshHost !== 'string' ||
        !/^[A-Za-z0-9.-]+$/.test(project.sshHost) ||
        !path(project.releaseFile) ||
        !replay ||
        typeof replay !== 'object' ||
        Array.isArray(replay) ||
        typeof replay.user !== 'string' ||
        !/^[a-z_][a-z0-9_-]*$/.test(replay.user) ||
        !path(replay.python) ||
        !path(replay.pythonPath) ||
        !path(replay.config) ||
        typeof replay.module !== 'string' ||
        !/^[A-Za-z0-9_.]+$/.test(replay.module)
      )
        throw new Error('Invalid Shopping repair destination')
    }
    result[key] = project as unknown as ShoppingPolicy
  }
  const areas = value.areas as Record<string, unknown>
  for (const [area, project] of Object.entries(areas))
    if (!/^[a-z0-9_-]+$/.test(area) || typeof project !== 'string' || !result[project])
      throw new Error('Invalid Shopping repair area')
  const corrections = value.corrections as Record<string, unknown>
  for (const [source, targets] of Object.entries(corrections))
    if (
      !result[source] ||
      !Array.isArray(targets) ||
      targets.some((target) => typeof target !== 'string' || !result[target] || target === source)
    )
      throw new Error('Invalid Shopping repair correction')
  if (!result[value.defaultProject]) throw new Error('Invalid Shopping repair default')
  return {
    defaultProject: value.defaultProject,
    corrections: corrections as Record<string, string[]>,
    areas: areas as Record<string, string>,
    projects: result,
  }
}
const policy = loadPolicy(policyData)

export function shoppingPolicy(area: string): ShoppingPolicy {
  return policy.projects[policy.areas[area] ?? policy.defaultProject] as ShoppingPolicy
}

export function correctionPolicy(source: string, target: string): ShoppingPolicy | undefined {
  return policy.corrections[source]?.includes(target) ? policy.projects[target] : undefined
}

export function shoppingProjectPolicy(project: string): ShoppingPolicy | undefined {
  return policy.projects[project]
}
