// HTTP surface over the extracted lifecycle engine (docs/api-v1.md: Sessions,
// Terminal I/O, Roots, GUI forwarding, A-Term legacy sessions). Handlers only
// parse, fence and map results; every lifecycle decision is the engine's.

import { execFile } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { promisify } from 'node:util'
import type { AgentStateTracker, HookReport } from './agent-state'
import type { TetherPaths } from './config'
import type { EventBus } from './events'
import type { GuiChannel, GuiCommand } from './gui-channel'
import { HttpError, type Router, readJsonObject, sendJson } from './http'
import type { LegacyATermSessions } from './legacy-aterm'
import {
  allocateWidgetId,
  getTmuxServer,
  getWidget,
  insertWidget,
  listWidgets,
  recordLauncher,
  rootRequestForWidget,
  type SessionOrigin,
  setCoordinator,
  setWidgetName,
  setWidgetProject,
  type WidgetRow,
} from './lifecycle/catalog'
import {
  cachedSessionStatus,
  contextStatus,
  discardNeverAllocated,
  endSession,
  ensureSessionSerialized,
  hasVerifiedStatus,
  isDir,
  lastEnsureFailure,
  lifecycleOwners,
  lifecycleStatus,
  lingerEnabled,
  loadTui,
  notifySessionChanged,
  probeContext,
  type RespawnResult,
  reconcileWidgetTool,
  releaseLifecycleOwner,
  respawnAndRelaunch,
  rootManagedGateState,
  type SessionStatus,
  sessionDiagnostics,
  switchProject,
  tmuxPaneTargetForWidget,
  tmuxTargetForWidget,
  verifiedCurrentManagedPane,
  verifySessionStatus,
  whenReady,
} from './lifecycle/engine'
import { claimTmuxViewSize, type ResizeRefusal } from './lifecycle/interactive-tmux'
import { isNeverAllocatedWidget } from './lifecycle/lifecycle-guard'
import { sessionGeneration } from './lifecycle/owner-retirement'
import { ForegroundPaneMemory, systemdPaneMemoryHost } from './lifecycle/pane-memory'
import {
  type Bounds,
  createRootHandler,
  type MutationRejection,
  parseLabel,
  type RootControlOperations,
  type WidgetMutation,
  widgetMutationOperation,
} from './lifecycle/root-control'
import { withRootPrompt } from './lifecycle/root-launch'
import { readScrollbackPage } from './lifecycle/scrollback-page'
import { terminalClientEnv } from './lifecycle/terminal-env'
import {
  bracketedPasteTargetArgs,
  captureVisibleTargetArgs,
  isBoundedTerminalText,
  sendTextTargetArgs,
  sessionName,
  type TmuxTarget,
} from './lifecycle/tmux'
import { staticContextStatus } from './lifecycle/tui/context'
import { getTui } from './lifecycle/tui/registry'
import { paneModeArgs, parsePaneMode } from './pane-mode'
import type { ProjectProvider } from './projects'
import { type Continuity, registerRebootRoutes } from './reboot'
import type { Store } from './store'

const execFileAsync = promisify(execFile)
const TMUX_BIN = '/usr/bin/tmux'
const TMUX_TIMEOUT_MS = 2_000
const RUNNING_SETTLE_MS = 3_000
const RUNNING_POLL_MS = 100
const GENERATION_RE = /^[0-9a-f]{64}$/
const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
const ORIGINS: readonly SessionOrigin[] = ['aico', 'a-term', 'cli']

let foregroundPaneMemory: ForegroundPaneMemory | null = null

function foregroundMemory(): ForegroundPaneMemory {
  if (!foregroundPaneMemory) {
    const uid = process.getuid?.() ?? -1
    foregroundPaneMemory = new ForegroundPaneMemory(
      systemdPaneMemoryHost(
        `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/app.slice`,
        () => new Set(listWidgets().flatMap((row) => (row.scopeUnit ? [row.scopeUnit] : []))),
      ),
    )
  }
  return foregroundPaneMemory
}

export interface LifecycleApiContext {
  paths: TetherPaths
  store: Store
  events: EventBus
  projects: ProjectProvider
  gui: GuiChannel
  legacy: LegacyATermSessions
  /** Sync project-root cache the engine reads on gate recovery. */
  projectRoots: Map<string, string>
  /** Reboot continuity; absent when reconciliation is off (test instances). */
  continuity?: Continuity
}

/** The daemon's agent-state tracker; unbound in tests and scratch instances. */
let agentStates: AgentStateTracker | null = null

export function bindAgentStates(tracker: AgentStateTracker | null): void {
  agentStates = tracker
}

/** The session's agent state fields (docs/api-v1.md "Agent state"). */
export function agentStateOf(id: string): Record<string, unknown> {
  const record = agentStates?.get(id) ?? {
    state: 'unknown',
    stateSource: 'none',
    stateAt: 0,
    stateDetail: null,
    statePrevious: 'unknown',
  }
  return { ...record, stateAt: record.stateAt || null }
}

/** The session's opaque fence (Aico `sessionGeneration`). */
export function generationOf(row: WidgetRow): string {
  return sessionGeneration(row)
}

/**
 * The session's context-hook verification state (docs/api-v1.md). Tether
 * probes the hook after each launch and after its own restart; `unknown` means
 * no probe for the session's current tool has finished yet.
 */
export function contextHookOf(row: WidgetRow): Record<string, unknown> {
  const status = contextStatus(row.id)
  if (status && status.slug === row.tool) {
    return {
      state: status.state,
      detail: status.detail,
      tool: status.slug,
      applicable: status.applicable,
      checkedAt: status.checkedAt,
    }
  }
  const spec = getTui(row.tool)
  const fixed = spec ? staticContextStatus(spec) : null
  return {
    state: fixed?.state ?? 'unknown',
    detail: fixed?.detail ?? 'Context delivery has not been checked yet.',
    tool: row.tool,
    applicable: Boolean(spec && spec.command.length > 0),
    checkedAt: null,
  }
}

export function descriptor(row: WidgetRow, status: SessionStatus): Record<string, unknown> {
  const server = row.tmuxServerId ? getTmuxServer(row.tmuxServerId) : undefined
  const target = tmuxTargetForWidget(row.id)
  return {
    id: row.id,
    ownershipId: row.sessionId,
    generation: generationOf(row),
    status,
    available: status === 'running',
    tool: row.tool,
    name: row.name,
    label: row.name ?? `Session ${row.seq}`,
    projectId: row.projectId,
    projectRoot: row.projectRoot,
    origin: row.origin,
    aTermSessionId: row.aTermSessionId,
    coordinator: row.coordinator,
    coordinatorId: row.coordinatorId,
    coordinatorColor: row.coordinatorColor,
    rootRequestId: rootRequestForWidget(row.id)?.requestId ?? null,
    lifecycleVersion: row.lifecycleVersion,
    tmux: {
      serverId: row.tmuxServerId,
      socket:
        server?.socketPath ?? (row.tmuxAllocationState === 'unallocated' ? null : target.socket),
      sessionId: row.tmuxSessionId,
      paneId: row.paneId,
      sessionName: sessionName(row.id),
    },
    contextHook: contextHookOf(row),
    ...agentStateOf(row.id),
    createdAt: row.createdAt,
  }
}

const HOOK_EVENTS = new Set(['Notification', 'PermissionRequest', 'UserPromptSubmit', 'Stop'])

/** Validate an agent hook report (`POST /v1/sessions/:id/agent-event`). */
export function parseHookReport(body: Record<string, unknown>): HookReport {
  only(body, ['event', 'notificationType', 'agent', 'agentSessionId'])
  const { event, notificationType, agent, agentSessionId } = body
  if (typeof event !== 'string' || !HOOK_EVENTS.has(event))
    throw new HttpError(400, 'invalid_body', { field: 'event' })
  if (agent !== 'claude' && agent !== 'codex')
    throw new HttpError(400, 'invalid_body', { field: 'agent' })
  const optional = (value: unknown, field: string): string | null => {
    if (value === undefined || value === null || value === '') return null
    if (typeof value !== 'string' || value.length > 100)
      throw new HttpError(400, 'invalid_body', { field })
    return value
  }
  return {
    event,
    agent,
    notificationType: optional(notificationType, 'notificationType'),
    agentSessionId: optional(agentSessionId, 'agentSessionId'),
  }
}

/** The event snapshot: the descriptor with the last verified status. */
export function sessionSnapshot(row: WidgetRow): Record<string, unknown> {
  return descriptor(row, cachedSessionStatus(row))
}

function only(body: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key))
  if (unknown.length) throw new HttpError(400, 'invalid_body', { fields: unknown })
}

function requireGeneration(body: Record<string, unknown>): string {
  const value = body.generation
  if (typeof value !== 'string' || !GENERATION_RE.test(value)) {
    throw new HttpError(400, 'invalid_generation')
  }
  return value
}

function requireSession(id: string | undefined): WidgetRow {
  const row = id && /^[0-9a-f]{8}$/.test(id) ? getWidget(id) : undefined
  if (!row) throw new HttpError(404, 'not_found')
  return row
}

function fence(row: WidgetRow, generation: string): void {
  if (generationOf(row) !== generation) throw new HttpError(409, 'stale_generation')
}

function size(value: unknown): { cols: number; rows: number } {
  const record = value as Record<string, unknown> | null
  const ok = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n > 0 && n <= 1000
  if (
    !record ||
    typeof record !== 'object' ||
    Object.keys(record).some((key) => key !== 'cols' && key !== 'rows') ||
    !ok(record.cols) ||
    !ok(record.rows)
  ) {
    throw new HttpError(400, 'invalid_body', { field: 'size' })
  }
  return { cols: record.cols as number, rows: record.rows as number }
}

async function settleRunning(
  widgetId: string,
): Promise<{ row: WidgetRow; status: SessionStatus } | null> {
  const deadline = Date.now() + RUNNING_SETTLE_MS
  for (;;) {
    const row = getWidget(widgetId)
    if (!row) return null
    const status = await verifySessionStatus(row)
    if (status === 'running' || Date.now() >= deadline || row.launchState !== 'dispatched') {
      return { row: getWidget(widgetId) ?? row, status }
    }
    await new Promise((resolve) => setTimeout(resolve, RUNNING_POLL_MS))
  }
}

function respawnError(result: RespawnResult): HttpError | null {
  switch (result.status) {
    case 'replaced':
      return null
    case 'not_found':
      return new HttpError(404, 'not_found')
    case 'stale':
      return new HttpError(409, 'stale_generation')
    case 'busy':
    case 'legacy_session':
      return new HttpError(409, result.status)
    default:
      return new HttpError(409, result.status, { reason: result.reason })
  }
}

async function runTmux(args: string[], maxBuffer = 1024 * 1024): Promise<string> {
  const { stdout } = await execFileAsync(TMUX_BIN, args, {
    encoding: 'utf8',
    env: terminalClientEnv(),
    timeout: TMUX_TIMEOUT_MS,
    maxBuffer,
  })
  return stdout
}

/** Client environment for `tmux attach` (docs/api-v1.md Terminal I/O). */
export const ATTACH_ENV = { TERM: 'xterm-256color', COLORTERM: 'truecolor', CLICOLOR: '1' }
export const ATTACH_UNSET = ['TMUX', 'TMUX_PANE', 'TMUX_TMPDIR', 'NO_COLOR']

function attachArgv(target: TmuxTarget): string[] {
  if (!target.socket) throw new HttpError(409, 'workload_unavailable')
  return [TMUX_BIN, '-S', target.socket, 'attach-session', '-t', target.session]
}

/**
 * Run `apply` only against the exact running generation while holding the one
 * lifecycle lock (Aico `widgetMutationOperation`). Returns the apply outcome,
 * or `false` when the session is not the exact running workload or is busy.
 */
async function withRunningSession<T>(
  widgetId: string,
  generation: string,
  apply: (row: WidgetRow) => Promise<T>,
): Promise<T | false> {
  let outcome: T | undefined
  const ok = await widgetMutationOperation(widgetId, generation, {
    acquire: (id) => lifecycleOwners.acquire(id),
    release: (id, owner) => releaseLifecycleOwner(id, owner),
    getWidget,
    gateState: rootManagedGateState,
    apply: async (row) => {
      outcome = await apply(row)
    },
  })
  return ok ? (outcome as T) : false
}

/** Paste `text` into a running session and submit it (the inject route's
 * paste mode). False when the session is not running. */
export async function pasteIntoRunningSession(widgetId: string, text: string): Promise<boolean> {
  const row = getWidget(widgetId)
  if (!row || !isBoundedTerminalText(text)) return false
  const delivered = await withRunningSession(row.id, generationOf(row), async (current) => {
    await runTmux(bracketedPasteTargetArgs(tmuxPaneTargetForWidget(current.id), text, true))
    return true
  })
  return delivered === true
}

export function forwardViewMutation(
  gui: GuiChannel,
): (
  widgetId: string,
  generation: string,
  mutation: WidgetMutation,
) => Promise<boolean | MutationRejection> {
  return async (widgetId, generation, mutation) => {
    if (!gui.connected()) {
      if (mutation.kind !== 'title' && mutation.kind !== 'coordinator')
        return { status: 503, error: 'gui_unavailable' }
      // No GUI to hold a view: the title is the session name and the
      // coordinator mark is session metadata. Change the exact running
      // generation under the lifecycle lock.
      const changed = await withRunningSession(widgetId, generation, async (row) => {
        if (mutation.kind === 'title') setWidgetName(row.id, mutation.label)
        if (mutation.kind === 'coordinator') setCoordinator(row.id, mutation.coordinator)
        notifySessionChanged(row.id, { force: true })
        return true as const
      })
      return changed
    }
    const result = await withRunningSession(widgetId, generation, async (row) => {
      const command: GuiCommand = { kind: mutation.kind, sessionId: row.id, generation }
      if (mutation.kind === 'position') command.bounds = mutation.bounds as Bounds
      if (mutation.kind === 'title') command.label = mutation.label
      if (mutation.kind === 'coordinator') command.coordinator = mutation.coordinator
      const outcome = await gui.send(command)
      if (outcome.status === 'unavailable') return { status: 503, error: 'gui_unavailable' }
      if (outcome.status === 'timeout') return { status: 409, error: 'outcome_uncertain' }
      if (outcome.status === 'rejected') return { status: 409, error: outcome.error }
      if (mutation.kind === 'title') {
        // The catalog name changes only when the GUI applied the title.
        setWidgetName(row.id, mutation.label)
        notifySessionChanged(row.id, { force: true })
      }
      if (mutation.kind === 'coordinator') {
        setCoordinator(row.id, mutation.coordinator)
        notifySessionChanged(row.id, { force: true })
      }
      return true as const
    })
    return result === false ? false : result
  }
}

export function rootOperations(context: LifecycleApiContext): RootControlOperations {
  const mutate = forwardViewMutation(context.gui)
  return {
    available: () => true,
    launched: (widgetId, launchedBy) => {
      for (const id of recordLauncher(widgetId, launchedBy))
        notifySessionChanged(id, { force: true })
    },
    validate: (request) => Boolean(getTui(request.tool)?.enabled && isDir(request.projectRoot)),
    ensure: async (widgetId, prompt, resumeSessionId) => {
      await whenReady()
      const row = getWidget(widgetId)
      // Root cwd is exact. Never inherit another project or fall back to a
      // default directory after the requested one disappears.
      if (!row?.projectRoot || !isDir(row.projectRoot)) return
      await withRootPrompt(
        widgetId,
        prompt,
        async () => {
          await ensureSessionSerialized(widgetId, { cols: 100, rows: 30 })
        },
        resumeSessionId,
      )
      const latest = getWidget(widgetId)
      // Verify now so `GET /v1/sessions` agrees with `GET /v1/sessions/:id`.
      if (latest) await verifySessionStatus(latest).catch(() => undefined)
      if (
        latest?.launchState === 'dispatched' &&
        context.gui.connected() &&
        (await verifiedCurrentManagedPane(latest))
      ) {
        // Aico focused the new root's window. Best effort: the GUI decides.
        void context.gui.send({
          kind: 'show',
          sessionId: latest.id,
          generation: generationOf(latest),
        })
      }
      context.events.publish('root.updated', { id: widgetId })
    },
    status: async (row) => {
      if (
        row.launchState === 'dispatched' &&
        (await rootManagedGateState(row)) === 'active-workload'
      )
        return 'running'
      return isNeverAllocatedWidget(row) ? 'pending' : 'uncertain'
    },
    mutate,
    end: async (widgetId, generation) => {
      await whenReady()
      const result = await endSession(widgetId, generation)
      if (result.status === 'ended') context.events.publish('root.updated', { id: widgetId })
      return result
    },
  }
}

async function resolveProject(
  context: LifecycleApiContext,
  projectId: string,
): Promise<string | null> {
  const list = await context.projects.list()
  for (const project of list.projects) context.projectRoots.set(project.id, project.root)
  const match = list.projects.find((project) => project.id === projectId)
  return match ? match.root : null
}

export function registerLifecycleRoutes(router: Router, context: LifecycleApiContext): void {
  if (context.continuity) registerRebootRoutes(router, context.continuity)
  const { store, events, gui, legacy } = context
  const rootHandler = createRootHandler(rootOperations(context), { ownerFromOrigin: true })
  const root = (req: IncomingMessage, res: ServerResponse) => rootHandler(req, res)

  router
    .add('GET', '/v1/sessions', async (_req, res, _params, query) => {
      const project = query.get('project')
      const origin = query.get('origin')
      const tool = query.get('tool')
      const rows = listWidgets().filter(
        (row) =>
          (project === null || row.projectId === project) &&
          (origin === null || row.origin === origin) &&
          (tool === null || row.tool === tool),
      )
      // A session whose current generation was never verified (a fresh root
      // or replacement) is verified here, so the list agrees with a GET.
      const items = await Promise.all(
        rows.map(async (row) => {
          if (hasVerifiedStatus(row) || lifecycleStatus() === 'disabled')
            return descriptor(row, cachedSessionStatus(row))
          const status = await verifySessionStatus(row).catch(() => cachedSessionStatus(row))
          return descriptor(getWidget(row.id) ?? row, status)
        }),
      )
      sendJson(res, 200, { items })
    })
    .add('POST', '/v1/sessions', async (req, res) => {
      const body = await readJsonObject(req)
      only(body, ['tool', 'projectId', 'projectRoot', 'name', 'origin', 'aTermSessionId', 'size'])
      const origin = body.origin
      if (typeof origin !== 'string' || !ORIGINS.includes(origin as SessionOrigin)) {
        throw new HttpError(400, 'invalid_body', { field: 'origin' })
      }
      let aTermSessionId: string | null = null
      if (body.aTermSessionId !== undefined && body.aTermSessionId !== null) {
        if (
          origin !== 'a-term' ||
          typeof body.aTermSessionId !== 'string' ||
          !UUID_RE.test(body.aTermSessionId)
        )
          throw new HttpError(400, 'invalid_body', { field: 'aTermSessionId' })
        aTermSessionId = body.aTermSessionId
      }
      const grid = size(body.size)
      let name: string | null = null
      if (body.name !== undefined && body.name !== null) {
        name = parseLabel(body.name)
        if (name === null) throw new HttpError(400, 'invalid_body', { field: 'name' })
      }
      if (body.tool !== undefined && typeof body.tool !== 'string')
        throw new HttpError(400, 'invalid_body', { field: 'tool' })
      const tool =
        body.tool === undefined ? store.defaultTool() : store.resolveTool(body.tool as string)
      if (!tool || !tool.enabled) throw new HttpError(400, 'unknown_tool')
      let projectId: string | null = null
      let projectRoot: string | null = null
      if (body.projectId !== undefined && body.projectId !== null) {
        if (typeof body.projectId !== 'string' || !body.projectId)
          throw new HttpError(400, 'invalid_body', { field: 'projectId' })
        projectId = body.projectId
      }
      if (body.projectRoot !== undefined && body.projectRoot !== null) {
        if (typeof body.projectRoot !== 'string' || !body.projectRoot.startsWith('/'))
          throw new HttpError(400, 'invalid_body', { field: 'projectRoot' })
        if (!isDir(body.projectRoot)) throw new HttpError(400, 'unknown_project')
        projectRoot = body.projectRoot
      }
      if (projectId && !projectRoot) {
        projectRoot = await resolveProject(context, projectId)
        if (!projectRoot) throw new HttpError(400, 'unknown_project')
      }
      await whenReady()
      if (!lingerEnabled()) throw new HttpError(503, 'linger_required')

      const id = allocateWidgetId()
      insertWidget(id, tool.slug, Date.now(), { origin: origin as SessionOrigin, aTermSessionId })
      if (projectId || projectRoot) setWidgetProject(id, projectId, projectRoot)
      if (name) setWidgetName(id, name)
      const started = await ensureSessionSerialized(id, grid)
      if (!started) {
        const failure = lastEnsureFailure(id)
        if (failure?.code === 'admission_denied' || failure?.code === 'linger_required') {
          // Refused before allocation: nothing exists, so nothing is kept.
          if (discardNeverAllocated(id)) notifySessionChanged(id, { ended: true })
          throw new HttpError(failure.code === 'linger_required' ? 503 : 409, failure.code, {
            reason: failure.reason,
          })
        }
      }
      const settled = await settleRunning(id)
      if (!settled) throw new HttpError(409, 'outcome_uncertain')
      const result = descriptor(settled.row, settled.status)
      if (!started) result.failure = lastEnsureFailure(id) ?? null
      sendJson(res, settled.status === 'running' ? 201 : 202, result)
    })
    .add('GET', '/v1/sessions/:id', async (_req, res, params) => {
      const row = requireSession(params.id)
      const generation = generationOf(row)
      const status = await verifySessionStatus(row)
      const latest = getWidget(row.id)
      if (!latest) throw new HttpError(404, 'not_found')
      if (generationOf(latest) !== generation) throw new HttpError(409, 'identity_changed')
      sendJson(res, 200, descriptor(latest, status))
    })
    .add('PATCH', '/v1/sessions/:id', async (req, res, params) => {
      const body = await readJsonObject(req)
      only(body, ['generation', 'name'])
      const generation = requireGeneration(body)
      if (!('name' in body)) throw new HttpError(400, 'invalid_body', { field: 'name' })
      let name: string | null = null
      if (body.name !== null) {
        name = parseLabel(body.name)
        if (name === null) throw new HttpError(400, 'invalid_body', { field: 'name' })
      }
      const row = requireSession(params.id)
      fence(row, generation)
      setWidgetName(row.id, name)
      notifySessionChanged(row.id, { force: true })
      const latest = requireSession(row.id)
      sendJson(res, 200, descriptor(latest, cachedSessionStatus(latest)))
    })
    .add('POST', '/v1/sessions/:id/end', async (req, res, params) => {
      const body = await readJsonObject(req)
      only(body, ['generation'])
      const generation = requireGeneration(body)
      requireSession(params.id)
      await whenReady()
      const result = await endSession(params.id as string, generation)
      if (result.status === 'ended') sendJson(res, 200, { status: 'ended' })
      else if (result.status === 'absent') throw new HttpError(404, 'not_found')
      else if (result.status === 'stale') throw new HttpError(409, 'stale_generation')
      else if (result.status === 'busy') throw new HttpError(409, 'busy')
      else throw new HttpError(409, 'blocked', { reason: result.reason })
    })
    .add('POST', '/v1/sessions/:id/respawn', async (req, res, params) => {
      const body = await readJsonObject(req)
      only(body, ['generation'])
      const generation = requireGeneration(body)
      const row = requireSession(params.id)
      fence(row, generation)
      await whenReady()
      const result = await respawnAndRelaunch(row.id, getTui(row.tool), {
        expectedGeneration: generation,
        generationOf,
      })
      await answerReplacement(res, row.id, result)
    })
    .add('POST', '/v1/sessions/:id/load-tui', async (req, res, params) => {
      const body = await readJsonObject(req)
      only(body, ['generation', 'tool'])
      const generation = requireGeneration(body)
      if (typeof body.tool !== 'string') throw new HttpError(400, 'invalid_body', { field: 'tool' })
      const tool = store.resolveTool(body.tool)
      const spec = tool?.enabled ? getTui(tool.slug) : undefined
      if (!spec) throw new HttpError(400, 'unknown_tool')
      const row = requireSession(params.id)
      fence(row, generation)
      await whenReady()
      await answerReplacement(
        res,
        row.id,
        await loadTui(row.id, spec, { expectedGeneration: generation, generationOf }),
      )
    })
    .add('POST', '/v1/sessions/:id/switch-project', async (req, res, params) => {
      const body = await readJsonObject(req)
      only(body, ['generation', 'projectId', 'projectRoot'])
      const generation = requireGeneration(body)
      // Exactly one of projectId (resolved once) or projectRoot (an absolute
      // directory with no project, as on create).
      const byId = body.projectId !== undefined && body.projectId !== null
      const byRoot = body.projectRoot !== undefined && body.projectRoot !== null
      if (byId === byRoot)
        throw new HttpError(400, 'invalid_body', { detail: 'send projectId or projectRoot' })
      if (byId && (typeof body.projectId !== 'string' || !body.projectId))
        throw new HttpError(400, 'invalid_body', { field: 'projectId' })
      if (byRoot && (typeof body.projectRoot !== 'string' || !body.projectRoot.startsWith('/')))
        throw new HttpError(400, 'invalid_body', { field: 'projectRoot' })
      const row = requireSession(params.id)
      fence(row, generation)
      const projectId = byId ? (body.projectId as string) : null
      let projectRoot: string | null
      if (projectId) projectRoot = await resolveProject(context, projectId)
      else projectRoot = isDir(body.projectRoot as string) ? (body.projectRoot as string) : null
      if (!projectRoot) throw new HttpError(400, 'unknown_project')
      await whenReady()
      await answerReplacement(
        res,
        row.id,
        await switchProject(row.id, projectId, projectRoot, {
          expectedGeneration: generation,
          generationOf,
        }),
      )
    })
    .add('GET', '/v1/sessions/:id/diagnostics', async (_req, res, params) => {
      const row = requireSession(params.id)
      sendJson(res, 200, { ...(await sessionDiagnostics(row.id)), agent: agentStateOf(row.id) })
    })
    // Agent hooks inside the pane (Claude Code Notification/UserPromptSubmit)
    // report state changes here; see docs/agent-state.md.
    .add('POST', '/v1/sessions/:id/agent-event', async (req, res, params) => {
      const row = requireSession(params.id)
      const report = parseHookReport(await readJsonObject(req))
      const applied = agentStates?.report(row.id, report) ?? false
      sendJson(res, 200, { applied, ...agentStateOf(row.id) })
    })
    .add('POST', '/v1/sessions/:id/context-check', async (_req, res, params) => {
      const row = requireSession(params.id)
      const spec = getTui(row.tool)
      if (spec) await probeContext(row.id, spec)
      const latest = requireSession(row.id)
      sendJson(res, 200, { generation: generationOf(latest), contextHook: contextHookOf(latest) })
    })
    .add('GET', '/v1/sessions/:id/pane-mode', async (_req, res, params) => {
      const row = requireSession(params.id)
      if (isNeverAllocatedWidget(row)) throw new HttpError(409, 'workload_unavailable')
      const target = tmuxPaneTargetForWidget(row.id)
      if (!target.socket) throw new HttpError(409, 'workload_unavailable')
      let stdout: string
      try {
        stdout = await runTmux(paneModeArgs(target.socket, target.session), 4096)
      } catch {
        throw new HttpError(409, 'workload_unavailable')
      }
      sendJson(res, 200, { generation: generationOf(row), ...parsePaneMode(stdout) })
    })
    .add('GET', '/v1/sessions/:id/attach', async (_req, res, params) => {
      const row = requireSession(params.id)
      if (isNeverAllocatedWidget(row)) throw new HttpError(409, 'workload_unavailable')
      await whenReady()
      // Recovery only: an allocated session is never implicitly relaunched.
      if (!(await ensureSessionSerialized(row.id, { cols: 100, rows: 30 }))) {
        throw new HttpError(409, 'workload_unavailable', {
          reason: lastEnsureFailure(row.id)?.reason ?? 'tmux session is not present',
        })
      }
      await reconcileWidgetTool(row.id)
      const latest = requireSession(row.id)
      sendJson(res, 200, {
        generation: generationOf(latest),
        argv: attachArgv(tmuxTargetForWidget(latest.id)),
        env: ATTACH_ENV,
        unset: ATTACH_UNSET,
      })
    })
    .add('GET', '/v1/sessions/:id/capture', async (_req, res, params, query) => {
      const row = requireSession(params.id)
      if (isNeverAllocatedWidget(row)) throw new HttpError(409, 'workload_unavailable')
      const escapes = query.get('escapes') === '1'
      let text: string
      try {
        text = await runTmux(captureVisibleTargetArgs(tmuxPaneTargetForWidget(row.id), escapes))
      } catch {
        throw new HttpError(409, 'workload_unavailable')
      }
      sendJson(res, 200, { generation: generationOf(row), text })
    })
    .add('GET', '/v1/sessions/:id/scrollback', async (_req, res, params, query) => {
      const row = requireSession(params.id)
      if (isNeverAllocatedWidget(row)) throw new HttpError(409, 'workload_unavailable')
      const number = (key: string) => {
        const value = query.get(key)
        if (value === null) return undefined
        const n = Number(value)
        if (!Number.isSafeInteger(n) || n < 0)
          throw new HttpError(400, 'invalid_query', { field: key })
        return n
      }
      try {
        const page = await readScrollbackPage(
          (args, maxBuffer) => runTmux(args, maxBuffer),
          tmuxPaneTargetForWidget(row.id),
          {
            fromLine: number('fromLine'),
            count: number('count'),
            plain: query.get('escapes') !== '1',
          },
        )
        sendJson(res, 200, { generation: generationOf(row), ...page })
      } catch (error) {
        if (error instanceof HttpError) throw error
        throw new HttpError(409, 'workload_unavailable')
      }
    })
    .add('POST', '/v1/sessions/:id/inject', async (req, res, params) => {
      const body = await readJsonObject(req)
      only(body, ['generation', 'text', 'mode', 'submit'])
      const generation = requireGeneration(body)
      if (!isBoundedTerminalText(body.text)) throw new HttpError(400, 'invalid_text')
      const text = body.text
      if (body.mode !== 'type' && body.mode !== 'paste')
        throw new HttpError(400, 'invalid_body', { field: 'mode' })
      if (body.submit !== undefined && typeof body.submit !== 'boolean')
        throw new HttpError(400, 'invalid_body', { field: 'submit' })
      if (body.mode === 'type' && body.submit)
        throw new HttpError(400, 'invalid_body', { field: 'submit' })
      const row = requireSession(params.id)
      fence(row, generation)
      await whenReady()
      const mode = body.mode
      const submit = body.submit === true
      const delivered = await withRunningSession(row.id, generation, async (current) => {
        const target = tmuxPaneTargetForWidget(current.id)
        await runTmux(
          mode === 'type'
            ? sendTextTargetArgs(target, text)
            : bracketedPasteTargetArgs(target, text, submit),
        )
        return true
      })
      if (!delivered) throw new HttpError(409, 'workload_unavailable')
      sendJson(res, 200, { generation, delivered: true })
    })
    .add('POST', '/v1/sessions/:id/show', async (req, res, params) => {
      // Ask the GUI to open (or focus) this session's view.
      const body = await readJsonObject(req)
      only(body, ['generation'])
      const generation = requireGeneration(body)
      const row = requireSession(params.id)
      fence(row, generation)
      await whenReady()
      const result = await forwardViewMutation(context.gui)(row.id, generation, { kind: 'show' })
      if (result === false) throw new HttpError(409, 'workload_unavailable')
      if (result !== true) throw new HttpError(result.status, result.error)
      sendJson(res, 200, { shown: true })
    })
    .add('POST', '/v1/sessions/:id/resize-claim', async (req, res, params) => {
      const body = await readJsonObject(req)
      only(body, ['generation', 'clientPid', 'cols', 'rows'])
      const generation = requireGeneration(body)
      const row = requireSession(params.id)
      fence(row, generation)
      const isCurrent = () => {
        const latest = getWidget(row.id)
        return Boolean(latest && generationOf(latest) === generation)
      }
      let refusal: ResizeRefusal | 'tmux_unavailable' | null
      try {
        refusal = await claimTmuxViewSize(
          tmuxTargetForWidget(row.id),
          body.clientPid as number,
          body.cols as number,
          body.rows as number,
          (args) => runTmux(args),
          isCurrent,
        )
      } catch {
        refusal = 'tmux_unavailable'
      }
      if (refusal === null) {
        // Aico claims the size when a view gains focus: that pane is foreground.
        void foregroundMemory().focus(getWidget(row.id)?.scopeUnit ?? null)
        events.publish('session.resized', { id: row.id, generation })
        sendJson(res, 200, { applied: true })
      } else {
        sendJson(res, 200, { applied: false, reason: refusal })
      }
    })
    // Roots and the compact widget routes share Aico's one handler.
    .add('GET', '/v1/roots', root)
    .add('POST', '/v1/roots', root)
    .add('GET', '/v1/roots/:requestId', root)
    .add('POST', '/v1/roots/:requestId/:action', root)
    .add('GET', '/v1/roots/:requestId/:action', root)
    .add('GET', '/v1/widgets/:id', root)
    .add('POST', '/v1/widgets/:id/:action', root)
    .add('GET', '/v1/gui/channel', (req, res) => {
      if (req.headers['x-tether-client'] !== 'aico-gui') throw new HttpError(400, 'invalid_client')
      gui.attach(req, res)
    })
    .add('POST', '/v1/gui/results/:commandId', async (req, res, params) => {
      const body = await readJsonObject(req)
      only(body, ['applied', 'error'])
      let accepted: boolean
      try {
        accepted = gui.result(params.commandId ?? '', body)
      } catch {
        throw new HttpError(400, 'invalid_body')
      }
      if (!accepted) throw new HttpError(404, 'not_found')
      sendJson(res, 200, { accepted: true })
    })
    // A-Term's pre-Tether sessions: list, attach, end. Never adopted.
    .add('GET', '/v1/legacy-sessions', async (_req, res) => {
      sendJson(res, 200, { items: await legacy.list() })
    })
    .add('GET', '/v1/legacy-sessions/:name/attach', async (_req, res, params) => {
      const session = await legacy.get(params.name ?? '')
      if (!session) throw new HttpError(404, 'not_found')
      sendJson(res, 200, {
        argv: legacy.attachArgv(session.name),
        env: ATTACH_ENV,
        unset: ATTACH_UNSET,
      })
    })
    .add('GET', '/v1/legacy-sessions/:name/pane-mode', async (_req, res, params) => {
      const mode = await legacy.paneMode(params.name ?? '')
      if (!mode) throw new HttpError(404, 'not_found')
      sendJson(res, 200, mode)
    })
    .add('POST', '/v1/legacy-sessions/:name/end', async (_req, res, params) => {
      if (!(await legacy.end(params.name ?? ''))) throw new HttpError(404, 'not_found')
      sendJson(res, 200, { status: 'ended' })
    })
}

async function answerReplacement(
  res: ServerResponse,
  widgetId: string,
  result: RespawnResult,
): Promise<void> {
  const error = respawnError(result)
  if (error) throw error
  const settled = await settleRunning(widgetId)
  if (!settled) throw new HttpError(404, 'not_found')
  sendJson(res, 200, descriptor(settled.row, settled.status))
}
