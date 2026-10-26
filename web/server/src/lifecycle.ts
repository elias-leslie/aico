// What the API and the tsession CLI do to sessions and tabs: Tether owns
// every session; the store keeps which tab (pane) shows each one.

import { posix } from 'node:path'
import { type TetherClient, TetherError } from 'tether/client'
import type { Pane, WebStore } from './db'
import {
  type AgentState,
  agentStateFor,
  byText,
  fromTether,
  numberSessions,
  requireRespawnable,
  SHELL_MODE,
  sortSessions,
  type WebSession,
} from './sessions'
import {
  createSession,
  findSession,
  HttpError,
  listTools,
  respawnSession,
  toHttpError,
} from './tether'

export interface LifecycleDeps {
  tether: TetherClient
  store: WebStore
  /** The size a new session starts at, before any viewer claims one. */
  defaultSize?: { cols: number; rows: number }
}

export interface PaneView extends Pane {
  sessions: WebSession[]
}

export interface StartAgentResult {
  started: boolean
  message: string
  state: AgentState
}

const DEFAULT_SIZE = { cols: 120, rows: 30 }

/** Run a Tether call, answering its refusals as the API's errors. */
export async function tetherCall<T>(work: () => Promise<T>, notFound?: string): Promise<T> {
  try {
    return await work()
  } catch (error) {
    throw toHttpError(error, notFound)
  }
}

/** Tether refuses a project root that is not normalized; a blank one is "not given". */
function projectRoot(workingDir: string | undefined | null): string | null {
  if (!workingDir) return null
  const normalized = posix.normalize(workingDir).replace(/\/+$/, '') || '/'
  return normalized
}

export type Lifecycle = ReturnType<typeof createLifecycle>

export function createLifecycle(deps: LifecycleDeps) {
  const { tether, store } = deps
  const size = deps.defaultSize ?? DEFAULT_SIZE

  async function listSessions(): Promise<WebSession[]> {
    const links = new Map(store.listLinks().map((link) => [link.session_id, link]))
    const descriptors = await tetherCall(() => tether.listSessions())
    const sessions = descriptors
      .filter((descriptor) => typeof descriptor.id === 'string')
      .map((descriptor) => fromTether(descriptor, links.get(descriptor.id) ?? null))
    numberSessions(sessions)
    return sortSessions(sessions)
  }

  async function getSession(id: string): Promise<WebSession> {
    const descriptor = await tetherCall(() => findSession(tether, id))
    if (!descriptor) throw new HttpError(404, `Session ${id} not found`)
    return fromTether(descriptor, store.getLink(id))
  }

  async function sessionsById(): Promise<Map<string, WebSession>> {
    return new Map((await listSessions()).map((session) => [session.id, session]))
  }

  function withSessions(pane: Pane, known: Map<string, WebSession>): PaneView {
    const sessions = store
      .linksForPane(pane.id)
      .map((link) => known.get(link.session_id))
      .filter((session): session is WebSession => session !== undefined)
      .sort((a, b) => byText(a.mode, b.mode))
    return { ...pane, sessions }
  }

  async function paneById(id: string, requireLive = true) {
    const panes = store.listPanes()
    const order = panes.findIndex((pane) => pane.id === id)
    if (order < 0) throw new HttpError(404, `Pane ${id} not found`)
    const pane = withSessions(panes[order], await sessionsById())
    if (requireLive && pane.sessions.length === 0)
      throw new HttpError(404, `Pane ${id} has no live sessions`)
    return { pane, order }
  }

  async function defaultAgentSlug(): Promise<string> {
    const { items, defaultSlug } = await tetherCall(() => listTools(tether))
    const usable = items.filter((tool) => tool.enabled !== false && tool.slug !== SHELL_MODE)
    if (defaultSlug && usable.some((tool) => tool.slug === defaultSlug)) return defaultSlug
    const preferred = usable.find((tool) => tool.isDefault === true) ?? usable[0]
    if (!preferred || typeof preferred.slug !== 'string')
      throw new HttpError(400, 'No agent tool is enabled')
    return preferred.slug
  }

  async function findTool(ref: string): Promise<Record<string, unknown> | undefined> {
    const { items } = await tetherCall(() => listTools(tether))
    return items.find(
      (item) =>
        item.slug === ref ||
        item.id === ref ||
        (Array.isArray(item.aliases) && item.aliases.includes(ref)),
    )
  }

  /** The tool by slug or alias; 404 unknown, 400 disabled. Returns its canonical slug. */
  async function requireTool(ref: string): Promise<string> {
    const tool = await findTool(ref)
    if (!tool || typeof tool.slug !== 'string')
      throw new HttpError(404, `Agent tool '${ref}' not found`)
    if (tool.enabled === false)
      throw new HttpError(400, `Agent tool '${String(tool.name ?? tool.slug)}' is disabled`)
    return tool.slug
  }

  /** An alias (`claude`) as its canonical slug (`claude-code`); an unknown ref as given. */
  async function canonicalSlug(ref: string): Promise<string> {
    if (ref === SHELL_MODE) return SHELL_MODE
    const tool = await findTool(ref)
    return typeof tool?.slug === 'string' ? tool.slug : ref
  }

  async function newSession(input: {
    paneId: string
    mode: string
    projectId: string | null
    workingDir: string | null
    name?: string | null
  }): Promise<WebSession> {
    const descriptor = await tetherCall(() =>
      createSession(tether, {
        tool: input.mode,
        projectId: input.projectId,
        projectRoot: projectRoot(input.workingDir),
        name: input.name,
        size,
      }),
    )
    const link = store.link(descriptor.id, input.paneId, descriptor.tool || input.mode)
    return fromTether(descriptor, link)
  }

  /** Tether's End, fenced by the generation read just before it; false when already gone.
   * `keepWakes` keeps the session's check-ins past the End. */
  async function endSession(id: string, options: { keepWakes?: boolean } = {}): Promise<boolean> {
    const ended = await tetherCall(async () => {
      const descriptor = await findSession(tether, id)
      if (!descriptor) return false
      if (typeof descriptor.generation !== 'string')
        throw new HttpError(409, 'The session has no generation yet; refresh and try again')
      try {
        await tether.end(id, descriptor.generation, options)
        return true
      } catch (error) {
        if (error instanceof TetherError && error.status === 404) return false
        throw error
      }
    })
    store.unlink(id)
    return ended
  }

  async function respawn(session: WebSession): Promise<WebSession> {
    requireRespawnable(session)
    const descriptor = await tetherCall(
      () => respawnSession(tether, session.id, String(session.generation)),
      `Session ${session.id} not found`,
    )
    return fromTether(descriptor, store.getLink(session.id))
  }

  /**
   * A new tab with its sessions: a shell, plus for a project the given agent
   * (or Tether's default one). Rolls back what it started when Tether refuses.
   */
  async function createPane(input: {
    paneType: 'project' | 'adhoc'
    paneName: string
    projectId: string | null
    workingDir: string | null
    agentMode: string | null
  }): Promise<PaneView> {
    const { paneType, paneName, projectId, workingDir } = input
    const modes = [SHELL_MODE]
    if (paneType === 'project') {
      const agent = input.agentMode ?? (await defaultAgentSlug())
      if (agent !== SHELL_MODE) modes.push(agent)
    }
    const pane = store.createPane({
      projectId,
      name: paneName,
      activeMode: modes[modes.length - 1],
    })
    const created: WebSession[] = []
    try {
      for (const mode of modes)
        created.push(
          await newSession({
            paneId: pane.id,
            mode,
            projectId,
            workingDir,
            name: projectId ? null : paneName,
          }),
        )
    } catch (error) {
      for (const session of created.reverse())
        await endSession(session.id).catch((cleanup) =>
          console.warn(`[aico-web] rollback end failed session=${session.id}:`, cleanup),
        )
      store.deletePane(pane.id)
      throw error
    }
    const activeMode = created[created.length - 1].mode
    store.updatePane(pane.id, { activeMode })
    if (projectId) store.upsertProjectSettings(projectId, { enabled: true, activeMode })
    return (await paneById(pane.id, false)).pane
  }

  /** Respawn an agent whose workload is not running; roots and running agents are left alone. */
  async function startAgent(session: WebSession): Promise<StartAgentResult> {
    const answer = (started: boolean, message: string, state = session.agent_state) => ({
      started,
      message,
      state,
    })
    if (session.is_root) return answer(false, 'Root launch is owned by its retained request')
    if (session.mode === SHELL_MODE)
      throw new HttpError(400, 'Session is in shell mode, not agent mode')
    if (session.status === 'running') return answer(false, 'Agent is already running')
    if (session.status === 'pending') return answer(false, 'Agent is already starting')
    const restarted = await respawn(session)
    return answer(true, 'Agent restarted', agentStateFor(restarted.mode, restarted.status))
  }

  return {
    tether,
    store,
    listSessions,
    getSession,
    sessionsById,
    withSessions,
    paneById,
    defaultAgentSlug,
    requireTool,
    canonicalSlug,
    newSession,
    endSession,
    respawn,
    createPane,
    startAgent,
  }
}
