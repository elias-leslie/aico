// The session broker behind tsession/tclaude/tcodex (the Python backend's
// services/session_broker.py). A launcher asks for "the <tool> session of
// <project>": the broker reuses the most recently used Tether session for
// that project and tool, or creates one as the web app does (a new project
// tab with a shell beside it). Attaching a terminal is Tether's job
// (`tether sessions attach <id>`).

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { realpathLoose } from './file-browser'
import type { Lifecycle } from './lifecycle'
import { byText, SHELL_MODE, type WebSession } from './sessions'
import { HttpError } from './tether'

/** A Tether session a launcher can attach to; the fields and order `tsession open` prints. */
export interface BrokerTarget {
  project_id: string
  mode: string
  pane_id: string | null
  pane_name: string | null
  session_id: string
  tmux_session_name: string
  tmux_socket: string | null
  working_dir: string | null
  created: boolean
  started: boolean
}

const REUSABLE_STATUSES = new Set(['running', 'pending', 'uncertain'])

/** `~`, `.` and symlinks resolved, as the caller means the folder. */
export function normalizeWorkingDir(value: string | null | undefined): string | null {
  if (!value) return null
  const home = homedir()
  const expanded =
    value === '~' ? home : value.startsWith('~/') ? join(home, value.slice(2)) : value
  return realpathLoose(resolve(expanded))
}

/** Python's str.title() for an id: "my-app" -> "My App". */
function titled(id: string): string {
  return id
    .replace(/-/g, ' ')
    .replace(/[A-Za-z]+/g, (word) => word[0].toUpperCase() + word.slice(1).toLowerCase())
}

function newer(a: WebSession, b: WebSession): number {
  // Sessions a tab shows first, then the most recently viewed, then newest.
  const keys = (session: WebSession) =>
    [session.pane_id ? '1' : '0', session.last_accessed_at ?? '', session.created_at ?? ''] as const
  const x = keys(a)
  const y = keys(b)
  for (let index = 0; index < x.length; index += 1) {
    const order = byText(y[index], x[index])
    if (order) return order
  }
  return 0
}

export function createBroker(life: Lifecycle) {
  const { store, tether } = life

  function target(session: WebSession, created: boolean, started: boolean): BrokerTarget {
    const pane = session.pane_id ? store.getPane(session.pane_id) : null
    return {
      project_id: session.project_id ?? '',
      mode: session.mode,
      pane_id: pane?.id ?? null,
      pane_name: pane?.name ?? null,
      session_id: session.id,
      tmux_session_name: session.tmux_session_name ?? '',
      tmux_socket: session.tmux_socket,
      working_dir: session.working_dir,
      created,
      started,
    }
  }

  async function paneName(projectId: string): Promise<string> {
    const existing = store.listPanes().filter((pane) => pane.project_id === projectId).length
    let base = titled(projectId)
    try {
      base = (await tether.projects()).find((project) => project.id === projectId)?.name || base
    } catch {
      // Tether's project names are a nicety; the id's title stands in.
    }
    return existing === 0 ? base : `${base} [${existing + 1}]`
  }

  async function candidates(
    projectId: string,
    slug: string,
    workingDir: string | null,
  ): Promise<WebSession[]> {
    const requested = normalizeWorkingDir(workingDir)
    return (await life.listSessions())
      .filter(
        (session) =>
          session.project_id === projectId &&
          session.mode === slug &&
          REUSABLE_STATUSES.has(session.status ?? '') &&
          (requested === null || normalizeWorkingDir(session.working_dir) === requested),
      )
      .sort(newer)
  }

  /**
   * Reuse or create the project's session for `tool`. A reused session that
   * no tab shows stays that way: there are no hidden tabs any more, and a new
   * visible one would rearrange the owner's tabs.
   */
  async function ensure(input: {
    projectId: string
    tool: string
    workingDir: string | null
  }): Promise<BrokerTarget> {
    const { projectId, workingDir } = input
    const slug = await life.canonicalSlug(input.tool)
    const found = await candidates(projectId, slug, workingDir)
    let session = found[0]
    let created = false
    if (!session) {
      const pane = await life.createPane({
        paneType: 'project',
        paneName: await paneName(projectId),
        projectId,
        workingDir,
        agentMode: slug === SHELL_MODE ? null : await life.requireTool(slug),
      })
      const made = pane.sessions.find((candidate) => candidate.mode === slug)
      if (!made) throw new Error(`Created pane for ${projectId} is missing mode '${slug}'`)
      session = made
      created = true
    }
    store.upsertProjectSettings(projectId, { enabled: true, activeMode: slug })
    let started = false
    if (slug !== SHELL_MODE && !created && session.status !== 'running')
      started = (await life.startAgent(session)).started
    let refreshed = session
    try {
      refreshed = await life.getSession(session.id)
    } catch (error) {
      if (!(error instanceof HttpError && error.status === 404)) throw error
    }
    return target(refreshed, created, started)
  }

  /** Running project agent sessions in Tether, whichever app created them. */
  async function list(tool?: string | null): Promise<BrokerTarget[]> {
    const slug = tool ? await life.canonicalSlug(tool) : null
    return (await life.listSessions())
      .filter(
        (session) =>
          !!session.project_id &&
          session.mode !== SHELL_MODE &&
          (slug === null || session.mode === slug) &&
          REUSABLE_STATUSES.has(session.status ?? ''),
      )
      .map((session) => target(session, false, false))
      .sort(
        (a, b) =>
          byText(a.project_id, b.project_id) ||
          byText(a.mode, b.mode) ||
          byText(a.session_id, b.session_id),
      )
  }

  return { ensure, list }
}
