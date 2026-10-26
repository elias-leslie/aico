// Aico's workspace picker: an Aico-local Personal Workspace plus the project
// list Tether serves (from SummitFlow when installed, else Tether's local
// projects.json). Pure apart from the injected loader, so it unit-tests cheaply.

import { mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const PERSONAL_WORKSPACE_ID = '__aico_personal_workspace__'
export const PERSONAL_WORKSPACE_NAME = 'Personal Workspace'
/** New session only: Tether makes a new empty workspace and launches the tool
 * with no first-party context. Not a catalog entry, so never a switch target. */
export const BLANK_SLATE_ID = '__aico_blank_slate__'
export const BLANK_SLATE_NAME = 'Blank Slate'

/** Tether's parent of Blank Slate workspaces (tether/src/lifecycle/tui/blank-slate.ts). */
export function isBlankSlateRoot(root: string, home = homedir()): boolean {
  return dirname(root) === join(home, '.local', 'share', 'aico', 'blank-slate')
}

/** Aico-local workspace for assistant/chat sessions that should not start in a
 * repo. A cwd only: it is sent to Tether as `projectRoot`, never as a project. */
// homedir() is $HOME when it is set (POSIX), else the passwd entry.
export function personalWorkspaceRoot(home = homedir()): string {
  return join(home, '.local', 'share', 'aico', 'personal-workspace')
}

export function ensurePersonalWorkspaceRoot(): string | null {
  const root = personalWorkspaceRoot()
  try {
    mkdirSync(root, { recursive: true })
    return isDir(root) ? root : null
  } catch {
    return null
  }
}

/** True when `p` is an existing directory. */
export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

export interface ProjectInfo {
  id: string
  name: string
  root: string
  /** SummitFlow's active project (`st projects active`), as Tether reports it. */
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

export type ProjectLoader = () => Promise<
  { id: string; name: string; root: string; current?: boolean }[]
>

const PROJECT_CACHE_TTL_MS = 15_000

/** Cached catalog. Reads never block; a stale cache refreshes in the
 * background and `onRefreshed` repaints. A failed read keeps the last list. */
export class ProjectCatalog {
  private cached: ProjectInfo[] = [personalWorkspaceProject()]
  private fetchedAt = Number.NEGATIVE_INFINITY
  private inFlight: Promise<void> | null = null

  constructor(
    private readonly load: ProjectLoader,
    private readonly onRefreshed: () => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight
    this.inFlight = (async () => {
      try {
        const projects = await this.load()
        this.cached = [
          personalWorkspaceProject(),
          ...projects
            .filter((p) => p.id !== PERSONAL_WORKSPACE_ID)
            .map((p) => ({
              id: p.id,
              name: p.name || p.id,
              root: p.root,
              current: p.current === true,
            })),
        ]
      } catch {
        // keep the stale list: an unreachable Tether must not blank the picker
      } finally {
        this.fetchedAt = this.now()
        this.inFlight = null
      }
      this.onRefreshed()
    })()
    return this.inFlight
  }

  /** Force the next read to refresh (Tether announced `projects.changed`). */
  invalidate(): void {
    this.fetchedAt = Number.NEGATIVE_INFINITY
  }

  list(): ProjectInfo[] {
    if (this.now() - this.fetchedAt > PROJECT_CACHE_TTL_MS) void this.refresh()
    return this.cached
  }

  /** Await a stale or in-flight refresh first; for renderer initialization. */
  async listFresh(): Promise<ProjectInfo[]> {
    if (this.now() - this.fetchedAt > PROJECT_CACHE_TTL_MS) await this.refresh()
    return this.cached
  }

  /** The display name of a session's workspace: by project id, else by root
   * (the Personal Workspace's root names it too). */
  nameFor(projectId: string | null, projectRoot: string | null): string | null {
    const byId = projectId ? this.cached.find((p) => p.id === projectId) : undefined
    if (byId) return byId.name
    if (!projectRoot) return null
    if (projectRoot === personalWorkspaceRoot()) return PERSONAL_WORKSPACE_NAME
    if (isBlankSlateRoot(projectRoot)) return BLANK_SLATE_NAME
    return this.cached.find((p) => p.root === projectRoot)?.name ?? null
  }
}
