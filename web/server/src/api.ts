// The web UI's HTTP API, at the Python backend's paths with its response
// shapes. Tether owns every session; this server keeps only which tab (pane)
// shows each one, and each project's tab settings.

import { compatibleVersion, type TetherClient } from 'tether/client'
import { AGENT_HUB_PATHS, type AgentHubConfig, proxyAgentHub } from './agent-hub'
import type { UploadConfig } from './config'
import type { WebStore } from './db'
import {
  objectBody,
  optionalInt,
  optionalString,
  RAW,
  Router,
  requiredString,
  sendJson,
} from './http'
import { createLifecycle, type PaneView, tetherCall } from './lifecycle'
import { registerPaneFileRoutes } from './pane-files'
import { byText, SHELL_MODE } from './sessions'
import { registerShowRoutes, type Shows } from './shows'
import { HttpError, listTools } from './tether'
import { registerUploadRoutes } from './uploads'

export interface ApiDeps {
  tether: TetherClient
  store: WebStore
  config: AgentHubConfig
  uploads: UploadConfig
  shows: Shows
  /** The size a new session starts at, before any viewer claims one. */
  defaultSize?: { cols: number; rows: number }
}

const SLUG = /^[a-z0-9_-]+$/
const MAX_SESSION_NAME = 160

export function buildApi(deps: ApiDeps): Router {
  const life = createLifecycle(deps)
  const { tether, store } = deps
  const {
    listSessions,
    getSession,
    sessionsById,
    withSessions,
    paneById,
    requireTool,
    newSession,
    endSession,
    respawn,
  } = life
  const router = new Router()

  // -- Panes (tabs) -----------------------------------------------------------

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

  router.on('GET', '/api/panes', async () => {
    const known = await sessionsById()
    const items = store
      .listPanes()
      .map((pane, order) => ({ pane: withSessions(pane, known), order }))
      .filter(({ pane }) => pane.sessions.length > 0)
      .map(({ pane, order }) => paneResponse(pane, order))
    return { items, total: items.length }
  })

  // Tabs are never detached any more; the UI still asks.
  router.on('GET', '/api/panes/detached', () => ({ items: [], total: 0 }))

  router.on('POST', '/api/panes', async (ctx) => {
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
    const created = await life.createPane({ paneType, paneName, projectId, workingDir, agentMode })
    const { pane: view, order } = await paneById(created.id, false)
    return paneResponse(view, order)
  })

  router.on('GET', '/api/panes/:paneId', async (ctx) => {
    const { pane, order } = await paneById(ctx.params.paneId)
    return paneResponse(pane, order)
  })

  router.on('PATCH', '/api/panes/:paneId', async (ctx) => {
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

  router.on('DELETE', '/api/panes/:paneId', async (ctx) => {
    const id = ctx.params.paneId
    if (!store.getPane(id)) throw new HttpError(404, `Pane ${id} not found`)
    for (const link of store.linksForPane(id)) await endSession(link.session_id)
    store.deletePane(id)
    return { deleted: true, id }
  })

  router.on('PUT', '/api/panes/:paneId/agent-tool', async (ctx) => {
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

  router.on('GET', '/api/sessions', async () => {
    // Tabs are never detached any more, so include_detached changes nothing.
    const items = await listSessions()
    return { items, total: items.length }
  })

  router.on('GET', '/api/sessions/:sessionId', (ctx) => getSession(ctx.params.sessionId))

  router.on('PATCH', '/api/sessions/:sessionId', async (ctx) => {
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

  router.on('DELETE', '/api/sessions/:sessionId', async (ctx) => {
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

  router.on('POST', '/api/sessions/:sessionId/reset', async (ctx) =>
    respawn(await getSession(ctx.params.sessionId)),
  )

  router.on('POST', '/api/reset-all', async () => {
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

  router.on('GET', '/api/sessions/:sessionId/agent-state', async (ctx) => {
    const session = await getSession(ctx.params.sessionId)
    return {
      session_id: session.id,
      agent_state: session.agent_state,
      claude_state: session.agent_state,
    }
  })

  router.on('POST', '/api/sessions/:sessionId/start-agent', async (ctx) => {
    const session = await getSession(ctx.params.sessionId)
    const result = await life.startAgent(session)
    return {
      session_id: session.id,
      started: result.started,
      message: result.message,
      agent_state: result.state,
      claude_state: result.state,
    }
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

  router.on('GET', '/api/projects', async () => {
    const projects = await tetherCall(() => tether.projects())
    const settings = store.allProjectSettings()
    return projects
      .filter((project) => project.id)
      .map((project) => projectResponse(project.id, project, settings))
      .sort((a, b) => a.display_order - b.display_order || byText(a.name, b.name))
  })

  router.on('PUT', '/api/projects/:projectId/mode', async (ctx) => {
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

  router.on('GET', '/api/agent-tools', async (ctx) => {
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

  // -- Files and agent shares -------------------------------------------------------

  registerUploadRoutes(router, deps.uploads)
  registerPaneFileRoutes(router, life)
  registerShowRoutes(router, deps.shows)

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
