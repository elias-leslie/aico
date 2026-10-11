import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { API_VERSION, type TetherPaths } from './config'
import type { EventBus, TetherEvent } from './events'
import type { GuiChannel } from './gui-channel'
import { HttpError, Router, readJsonObject, sendError, sendJson } from './http'
import type { LegacyATermSessions } from './legacy-aterm'
import { lifecycleStatus } from './lifecycle/engine'
import { registerLifecycleRoutes } from './lifecycle-api'
import { type ProjectProvider, ProjectRegistrationError, registerLocalProject } from './projects'
import type { Store, ToolPatch } from './store'
import { type AgentTool, parseCommand, type ToolSeed, ToolValidationError } from './tools'
import { VERSION } from './version'

export interface ServerContext {
  paths: TetherPaths
  store: Store
  events: EventBus
  projects: ProjectProvider
  gui: GuiChannel
  legacy: LegacyATermSessions
  /** Project-root cache shared with the lifecycle engine. */
  projectRoots: Map<string, string>
  startedAt: number
  heartbeatMs?: number
  now?: () => number
}

function toolJson(tool: AgentTool): Record<string, unknown> {
  return { ...tool }
}

function str(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new HttpError(400, 'invalid_body', { field: key })
  return value
}

function nullableStr(body: Record<string, unknown>, key: string): string | null | undefined {
  const value = body[key]
  if (value === undefined || value === null) return value as null | undefined
  if (typeof value !== 'string') throw new HttpError(400, 'invalid_body', { field: key })
  return value
}

function bool(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new HttpError(400, 'invalid_body', { field: key })
  return value
}

function int(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new HttpError(400, 'invalid_body', { field: key })
  return value
}

const TOOL_FIELDS = new Set([
  'slug',
  'name',
  'argv',
  'command',
  'processName',
  'description',
  'color',
  'displayOrder',
  'isDefault',
  'enabled',
  'aliases',
  'contextHook',
])

/** Shared create/patch parsing. `argv` or A-Term's string `command`, not both. */
function toolFields(body: Record<string, unknown>): ToolPatch & { slug?: string } {
  const unknown = Object.keys(body).filter((key) => !TOOL_FIELDS.has(key))
  if (unknown.length) throw new HttpError(400, 'invalid_body', { fields: unknown })
  if (body.argv !== undefined && body.command !== undefined) {
    throw new HttpError(400, 'invalid_body', { detail: 'send argv or command, not both' })
  }
  const patch: ToolPatch & { slug?: string } = {}
  const slug = str(body, 'slug')
  if (slug !== undefined) patch.slug = slug
  const name = str(body, 'name')
  if (name !== undefined) patch.name = name
  const command = str(body, 'command')
  if (command !== undefined) patch.argv = parseCommand(command)
  if (body.argv !== undefined) patch.argv = body.argv as string[]
  const processName = str(body, 'processName')
  if (processName !== undefined) patch.processName = processName
  const description = nullableStr(body, 'description')
  if (description !== undefined) patch.description = description
  const color = nullableStr(body, 'color')
  if (color !== undefined) patch.color = color
  const displayOrder = int(body, 'displayOrder')
  if (displayOrder !== undefined) patch.displayOrder = displayOrder
  const isDefault = bool(body, 'isDefault')
  if (isDefault !== undefined) patch.isDefault = isDefault
  const enabled = bool(body, 'enabled')
  if (enabled !== undefined) patch.enabled = enabled
  if (body.aliases !== undefined) patch.aliases = body.aliases as string[]
  const contextHook = nullableStr(body, 'contextHook')
  if (contextHook !== undefined) patch.contextHook = contextHook as ToolPatch['contextHook']
  return patch
}

function streamEvents(
  context: ServerContext,
  request: IncomingMessage,
  response: ServerResponse,
  query: URLSearchParams,
): void {
  const { events } = context
  const sinceRaw = query.get('since')
  const since = sinceRaw === null ? null : Number(sinceRaw)
  if (since !== null && (!Number.isSafeInteger(since) || since < 0)) {
    throw new HttpError(400, 'invalid_since')
  }
  const sameBoot = query.get('bootId') === null || query.get('bootId') === events.bootId
  response.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
  })
  const write = (event: TetherEvent) => response.write(`${JSON.stringify(event)}\n`)
  write(events.control('hello', { apiVersion: API_VERSION, instance: context.paths.instance }))
  if (since !== null) {
    const replay = sameBoot ? events.replay(since) : null
    if (replay === null) write(events.control('gap', { since }))
    else for (const event of replay) write(event)
  }
  const unsubscribe = events.subscribe(write)
  const heartbeat = setInterval(
    () => write(events.control('heartbeat')),
    context.heartbeatMs ?? 15_000,
  )
  const stop = () => {
    clearInterval(heartbeat)
    unsubscribe()
  }
  request.once('close', stop)
  response.once('close', stop)
}

export function buildRouter(context: ServerContext): Router {
  const { store, events, projects, paths } = context
  const now = context.now ?? Date.now
  const router = new Router()

  router
    // Health never touches tmux; it proves the socket, the event loop and the
    // database are responsive.
    .add('GET', '/v1/health', (_req, res) => {
      sendJson(res, 200, {
        status: 'ok',
        name: 'tether',
        instance: paths.instance,
        version: VERSION,
        apiVersion: API_VERSION,
        schemaVersion: store.schemaVersion(),
        uptimeMs: Math.max(0, now() - context.startedAt),
        bootId: events.bootId,
        eventSeq: events.lastSeq,
        catalog: store.counts(),
        gui: { connected: context.gui.connected() },
        lifecycle: lifecycleStatus(),
      })
    })
    .add('GET', '/v1/version', (_req, res) => {
      sendJson(res, 200, {
        name: 'tether',
        version: VERSION,
        apiVersion: API_VERSION,
        minApiVersion: 1,
        node: process.version,
      })
    })
    .add('GET', '/v1/projects', async (_req, res, _params, query) => {
      const list = await projects.list({ refresh: query.get('refresh') === '1' })
      for (const project of list.projects) context.projectRoots.set(project.id, project.root)
      sendJson(res, 200, list)
    })
    .add('POST', '/v1/projects', async (req, res) => {
      const body = await readJsonObject(req)
      const unknown = Object.keys(body).filter((key) => !['id', 'name', 'root'].includes(key))
      if (unknown.length) throw new HttpError(400, 'invalid_body', { fields: unknown })
      const id = str(body, 'id')
      const root = str(body, 'root')
      const name = nullableStr(body, 'name')
      if (!id || !root) throw new HttpError(400, 'invalid_body', { detail: 'id and root required' })
      try {
        const project = await registerLocalProject(projects, paths.localProjectsFile, {
          id,
          root,
          name,
        })
        context.projectRoots.set(project.id, project.root)
        events.publish('projects.changed', { id: project.id, change: 'registered' })
        sendJson(res, 201, project)
      } catch (error) {
        if (error instanceof ProjectRegistrationError) throw new HttpError(error.status, error.code)
        throw error
      }
    })
    .add('POST', '/v1/tools/import', async (req, res) => {
      const body = await readJsonObject(req)
      const unknown = Object.keys(body).filter(
        (key) => !['tools', 'dryRun', 'updateExisting'].includes(key),
      )
      if (unknown.length) throw new HttpError(400, 'invalid_body', { fields: unknown })
      if (!Array.isArray(body.tools) || body.tools.length > 200)
        throw new HttpError(400, 'invalid_body', { field: 'tools' })
      const seeds = body.tools.map((item, index) => {
        if (!item || typeof item !== 'object' || Array.isArray(item))
          throw new HttpError(400, 'invalid_body', { index })
        const fields = toolFields(item as Record<string, unknown>)
        if (!fields.slug || !fields.name || fields.argv === undefined)
          throw new HttpError(400, 'invalid_body', {
            index,
            detail: 'slug, name and argv|command required',
          })
        return { ...fields, slug: fields.slug, name: fields.name, argv: fields.argv }
      })
      const dryRun = bool(body, 'dryRun') ?? false
      const result = store.importTools(
        seeds,
        {
          dryRun,
          updateExisting: bool(body, 'updateExisting') ?? false,
        },
        now(),
      )
      if (!dryRun && (result.created.length || result.updated.length))
        events.publish('tools.changed', { change: 'imported' })
      sendJson(res, 200, { applied: !dryRun, ...result })
    })
    .add('GET', '/v1/tools', (_req, res, _params, query) => {
      const enabledOnly = query.get('enabled') === '1' || query.get('enabled') === 'true'
      const tools = store.listTools({ enabledOnly })
      sendJson(res, 200, {
        items: tools.map(toolJson),
        defaultSlug: store.defaultTool()?.slug ?? null,
      })
    })
    .add('GET', '/v1/tools/:ref', (_req, res, params) => {
      const tool = store.resolveTool(params.ref ?? '')
      if (!tool) throw new HttpError(404, 'not_found')
      sendJson(res, 200, toolJson(tool))
    })
    .add('POST', '/v1/tools', async (req, res) => {
      const fields = toolFields(await readJsonObject(req))
      if (!fields.slug || !fields.name || fields.argv === undefined) {
        throw new HttpError(400, 'invalid_body', { detail: 'slug, name and argv|command required' })
      }
      const seed: ToolSeed = {
        slug: fields.slug,
        name: fields.name,
        argv: fields.argv,
        processName: fields.processName ?? fields.argv[0] ?? '',
        description: fields.description ?? null,
        color: fields.color ?? null,
        displayOrder: fields.displayOrder ?? 0,
        isDefault: fields.isDefault ?? false,
        enabled: fields.enabled ?? true,
        aliases: fields.aliases ?? [],
        contextHook: fields.contextHook ?? null,
      }
      const tool = store.createTool(seed, now())
      events.publish('tools.changed', { slug: tool.slug, change: 'created' })
      sendJson(res, 201, toolJson(tool))
    })
    .add('PATCH', '/v1/tools/:ref', async (req, res, params) => {
      const fields = toolFields(await readJsonObject(req))
      if (fields.slug !== undefined) throw new HttpError(400, 'slug_immutable')
      const tool = store.updateTool(params.ref ?? '', fields, now())
      if (!tool) throw new HttpError(404, 'not_found')
      events.publish('tools.changed', { slug: tool.slug, change: 'updated' })
      sendJson(res, 200, toolJson(tool))
    })
    .add('DELETE', '/v1/tools/:ref', (_req, res, params) => {
      const result = store.deleteTool(params.ref ?? '')
      if (result === 'absent') throw new HttpError(404, 'not_found')
      if (result !== 'deleted') throw new HttpError(409, result)
      events.publish('tools.changed', { ref: params.ref, change: 'deleted' })
      sendJson(res, 200, { deleted: true })
    })
    .add('GET', '/v1/events', (req, res, _params, query) => {
      streamEvents(context, req, res, query)
    })

  registerLifecycleRoutes(router, context)

  return router
}

export function createTetherServer(context: ServerContext): Server {
  const router = buildRouter(context)
  return createServer((request, response) => {
    router.dispatch(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy()
        return
      }
      if (error instanceof HttpError) sendError(response, error)
      else if (error instanceof ToolValidationError)
        sendError(response, new HttpError(400, error.code))
      else {
        console.error('[tether] request failed:', error)
        sendError(response, new HttpError(500, 'internal_error'))
      }
    })
  })
}
