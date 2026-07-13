// Active-project pointer. Pure helpers (no electron imports) so they unit-test
// cheaply. When the optional `st` CLI is installed, `st projects switch <slug>`
// writes the active project's root to ~/.local/share/st/active-project.json; new
// widgets launch their TUI in that directory.

import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

export const PERSONAL_WORKSPACE_ID = '__aico_personal_workspace__'
export const PERSONAL_WORKSPACE_NAME = 'Personal Workspace'

/** Path of the pointer `st projects switch` writes. */
export function activeProjectPath(): string {
  return join(homedir(), '.local', 'share', 'st', 'active-project.json')
}

/** Aico-local workspace for assistant/chat sessions that should not start in a
 * repo. It is a cwd target only, not an external project/task identity. */
export function personalWorkspaceRoot(home = process.env.HOME ?? homedir()): string {
  return join(home, '.local', 'share', 'aico', 'personal-workspace')
}

function ensurePersonalWorkspaceRoot(): string | null {
  const root = personalWorkspaceRoot()
  try {
    mkdirSync(root, { recursive: true })
    return isDir(root) ? root : null
  } catch {
    return null
  }
}

/**
 * The active project's root, or null when the pointer is unset, unreadable, or
 * carries no root. Never throws — a bad/absent file just means "no active root".
 */
export function readActiveProjectRoot(path = activeProjectPath()): string | null {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as { project_root?: unknown }
    return typeof data.project_root === 'string' && data.project_root.length > 0
      ? data.project_root
      : null
  } catch {
    return null
  }
}

/** True when `p` is an existing directory. Guards stored cwds so a vanished
 * root (deleted/renamed project) never strands a pane in a dead path. */
export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** One entry of the optional `st projects list` catalog. */
export interface ProjectInfo {
  id: string
  name: string
  root: string
  /** True for the global active project (`st projects switch` target). */
  current: boolean
}

function personalWorkspaceProject(): ProjectInfo {
  return {
    id: PERSONAL_WORKSPACE_ID,
    name: PERSONAL_WORKSPACE_NAME,
    root: personalWorkspaceRoot(),
    current: false,
  }
}

// Injectable so the catalog calls unit-test without a real `st` on PATH.
type Exec = (cmd: string, args: string[]) => string
const runSt: Exec = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' })

/** Parse `st projects list` JSON into the picker list (Personal Workspace first). */
function parseProjectList(out: string): ProjectInfo[] {
  const personal = personalWorkspaceProject()
  const parsed = JSON.parse(out) as {
    id: string
    name: string
    root_path: string
    current?: boolean
  }[]
  if (!Array.isArray(parsed)) return [personal]
  return [
    personal,
    ...parsed.map((p) => ({
      id: p.id,
      name: p.name,
      root: p.root_path,
      current: p.current === true,
    })),
  ]
}

/**
 * One blocking `st projects list` read. Never throws — if `st` is missing or
 * unparseable, the Personal Workspace still lets a widget launch without
 * binding to a repo. Prefer the cached `listProjects()` outside tests: the `st`
 * CLI takes hundreds of ms to start and this blocks the main process.
 */
export function fetchProjects(exec: Exec = runSt): ProjectInfo[] {
  try {
    return parseProjectList(exec('st', ['projects', 'list']))
  } catch {
    return [personalWorkspaceProject()]
  }
}

/**
 * One blocking `st projects root` read; null when the slug is unknown or the
 * root no longer exists (a stale binding must never strand a widget in a dead
 * path). Only the cache-miss fallback of `projectRoot()` should need this.
 */
export function fetchProjectRoot(id: string, exec: Exec = runSt): string | null {
  if (id === PERSONAL_WORKSPACE_ID) return ensurePersonalWorkspaceRoot()
  try {
    const root = exec('st', ['projects', 'root', id]).trim()
    return root && isDir(root) ? root : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Cached catalog. `listProjects()` runs on hot paths (titlebar pushes, tray
// sync, focus reconcile); a synchronous `st` spawn there freezes every window.
// Reads return the cached list immediately; a stale cache kicks off one
// background refresh and consumers repaint via onProjectsRefreshed.

const PROJECT_CACHE_TTL_MS = 15_000
// `st` is an optional external process. Once a renderer waits for the first
// catalog load, an unbounded child would also leave that window's chrome
// initialization waiting forever. Five seconds is deliberately generous for
// the local metadata read while still bounding that intrinsic subprocess
// failure mode.
const PROJECT_REFRESH_TIMEOUT_MS = 5_000

type ExecAsync = (cmd: string, args: string[]) => Promise<string>
const execFileAsync = promisify(execFile)
const runStAsync: ExecAsync = async (cmd, args) =>
  (
    await execFileAsync(cmd, args, {
      encoding: 'utf8',
      timeout: PROJECT_REFRESH_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    })
  ).stdout

let cachedProjects: ProjectInfo[] = [personalWorkspaceProject()]
let cacheFetchedAt = 0
let refreshInFlight: Promise<void> | null = null
let onRefreshed: (() => void) | null = null

/** Repaint hook: fires after each refresh that completed (success or failure). */
export function onProjectsRefreshed(cb: (() => void) | null): void {
  onRefreshed = cb
}

/** Force the next `listProjects()` to refresh (e.g. after a project switch). */
export function invalidateProjectCache(): void {
  cacheFetchedAt = 0
}

/**
 * Refresh the cache off the main thread; single-flight. A failed read keeps
 * the previous (stale) list — a broken `st` must not blank the picker, and
 * stamping `cacheFetchedAt` either way stops failure-spawn storms.
 */
export function refreshProjects(exec: ExecAsync = runStAsync): Promise<void> {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = (async () => {
    try {
      cachedProjects = parseProjectList(await exec('st', ['projects', 'list']))
    } catch {
      // keep stale cache
    } finally {
      cacheFetchedAt = Date.now()
      refreshInFlight = null
    }
    onRefreshed?.()
  })()
  return refreshInFlight
}

/**
 * Aico's workspace picker: an Aico-local Personal Workspace plus the optional
 * `st` project catalog. Returns the cache synchronously (never blocks, never
 * throws); schedules a background refresh when stale.
 */
export function listProjects(): ProjectInfo[] {
  if (Date.now() - cacheFetchedAt > PROJECT_CACHE_TTL_MS) void refreshProjects()
  return cachedProjects
}

/**
 * Await a stale/in-flight catalog refresh before returning the picker snapshot.
 * Renderer initialization is already asynchronous, so unlike hot-path
 * `listProjects()` callers it can wait for the initial `st` result and avoid a
 * permanently Personal-Workspace-only menu caused by the startup race.
 */
export async function listProjectsFresh(exec: ExecAsync = runStAsync): Promise<ProjectInfo[]> {
  if (Date.now() - cacheFetchedAt > PROJECT_CACHE_TTL_MS) await refreshProjects(exec)
  return cachedProjects
}

/**
 * A project's canonical fs root, or null when the slug is unknown or the root
 * no longer exists. Resolves from the cached catalog; an unknown slug falls
 * back to one blocking `st` read (rare: user-initiated open/switch only).
 */
export function projectRoot(id: string): string | null {
  if (id === PERSONAL_WORKSPACE_ID) return ensurePersonalWorkspaceRoot()
  const hit = cachedProjects.find((p) => p.id === id)
  if (hit) return isDir(hit.root) ? hit.root : null
  return fetchProjectRoot(id)
}

/**
 * Working directory a new widget's TUI should launch in: the active project's
 * root, falling back to $HOME when unset or pointing at a directory that no
 * longer exists (a stale pointer must never strand a widget in a dead path).
 */
export function widgetCwd(
  home = process.env.HOME ?? homedir(),
  path = activeProjectPath(),
): string {
  const root = readActiveProjectRoot(path)
  return root && isDir(root) ? root : home
}
