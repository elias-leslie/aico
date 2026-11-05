// The projects registry: one row per project, the id every other Aico per-project table keys
// on (context's project_permissions, the web server's project_settings, Tether's roots).

import { existsSync } from 'node:fs'
import { isAbsolute, normalize, sep } from 'node:path'
import { type Database, openTasksDb, tasksDbPathFromEnv } from './db'

export interface Project {
  id: string
  name: string
  root_path: string | null
  category: string | null
  base_url: string | null
  public_url: string | null
  health_endpoint: string | null
  frontend_port: number | null
  backend_port: number | null
  sidebar_rank: number | null
  backend_dir: string | null
  browser_scripts_dir: string | null
  data_dir: string | null
  agent_configs: Record<string, unknown>
  test_config: Record<string, unknown>
  created_at: number
  retired_at: number | null
  retired_reason: string | null
}

export interface ProjectEvent {
  id: number
  project_id: string
  action: 'registered' | 'retired' | 'reactivated'
  owner_email: string | null
  reason: string | null
  recorded_at: number
}

export interface PublicationPolicy {
  mode: 'nightly' | 'manual'
  hold: { through: string | null; reason: string; set_at: string } | null
}

export class ProjectError extends Error {}

const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

type Row = Record<string, unknown>

function toProject(row: Row): Project {
  return {
    ...(row as unknown as Project),
    agent_configs: JSON.parse(String(row.agent_configs)),
    test_config: JSON.parse(String(row.test_config)),
  }
}

/** The deepest project root that holds `cwd`, or null. Retired projects do not match. */
export function projectForCwd(projects: readonly Project[], cwd: string): Project | null {
  const here = normalize(cwd)
  let best: Project | null = null
  for (const project of projects) {
    const root = project.root_path ? normalize(project.root_path) : null
    if (!root || project.retired_at !== null) continue
    if (here !== root && !here.startsWith(root.endsWith(sep) ? root : root + sep)) continue
    if (!best || root.length > (best.root_path as string).length) best = project
  }
  return best
}

export class Registry {
  constructor(
    readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  /** Open projects by default; `all` includes retired ones. Ordered by id. */
  list(options: { all?: boolean } = {}): Project[] {
    const where = options.all ? '' : 'WHERE retired_at IS NULL'
    return (this.db.prepare(`SELECT * FROM projects ${where} ORDER BY id`).all() as Row[]).map(
      toProject,
    )
  }

  get(id: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined
    return row ? toProject(row) : null
  }

  /** Publication policy lives with the registered repo, alongside its imported settings. */
  publication(id: string, update?: Partial<PublicationPolicy>): PublicationPolicy {
    const project = this.get(id)
    if (!project || project.retired_at !== null) throw new ProjectError(`no open project ${id}`)
    if (update) {
      if (update.mode !== undefined && !['nightly', 'manual'].includes(update.mode))
        throw new ProjectError('publication mode must be nightly or manual')
      const patch = {
        ...(update.mode !== undefined ? { publication_mode: update.mode } : {}),
        ...(update.hold !== undefined ? { publication_hold: update.hold } : {}),
      }
      this.db
        .prepare('UPDATE projects SET agent_configs = json_patch(agent_configs, ?) WHERE id = ?')
        .run(JSON.stringify(patch), id)
    }
    const config = (this.get(id) as Project).agent_configs
    return {
      mode: config.publication_mode === 'manual' ? 'manual' : 'nightly',
      hold:
        typeof config.publication_hold === 'object' && config.publication_hold !== null
          ? (config.publication_hold as PublicationPolicy['hold'])
          : null,
    }
  }

  /** Project whose root holds `cwd`. */
  forCwd(cwd: string): Project | null {
    return projectForCwd(this.list(), cwd)
  }

  events(id: string): ProjectEvent[] {
    return this.db
      .prepare('SELECT * FROM project_events WHERE project_id = ? ORDER BY id')
      .all(id) as unknown as ProjectEvent[]
  }

  register(input: { id: string; name?: string; root: string; category?: string }): Project {
    if (!PROJECT_ID_RE.test(input.id)) throw new ProjectError(`'${input.id}' is not a project id`)
    if (!isAbsolute(input.root)) throw new ProjectError('the project root must be an absolute path')
    const existing = this.get(input.id)
    if (existing)
      throw new ProjectError(
        existing.retired_at === null
          ? `project ${input.id} is already registered`
          : `project ${input.id} was retired; it keeps its history`,
      )
    const now = this.now()
    this.db
      .prepare(
        'INSERT INTO projects (id, name, root_path, category, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        input.id,
        input.name?.trim() || input.id,
        normalize(input.root),
        input.category ?? null,
        now,
      )
    this.db
      .prepare(
        "INSERT INTO project_events (project_id, action, recorded_at) VALUES (?, 'registered', ?)",
      )
      .run(input.id, now)
    return this.get(input.id) as Project
  }

  /** Retire a project: it leaves lists and cwd matching; its tasks and history stay. */
  retire(id: string, reason: string, owner: string | null = null): Project {
    const project = this.get(id)
    if (!project) throw new ProjectError(`no project ${id}`)
    if (project.retired_at !== null) throw new ProjectError(`project ${id} is already retired`)
    if (!reason.trim()) throw new ProjectError('retiring a project needs a --reason')
    const now = this.now()
    this.db
      .prepare('UPDATE projects SET retired_at = ?, retired_reason = ? WHERE id = ?')
      .run(now, reason.trim(), id)
    this.db
      .prepare(
        "INSERT INTO project_events (project_id, action, owner_email, reason, recorded_at) VALUES (?, 'retired', ?, ?, ?)",
      )
      .run(id, owner, reason.trim(), now)
    return this.get(id) as Project
  }
}

/**
 * The open projects of the registry (tasks.db), in the shape Tether's project list wants. Empty
 * when the file does not exist yet; this read never creates it.
 */
export function registryProjects(
  env: NodeJS.ProcessEnv = process.env,
): { id: string; name: string; root: string }[] {
  const path = tasksDbPathFromEnv(env)
  if (!existsSync(path)) return []
  const db = openTasksDb(path)
  try {
    return new Registry(db)
      .list()
      .filter((project) => project.root_path)
      .map((project) => ({ id: project.id, name: project.name, root: project.root_path as string }))
  } finally {
    db.close()
  }
}
