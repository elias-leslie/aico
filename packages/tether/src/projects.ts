// Project list. The projects registry (tasks.db, `aico projects`) is the source once it has
// projects; otherwise a local list (`~/.config/tether/projects.json`).

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize } from 'node:path'
import type { Project } from '@aico/session-engine/project'

export type { Project }

export interface ProjectList {
  source: 'registry' | 'local'
  fetchedAt: number
  projects: Project[]
}

/** The list as served: each project says whether it is the active one. */
export interface ServedProjectList extends Omit<ProjectList, 'projects'> {
  /** st's persisted active project (`st projects active`) when it is listed. */
  activeProjectId: string | null
  projects: (Project & { current: boolean })[]
}

/** st's active-project pointer, written by `st projects use`. */
function defaultActiveProjectFile(home: string): string {
  return join(home, '.local', 'share', 'st', 'active-project.json')
}

/** The pointer's project id, or null when absent, unreadable or malformed. */
function readActiveProjectId(path: string | null): string | null {
  if (!path) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { project_id?: unknown } | null
    const id = parsed?.project_id
    return typeof id === 'string' && PROJECT_ID_RE.test(id) ? id : null
  } catch {
    return null
  }
}

/** Mark the active project. It is read on every call: the file is tiny and
 * st rewrites it without telling anyone. */
export function withActiveProject(list: ProjectList, activeFile: string | null): ServedProjectList {
  const listed = readActiveProjectId(activeFile)
  const activeProjectId = list.projects.some((project) => project.id === listed) ? listed : null
  return {
    ...list,
    activeProjectId,
    projects: list.projects.map((project) => ({
      ...project,
      current: project.id === activeProjectId,
    })),
  }
}

const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function cleanRoot(value: unknown): string | null {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) return null
  return normalize(value)
}

/**
 * Local fallback: `~/.config/tether/projects.json`, a JSON list of
 * `{id, name?, root}`. Missing file means no projects. Roots that are not
 * existing directories are skipped.
 */
export function readLocalProjects(
  path: string,
  isDir: (p: string) => boolean = defaultIsDir,
): Project[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const projects: Project[] = []
  for (const row of parsed) {
    if (!row || typeof row !== 'object') continue
    const item = row as Record<string, unknown>
    const root = cleanRoot(item.root)
    if (typeof item.id !== 'string' || !PROJECT_ID_RE.test(item.id) || !root || !isDir(root))
      continue
    projects.push({
      id: item.id,
      name: typeof item.name === 'string' && item.name.trim() ? item.name : item.id,
      root,
      lifecycle: null,
    })
  }
  return projects.sort((a, b) => a.id.localeCompare(b.id))
}

function defaultIsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export interface ProjectProviderOptions {
  /** The open projects of Aico's registry; an empty list means none registered yet. */
  registry?: () => { id: string; name: string; root: string }[]
  localFile: string
  ttlMs?: number
  now?: () => number
  isDir?: (p: string) => boolean
}

export class ProjectProvider {
  private cache: ProjectList | null = null
  private inflight: Promise<ProjectList> | null = null
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(private readonly options: ProjectProviderOptions) {
    this.ttlMs = options.ttlMs ?? 30_000
    this.now = options.now ?? Date.now
  }

  async list(options: { refresh?: boolean } = {}): Promise<ProjectList> {
    if (
      !options.refresh &&
      this.cache?.source === 'registry' &&
      this.now() - this.cache.fetchedAt < this.ttlMs
    ) {
      return this.cache
    }
    this.inflight ??= this.load().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async load(): Promise<ProjectList> {
    if (this.options.registry) {
      try {
        const rows = this.options.registry().filter((row) => cleanRoot(row.root))
        if (rows.length > 0) {
          const projects = rows
            .map((row) => ({
              id: row.id,
              name: row.name,
              root: normalize(row.root),
              lifecycle: null,
            }))
            .sort((a, b) => a.id.localeCompare(b.id))
          this.cache = { source: 'registry', fetchedAt: this.now(), projects }
          return this.cache
        }
      } catch {
        // an unreadable registry falls through to the local list
      }
    }
    return {
      source: 'local',
      fetchedAt: this.now(),
      projects: readLocalProjects(this.options.localFile, this.options.isDir),
    }
  }
}

/** `TETHER_ACTIVE_PROJECT_FILE` overrides the pointer path; `off` disables it. */
export function activeProjectFileFromEnv(env: NodeJS.ProcessEnv, home: string): string | null {
  const value = env.TETHER_ACTIVE_PROJECT_FILE
  if (value === 'off' || value === '') return null
  return value ?? defaultActiveProjectFile(home)
}

export class ProjectRegistrationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code)
  }
}

/**
 * Add one project to the local list (`POST /v1/projects`). Only the local
 * source accepts registrations: once the registry has projects, it owns them. The file is rewritten atomically (temp file + rename, 0600).
 */
export async function registerLocalProject(
  provider: ProjectProvider,
  localFile: string,
  input: { id: string; name?: string | null; root: string },
  isDir: (p: string) => boolean = defaultIsDir,
): Promise<Project> {
  const current = await provider.list({ refresh: true })
  if (current.source === 'registry')
    throw new ProjectRegistrationError(409, 'projects_managed_by_registry')
  const root = cleanRoot(input.root)
  if (!PROJECT_ID_RE.test(input.id)) throw new ProjectRegistrationError(400, 'invalid_project_id')
  if (!root || !isDir(root)) throw new ProjectRegistrationError(400, 'invalid_project_root')
  let rows: unknown[] = []
  try {
    const parsed = JSON.parse(readFileSync(localFile, 'utf8'))
    if (Array.isArray(parsed)) rows = parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new ProjectRegistrationError(409, 'local_projects_unreadable')
  }
  if (rows.some((row) => (row as { id?: unknown } | null)?.id === input.id))
    throw new ProjectRegistrationError(409, 'project_exists')
  const name = input.name?.trim() || input.id
  rows.push({ id: input.id, name, root })
  mkdirSync(dirname(localFile), { recursive: true, mode: 0o700 })
  const temporary = `${localFile}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(rows, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, localFile)
  await provider.list({ refresh: true })
  return { id: input.id, name, root, lifecycle: null }
}
