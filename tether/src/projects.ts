// Project list. SummitFlow is the source when installed (loopback, no token);
// otherwise a local list. A cached SummitFlow answer is preferred over the
// local list while SummitFlow is briefly unreachable.

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, normalize } from 'node:path'

export interface Project {
  id: string
  name: string
  root: string
  lifecycle: string | null
}

export interface ProjectList {
  source: 'summitflow' | 'summitflow-cache' | 'local'
  fetchedAt: number
  projects: Project[]
}

export type FetchJson = (url: string, timeoutMs: number) => Promise<unknown>

export const DEFAULT_SUMMITFLOW_PROJECTS_URL = 'http://127.0.0.1:8001/api/projects'
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

async function defaultFetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`SummitFlow projects returned HTTP ${response.status}`)
  return response.json()
}

function cleanRoot(value: unknown): string | null {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) return null
  return normalize(value)
}

/** Accept SummitFlow's `GET /api/projects` rows; skip archived and malformed rows. */
export function parseSummitFlowProjects(value: unknown): Project[] {
  if (!Array.isArray(value)) throw new Error('SummitFlow projects response is not a list')
  const projects: Project[] = []
  for (const row of value) {
    if (!row || typeof row !== 'object') continue
    const item = row as Record<string, unknown>
    const root = cleanRoot(item.root_path)
    if (typeof item.id !== 'string' || !PROJECT_ID_RE.test(item.id) || !root) continue
    const lifecycle = typeof item.lifecycle === 'string' ? item.lifecycle : null
    if (lifecycle === 'archived') continue
    projects.push({
      id: item.id,
      name: typeof item.name === 'string' && item.name.trim() ? item.name : item.id,
      root,
      lifecycle,
    })
  }
  return projects.sort((a, b) => a.id.localeCompare(b.id))
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
  summitflowUrl: string | null
  localFile: string
  ttlMs?: number
  timeoutMs?: number
  fetchJson?: FetchJson
  now?: () => number
  isDir?: (p: string) => boolean
}

export class ProjectProvider {
  private cache: ProjectList | null = null
  private inflight: Promise<ProjectList> | null = null
  private readonly ttlMs: number
  private readonly timeoutMs: number
  private readonly fetchJson: FetchJson
  private readonly now: () => number

  constructor(private readonly options: ProjectProviderOptions) {
    this.ttlMs = options.ttlMs ?? 30_000
    this.timeoutMs = options.timeoutMs ?? 2_000
    this.fetchJson = options.fetchJson ?? defaultFetchJson
    this.now = options.now ?? Date.now
  }

  async list(options: { refresh?: boolean } = {}): Promise<ProjectList> {
    if (
      !options.refresh &&
      this.cache?.source === 'summitflow' &&
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
    const url = this.options.summitflowUrl
    if (url) {
      try {
        const projects = parseSummitFlowProjects(await this.fetchJson(url, this.timeoutMs))
        this.cache = { source: 'summitflow', fetchedAt: this.now(), projects }
        return this.cache
      } catch {
        if (this.cache) return { ...this.cache, source: 'summitflow-cache' }
      }
    }
    return {
      source: 'local',
      fetchedAt: this.now(),
      projects: readLocalProjects(this.options.localFile, this.options.isDir),
    }
  }
}

/** `TETHER_SUMMITFLOW_URL=off` disables the SummitFlow provider. */
export function summitflowUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.TETHER_SUMMITFLOW_URL
  if (value === 'off' || value === '') return null
  return value ?? DEFAULT_SUMMITFLOW_PROJECTS_URL
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
 * source accepts registrations: with SummitFlow configured, SummitFlow owns
 * projects. The file is rewritten atomically (temp file + rename, 0600).
 */
export async function registerLocalProject(
  provider: ProjectProvider,
  localFile: string,
  input: { id: string; name?: string | null; root: string },
  isDir: (p: string) => boolean = defaultIsDir,
): Promise<Project> {
  const current = await provider.list({ refresh: true })
  if (current.source !== 'local')
    throw new ProjectRegistrationError(409, 'projects_managed_by_summitflow')
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
