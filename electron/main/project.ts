// Active-project pointer. Pure helpers (no electron imports) so they unit-test
// cheaply. When the optional `st` CLI is installed, `st projects switch <slug>`
// writes the active project's root to ~/.local/share/st/active-project.json; new
// widgets launch their TUI in that directory.

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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

/**
 * Aico's workspace picker: an Aico-local Personal Workspace plus the optional
 * `st` project catalog. Never throws — if `st` is missing or unparseable, the
 * Personal Workspace still lets a widget launch without binding to a repo.
 */
export function listProjects(exec: Exec = runSt): ProjectInfo[] {
  const personal = personalWorkspaceProject()
  try {
    const parsed = JSON.parse(exec('st', ['projects', 'list'])) as {
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
  } catch {
    return [personal]
  }
}

/**
 * A project's canonical fs root, or null when the slug is unknown or the root no
 * longer exists (a stale binding must never strand a widget in a dead path).
 */
export function projectRoot(id: string, exec: Exec = runSt): string | null {
  if (id === PERSONAL_WORKSPACE_ID) return ensurePersonalWorkspaceRoot()
  try {
    const root = exec('st', ['projects', 'root', id]).trim()
    return root && isDir(root) ? root : null
  } catch {
    return null
  }
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
