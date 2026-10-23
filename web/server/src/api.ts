// The web UI's HTTP API, at the Python backend's paths with its response
// shapes. Tether owns every session; this server keeps only which tab (pane)
// shows each one, and each project's tab settings.

import { posix } from 'node:path'
import { compatibleVersion, type TetherClient, TetherError } from 'tether/client'
import { AGENT_HUB_PATHS, type AgentHubConfig, proxyAgentHub } from './agent-hub'
import type { Pane, WebStore } from './db'
import {
  objectBody,
  optionalInt,
  optionalString,
  RAW,
  Router,
  requiredString,
  sendJson,
} from './http'
import {
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

export interface ApiDeps {
  tether: TetherClient
  store: WebStore
  config: AgentHubConfig
  /** The size a new session starts at, before any viewer claims one. */
  defaultSize?: { cols: number; rows: number }
}

const DEFAULT_SIZE = { cols: 120, rows: 30 }
const SLUG = /^[a-z0-9_-]+$/
const MAX_SESSION_NAME = 160

/** Run a Tether call, answering its refusals as the API's errors. */
async function tetherCall<T>(work: () => Promise<T>, notFound?: string): Promise<T> {
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

export function buildApi(deps: ApiDeps): Router {
  const { tether, store } = deps
  const size = deps.defaultSize ?? DEFAULT_SIZE
  const router = new Router()

  // -- Reading sessions -------------------------------------------------------

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

  // -- Panes (tabs) -----------------------------------------------------------

  interface PaneView extends Pane {
    sessions: WebSession[]
  }

  function withSessions(pane: Pane, known: Map<string, WebSession>): PaneView {
    const sessions = store
      .linksForPane(pane.id)
      .map((link) => known.get(link.session_id))
      .filter((session): session is WebSession => session !== undefined)
      .sort((a, b) => byText(a.mode, b.mode))
    return { ...pane, sessions }
  }

  function paneResponse(pane: PaneView, order: number) {
    return {
      id: pane.id,
      pane_type: pane.project_id ? 'project' : 'adhoc',
      project_id: pane.project_id,
      pane_order: order,
      pane_name: pane.name,
      active_mode: pane.active_mode,
      is_detached: false,
      created_at: pane.created_at,
      sessions: pane.sessions,
      width_percent: 100,
      height_percent: 100,
      grid_row: 0,
      grid_col: 0,
    }
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

  /** The tool by slug or alias; 404 unknown, 400 disabled. Returns its canonical slug. */
  async function requireTool(ref: string): Promise<string> {
    const { items } = await tetherCall(() => listTools(tether))
    const tool = items.find(
      (item) =>
        item.slug === ref ||
        item.id === ref ||
        (Array.isArray(item.aliases) && item.aliases.includes(ref)),
    )
    if (!tool || typeof tool.slug !== 'string')
      throw new HttpError(404, `Agent tool '${ref}' not found`)
    if (tool.enabled === false)
      throw new HttpError(400, `Agent tool '${String(tool.name ?? tool.slug)}' is disabled`)
    return tool.slug
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

  /** Tether's End, fenced by the generation read just before it; false when already gone. */
  async function endSession(id: string): Promise<boolean> {
    const ended = await tetherCall(async () => {
      const descriptor = await findSession(tether, id)
      if (!descriptor) return false
      if (typeof descriptor.generation !== 'string')
        throw new HttpError(409, 'The session has no generation yet; refresh and try again')
      try {
        await tether.end(id, descriptor.generation)
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

  router.on('GET', '/api/a-term/panes', async () => {
    const known = await sessionsById()
    const items = store
      .listPanes()
      .map((pane, order) => ({ pane: withSessions(pane, known), order }))
      .filter(({ pane }) => pane.sessions.length > 0)
      .map(({ pane, order }) => paneResponse(pane, order))
    return { items, total: items.length }
  })

  // Tabs are never detached any more; the UI still asks.
  router.on('GET', '/api/a-term/panes/detached', () => ({ items: [], total: 0 }))

  router.on('POST', '/api/a-term/panes', async (ctx) => {
    const body = objectBody(await ctx.body())
    const paneType = requiredString(body, 'pane_type')
    if (paneType !== 'project' && paneType !== 'adhoc')
      throw new HttpError(422, "pane_type must be 'project' or 'adhoc'")
    const paneName = requiredString(body, 'pane_name', { max: 255 })
    const projectId = optionalString(body, 'project_id', { max: 128 }) || null
    const workingDir = optionalString(body, 'working_dir', { max: 4096 }) || null
    const toolRef = optionalString(body, 'agent_tool_slug', { max: 100, pattern: SLUG })
    if (paneType === 'project' && !projectId)
      throw new HttpError(400, 'project_id required for project panes')
    if (paneType === 'adhoc' && projectId)
      throw new HttpError(400, 'project_id must be empty for adhoc panes')
    const agentMode = toolRef ? await requireTool(toolRef) : null

    const modes = [SHELL_MODE]
    if (paneType === 'project') {
      const agent = agentMode ?? (await defaultAgentSlug())
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
    const { pane: view, order } = await paneById(pane.id, false)
    return paneResponse(view, order)
  })

  router.on('GET', '/api/a-term/panes/:paneId', async (ctx) => {
    const { pane, order } = await paneById(ctx.params.paneId)
    return paneResponse(pane, order)
  })

  router.on('PATCH', '/api/a-term/panes/:paneId', async (ctx) => {
    const id = ctx.params.paneId
    const body = objectBody(await ctx.body())
    const name = optionalString(body, 'pane_name', { max: 255 })
    const activeMode = optionalString(body, 'active_mode', { max: 100, pattern: SLUG })
    let { pane } = await paneById(id)
    if (activeMode !== undefined) {
      if (!pane.project_id && activeMode !== SHELL_MODE)
        throw new HttpError(400, 'Ad-hoc panes only support shell mode')
      if (
        activeMode === SHELL_MODE &&
        pane.project_id &&
        !pane.sessions.some((session) => session.mode === SHELL_MODE)
      ) {
        await newSession({
          paneId: id,
          mode: SHELL_MODE,
          projectId: pane.project_id,
          workingDir: pane.sessions[0]?.working_dir ?? null,
        })
        pane = (await paneById(id)).pane
      }
      if (pane.project_id && !pane.sessions.some((session) => session.mode === activeMode))
        throw new HttpError(400, `Mode '${activeMode}' not available on this pane`)
    }
    if (name !== undefined || activeMode !== undefined) store.updatePane(id, { name, activeMode })
    const { pane: view, order } = await paneById(id, false)
    return paneResponse(view, order)
  })

  router.on('DELETE', '/api/a-term/panes/:paneId', async (ctx) => {
    const id = ctx.params.paneId
    if (!store.getPane(id)) throw new HttpError(404, `Pane ${id} not found`)
    for (const link of store.linksForPane(id)) await endSession(link.session_id)
    store.deletePane(id)
    return { deleted: true, id }
  })

  router.on('PUT', '/api/a-term/panes/:paneId/agent-tool', async (ctx) => {
    const id = ctx.params.paneId
    const body = objectBody(await ctx.body())
    const ref = requiredString(body, 'agent_tool_slug', { max: 100, pattern: SLUG })
    const { pane } = await paneById(id, false)
    if (!pane.project_id) throw new HttpError(400, 'Only project panes support agent tools')
    const slug = await requireTool(ref)
    const agent = pane.sessions.find((session) => session.mode !== SHELL_MODE)
    if (agent?.can_respawn) {
      const descriptor = await tetherCall(
        () => tether.loadTui(agent.id, String(agent.generation), slug),
        `Session ${agent.id} not found`,
      )
      store.updateLink(agent.id, { mode: descriptor.tool || slug })
    } else {
      if (agent) await endSession(agent.id)
      const shell = pane.sessions.find((session) => session.mode === SHELL_MODE)
      await newSession({
        paneId: id,
        mode: slug,
        projectId: pane.project_id,
        workingDir: shell?.working_dir ?? null,
      })
    }
    store.updatePane(id, { activeMode: slug })
    const { pane: view, order } = await paneById(id, false)
    return paneResponse(view, order)
  })

  // -- Sessions -----------------------------------------------------------------

  router.on('GET', '/api/a-term/sessions', async () => {
    // Tabs are never detached any more, so include_detached changes nothing.
    const items = await listSessions()
    return { items, total: items.length }
  })

  router.on('GET', '/api/a-term/sessions/:sessionId', (ctx) => getSession(ctx.params.sessionId))

  router.on('PATCH', '/api/a-term/sessions/:sessionId', async (ctx) => {
    const id = ctx.params.sessionId
    const body = objectBody(await ctx.body())
    const name = optionalString(body, 'name', { max: MAX_SESSION_NAME })
    const displayOrder = optionalInt(body, 'display_order')
    const session = await getSession(id)
    if (displayOrder !== undefined && session.pane_id) store.updateLink(id, { displayOrder })
    if (name !== undefined)
      await tetherCall(
        () => tether.rename(id, String(session.generation), name.trim() || null),
        `Session ${id} not found`,
      )
    return getSession(id)
  })

  router.on('DELETE', '/api/a-term/sessions/:sessionId', async (ctx) => {
    const id = ctx.params.sessionId
    const result = (fields: Partial<Record<string, unknown>> = {}) => ({
      deleted: true,
      id,
      next_session_id: null,
      pane_id: null,
      pane_deleted: false,
      is_external: false,
      ...fields,
    })
    const link = store.getLink(id)
    await endSession(id)
    if (!link) return result({ is_external: true })
    const pane = store.getPane(link.pane_id)
    if (!pane) return result()
    const remaining = store.linksForPane(pane.id)
    const onlyShells = remaining.every((other) => other.mode === SHELL_MODE)
    if (remaining.length === 0 || (link.mode !== SHELL_MODE && onlyShells)) {
      for (const companion of remaining) await endSession(companion.session_id)
      store.deletePane(pane.id)
      return result({ pane_id: pane.id, pane_deleted: true })
    }
    const next = remaining[0]
    if (pane.active_mode !== next.mode) store.updatePane(pane.id, { activeMode: next.mode })
    return result({ next_session_id: next.session_id, pane_id: pane.id })
  })

  router.on('POST', '/api/a-term/sessions/:sessionId/reset', async (ctx) =>
    respawn(await getSession(ctx.params.sessionId)),
  )

  router.on('POST', '/api/a-term/reset-all', async () => {
    const known = await sessionsById()
    let count = 0
    for (const link of store.listLinks()) {
      const session = known.get(link.session_id)
      if (!session) continue
      try {
        await respawn(session)
        count += 1
      } catch (error) {
        if (!(error instanceof HttpError)) throw error
        console.warn(`[aico-web] reset-all skipped session=${session.id}: ${error.detail}`)
      }
    }
    return { reset_count: count }
  })

  router.on('GET', '/api/a-term/sessions/:sessionId/agent-state', async (ctx) => {
    const session = await getSession(ctx.params.sessionId)
    return {
      session_id: session.id,
      agent_state: session.agent_state,
      claude_state: session.agent_state,
    }
  })

  router.on('POST', '/api/a-term/sessions/:sessionId/start-agent', async (ctx) => {
    const session = await getSession(ctx.params.sessionId)
    const answer = (started: boolean, message: string, state = session.agent_state) => ({
      session_id: session.id,
      started,
      message,
      agent_state: state,
      claude_state: state,
    })
    if (session.is_root) return answer(false, 'Root launch is owned by its retained request')
    if (session.mode === SHELL_MODE)
      throw new HttpError(400, 'Session is in shell mode, not agent mode')
    if (session.status === 'running') return answer(false, 'Agent is already running')
    if (session.status === 'pending') return answer(false, 'Agent is already starting')
    const restarted = await respawn(session)
    return answer(true, 'Agent restarted', agentStateFor(restarted.mode, restarted.status))
  })

  // -- Projects and tools ---------------------------------------------------------

  function projectResponse(
    id: string,
    project: { name?: string; root?: string } | undefined,
    settings: ReturnType<WebStore['allProjectSettings']>,
  ) {
    const own = settings.get(id)
    return {
      id,
      name: project?.name ?? id,
      root_path: project?.root ?? null,
      a_term_enabled: own?.enabled ?? false,
      mode: own?.active_mode ?? SHELL_MODE,
      display_order: own?.display_order ?? 0,
    }
  }

  router.on('GET', '/api/a-term/projects', async () => {
    const projects = await tetherCall(() => tether.projects())
    const settings = store.allProjectSettings()
    return projects
      .filter((project) => project.id)
      .map((project) => projectResponse(project.id, project, settings))
      .sort((a, b) => a.display_order - b.display_order || byText(a.name, b.name))
  })

  router.on('PUT', '/api/a-term/projects/:projectId/mode', async (ctx) => {
    const id = ctx.params.projectId
    const body = objectBody(await ctx.body())
    const mode = requiredString(body, 'mode', { max: 100, pattern: SLUG })
    store.upsertProjectSettings(id, { activeMode: mode })
    const projects = await tetherCall(() => tether.projects())
    return projectResponse(
      id,
      projects.find((project) => project.id === id),
      store.allProjectSettings(),
    )
  })

  router.on('GET', '/api/a-term/agent-tools', async (ctx) => {
    const enabledOnly = ctx.query.get('enabled_only') === 'true'
    const { items } = await tetherCall(() => listTools(tether))
    const iso = (ms: unknown) =>
      typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : null
    return items
      .filter((tool) => typeof tool.slug === 'string')
      .map((tool) => ({
        id: tool.id ?? tool.slug,
        slug: tool.slug,
        name: tool.name ?? tool.slug,
        command: tool.command ?? null,
        argv: Array.isArray(tool.argv) ? tool.argv : [],
        process_name: tool.processName ?? null,
        description: tool.description ?? null,
        color: tool.color ?? null,
        display_order: typeof tool.displayOrder === 'number' ? tool.displayOrder : 0,
        is_default: tool.isDefault === true,
        enabled: tool.enabled !== false,
        aliases: Array.isArray(tool.aliases) ? tool.aliases : [],
        context_hook: tool.contextHook ?? null,
        created_at: iso(tool.createdAt),
        updated_at: iso(tool.updatedAt),
      }))
      .filter((tool) => !enabledOnly || tool.enabled)
      .sort((a, b) => a.display_order - b.display_order || byText(String(a.name), String(b.name)))
  })

  // -- Agent Hub, auth, health ------------------------------------------------------

  router.on('GET', '/api/agent-hub/:path', async (ctx) => {
    const upstream = AGENT_HUB_PATHS[ctx.params.path]
    if (!upstream) throw new HttpError(404, 'Not found')
    await proxyAgentHub(deps.config, upstream, ctx.res)
    return RAW
  })

  // The app has no login of its own (Cloudflare Access gates the public host);
  // Nightshift's public-gate probe still reads this path.
  router.on('GET', '/api/auth/session', () => ({
    enabled: false,
    mode: 'none',
    authenticated: true,
    identity: 'local',
  }))

  router.on('GET', '/health', async (ctx) => {
    let version: Awaited<ReturnType<TetherClient['version']>> | null = null
    try {
      version = await tether.version()
    } catch {
      // Reported below as unhealthy.
    }
    if (!version || !compatibleVersion(version)) {
      sendJson(ctx.res, 503, { service: 'aico-web', status: 'unhealthy' })
      return RAW
    }
    return {
      service: 'aico-web',
      status: 'healthy',
      tether: { status: 'healthy', apiVersion: version.apiVersion, version: version.version },
    }
  })

  return router
}
