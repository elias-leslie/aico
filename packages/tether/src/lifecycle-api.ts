// HTTP surface over the extracted lifecycle engine (docs/api-v1.md: Sessions,
// Terminal I/O, Roots, GUI forwarding). Handlers only
// parse, fence and map results; every lifecycle decision is the engine's.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { hostname } from 'node:os'
import { Catalog } from '@aico/context'
import type { Hub } from '@aico/fleet/hub/hub'
import {
  AUTO_HOST,
  type HostVerdict,
  LOCAL_HOST,
  type Needs,
  type Placement,
  parseNeeds,
  parsePool,
  UnknownPool,
} from '@aico/fleet/hub/placement'
import {
  agentSessionIdOf,
  agentStateOf,
  type HookReport,
  reportAgentState,
} from '@aico/session-engine/agent-state'
import {
  adoptLineage,
  allocateWidgetId,
  clearLaunched,
  coordinatorSubtree,
  getTmuxServer,
  getWidget,
  insertWidget,
  joinCoordinator,
  listSessions,
  listWidgets,
  recordLauncher,
  rootRequestForWidget,
  type SessionOrigin,
  setCoordinator,
  setWidgetName,
  setWidgetProject,
  transferCoordinator,
  type WidgetRow,
} from '@aico/session-engine/catalog'
import {
  autoName,
  badge,
  conversationDoing,
  displayTitle,
  rememberProjects,
  taskName,
} from '@aico/session-engine/display'
import {
  agentExitOf,
  cachedSessionStatus,
  contextStatus,
  discardNeverAllocated,
  endSession,
  ensureSessionSerialized,
  hasVerifiedStatus,
  holdPromotion,
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
  releasePromotion,
  respawnAndRelaunch,
  rootManagedGateState,
  type SessionStatus,
  sessionDiagnostics,
  switchProject,
  tmuxPaneTargetForWidget,
  tmuxTargetForWidget,
  verifySessionStatus,
  whenReady,
} from '@aico/session-engine/engine'
import type { EventBus } from '@aico/session-engine/events'
import { claimTmuxViewSize, type ResizeClaimResult } from '@aico/session-engine/interactive-tmux'
import { isNeverAllocatedWidget } from '@aico/session-engine/lifecycle-guard'
import { ForegroundPaneMemory, systemdPaneMemoryHost } from '@aico/session-engine/pane-memory'
import type { TetherPaths } from '@aico/session-engine/paths'
import type { Project } from '@aico/session-engine/project'
import {
  createRootHandler,
  isProjectRootPath,
  type MutationRejection,
  parseLabel,
  type RootControlOperations,
  type RootHandlerState,
  type WidgetMutation,
} from '@aico/session-engine/root-control'
import {
  holdResume,
  launchingResume,
  sessionSpec,
  withRootPrompt,
} from '@aico/session-engine/root-launch'
import {
  generationOf,
  runTmux,
  TMUX_BIN,
  withRunningSession,
} from '@aico/session-engine/running-session'
import { readScrollbackPage } from '@aico/session-engine/scrollback-page'
import type { Store } from '@aico/session-engine/store'
import {
  bracketedPasteTargetArgs,
  captureVisibleTargetArgs,
  isBoundedTerminalText,
  sendKeyTargetArgs,
  sendTextTargetArgs,
  sessionName,
  type TmuxTarget,
} from '@aico/session-engine/tmux'
import { agyDoing } from '@aico/session-engine/tui/adapters/agy-doing'
import {
  createBlankSlateWorkspace,
  ensureBlankSlateWorkspace,
  isBlankSlateRoot,
  supportsBlankSlate,
} from '@aico/session-engine/tui/blank-slate'
import { staticContextStatus } from '@aico/session-engine/tui/context'
import {
  parseInstructions,
  saveInstructions,
  sessionInstructions,
} from '@aico/session-engine/tui/instructions'
import { isResumeSessionId } from '@aico/session-engine/tui/launch'
import { listsModel } from '@aico/session-engine/tui/models'
import {
  ADAPTERS,
  adapterOf,
  getTui,
  supportsInstructions,
} from '@aico/session-engine/tui/registry'
import { extractSignInLink, signInToolOf } from '@aico/session-engine/tui/sign-in-link'
import {
  type Handler,
  HttpError,
  onlyFields,
  type Router,
  readJsonObject,
  sendError,
  sendJson,
} from '@aico/shared/http'
import { type AskDelivery, AskStore, sessionAsks, transferAskNotices } from './asks'
import { ContinuationError, continuation } from './continue-from'
import { ConversationUnknown, conversationHolder as holderOf } from './conversation-holder'
import { type LaneReporter, laneView, registerLaneRoutes } from './lane-reports'
import type { ModelSwitch, ModelWatch } from './model-switch'
import { paneModeArgs, parsePaneMode } from './pane-mode'
import type { ProjectProvider } from './projects'
import { type Continuity, registerRebootRoutes } from './reboot'
import { type Recovery, registerRecoveryRoutes } from './recovery'
import { RewindRefused, rewindClaude } from './rewind'
import type { History } from './sessions/history'
import { parseViewerLabel, recordSizeHolder, sizeHolderOf } from './size-holder'
import { registerWaitRoutes, type WaitService } from './waits'
import {
  registerWakeRoutes,
  sessionWaitingOn,
  sessionWakes,
  type WakeService,
} from './wake-runtime'

const RUNNING_SETTLE_MS = 3_000
/** A session report carries its last message whole, up to this much. */
const REPORT_TEXT_MAX = 200_000
const RUNNING_POLL_MS = 100
const GENERATION_RE = /^[0-9a-f]{64}$/
const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
const SESSION_ID_RE = /^[0-9a-f]{8}$/
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

/** The pane scope the owner is looking at, if a focus has been seen. */
export function foregroundPaneScope(): string | null {
  return foregroundPaneMemory?.foreground ?? null
}

export interface LifecycleApiContext {
  paths: TetherPaths
  store: Store
  events: EventBus
  projects: ProjectProvider
  /** Sync project-root cache the engine reads on gate recovery. */
  projectRoots: Map<string, string>
  asks?: AskDelivery
  /** Reboot continuity; absent when reconciliation is off (test instances). */
  continuity?: Continuity
  /** Crash recovery; absent when reconciliation is off. */
  recovery?: Recovery
  /** Session wakes (scheduled check-ins); absent in route-only tests. */
  wakes?: WakeService
  /** The remote hosts this Tether federates; absent in route-only tests. */
  hub?: Hub
  /** Root-handler state shared by every router of this daemon (one
   * serialization per request, whichever router took it). */
  rootState?: RootHandlerState
  /** `host: "auto"` placement; absent in route-only tests. */
  placement?: Placement
  /** Lane reports; absent where Tether does not observe sessions. */
  lanes?: LaneReporter
  /** General waits (src/waits.ts); absent where Tether does not observe sessions. */
  waits?: WaitService
  /** The session history; `continueFrom` reads the old session's transcript from it. */
  history?: History
}

const NEEDS_SHAPE =
  'needs is {memBytes, cpu?, caps?}: whole bytes, CPUs 0-1024, up to 8 capability names'
const POOL_SHAPE =
  'pool is a placement pool name from placement.json (lowercase letters, digits, dashes)'
/** At most this many hosts' reasons in one answer. */
const MAX_VERDICTS = 16

function atCapacityLine(verdict: HostVerdict): { host: string; reason: string } {
  return { host: verdict.host, reason: verdict.reason }
}

/** `GET /v1/placement?mem=<bytes>&cpu=<n>&cap=<name>`: needs from a query, or null. */
function needsFromQuery(query: URLSearchParams): Needs | null {
  const mem = query.get('mem')
  const cpu = query.get('cpu')
  if (
    mem === null ||
    !/^\d{1,16}$/.test(mem) ||
    (cpu !== null && !/^\d{1,4}(\.\d{1,2})?$/.test(cpu))
  )
    return null
  return parseNeeds({
    memBytes: Number(mem),
    cpu: cpu === null ? 0 : Number(cpu),
    caps: query.getAll('cap'),
  })
}

/** The daemon's model watch (src/model-switch.ts); unbound in tests and
 * scratch instances. */
let modelWatch: ModelWatch | null = null

export function bindModelWatch(watch: ModelWatch | null): void {
  modelWatch = watch
}

/** The session's standing model switch (docs/api-v1.md "Model switches"). */
function sessionModelSwitch(id: string): ModelSwitch | null {
  return modelWatch?.switchOf(id) ?? null
}

/**
 * The session's context-hook verification state (docs/api-v1.md). Tether
 * probes the hook after each launch and after its own restart; `unknown` means
 * no probe for the session's current tool has finished yet.
 */
function contextHookOf(row: WidgetRow): Record<string, unknown> {
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
  const spec = sessionSpec(getTui(row.tool), row.projectRoot, row.id)
  const fixed = spec ? staticContextStatus(spec) : null
  return {
    state: fixed?.state ?? 'unknown',
    detail: fixed?.detail ?? 'Context delivery has not been checked yet.',
    tool: row.tool,
    applicable: Boolean(spec && spec.command.length > 0),
    checkedAt: null,
  }
}

/** agy's own database says what it is doing; the others' transcripts do (the session history). */
function doingNow(row: WidgetRow): string | null {
  return row.tool === 'agy' ? agyDoing(agentSessionIdOf(row.id)) : conversationDoing(row.id)
}

function descriptor(row: WidgetRow, status: SessionStatus): Record<string, unknown> {
  const agent = agentStateOf(row.id)
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
    // What the tool running in it calls the conversation (or its first prompt): used when no name was typed.
    autoName: autoName(row.id),
    // The task part of `displayTitle` (typed name, else autoName...), without the project.
    taskName: taskName(row),
    label: row.name ?? autoName(row.id) ?? `Session ${row.seq}`,
    projectId: row.projectId,
    projectRoot: row.projectRoot,
    origin: row.origin,
    aTermSessionId: row.aTermSessionId,
    coordinator: row.coordinator,
    coordinatorId: row.coordinatorId,
    coordinatorColor: row.coordinatorColor,
    parentId: row.parentId,
    displayTitle: displayTitle(row),
    badge: badge(row),
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
    instructions: sessionInstructions(row.id),
    ...agent,
    // One line on what a working agent is doing now (null when it is not working).
    doing: agent.state === 'working' ? doingNow(row) : null,
    wakes: sessionWakes(row.id),
    waitingOn: sessionWaitingOn(row.id),
    modelSwitch: sessionModelSwitch(row.id),
    launched: row.launched,
    asks: sessionAsks(row.id),
    createdAt: row.createdAt,
    // This computer's own session; the hub tags a remote host's with its name.
    host: null,
  }
}

const MODEL_CATALOG = new Catalog()

const HOOK_EVENTS = new Set(ADAPTERS.flatMap((adapter) => adapter.hooks.stateReports))

/** Validate an agent hook report (`POST /v1/sessions/:id/agent-event`). */
export function parseHookReport(body: Record<string, unknown>): HookReport {
  onlyFields(body, ['event', 'notificationType', 'agent', 'agentSessionId'])
  const { event, notificationType, agent, agentSessionId } = body
  if (typeof event !== 'string' || !HOOK_EVENTS.has(event))
    throw new HttpError(400, 'invalid_body', { field: 'event' })
  if (
    typeof agent !== 'string' ||
    !ADAPTERS.some((a) => a.capabilities.stateHooks && a.harness === agent)
  )
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
      return new HttpError(409, result.status)
    default:
      return new HttpError(409, result.status, { reason: result.reason })
  }
}

/** Client environment for `tmux attach` (docs/api-v1.md Terminal I/O). */
const ATTACH_ENV = { TERM: 'xterm-256color', COLORTERM: 'truecolor', CLICOLOR: '1' }
const ATTACH_UNSET = ['TMUX', 'TMUX_PANE', 'TMUX_TMPDIR', 'NO_COLOR']

function attachArgv(target: TmuxTarget): string[] {
  if (!target.socket) throw new HttpError(409, 'workload_unavailable')
  return [TMUX_BIN, '-S', target.socket, 'attach-session', '-t', target.session]
}

/** Mark, unmark, or join a coordinator, and publish every changed session. */
function applyCoordinator(id: string, coordinator: boolean | string): void {
  const changed = [id]
  if (typeof coordinator === 'string') {
    changed.push(...joinCoordinator(id, coordinator))
    // The owner's join: neither the session nor the lanes that moved with it
    // report to their new coordinator.
    for (const changedId of changed) clearLaunched(changedId)
  } else setCoordinator(id, coordinator)
  for (const changedId of new Set(changed)) notifySessionChanged(changedId, { force: true })
}

/** Title and coordinator mutations apply to the catalog on the exact running
 * generation. Aico has no desktop windows, so there is no view to forward to. */
function applyViewMutation(): (
  widgetId: string,
  generation: string,
  mutation: WidgetMutation,
) => Promise<boolean | MutationRejection> {
  return async (widgetId, generation, mutation) => {
    // The title is the session name and the coordinator mark is session
    // metadata. Change the exact running generation under the lifecycle lock.
    return withRunningSession(widgetId, generation, async (row) => {
      if (mutation.kind === 'title') setWidgetName(row.id, mutation.label)
      if (mutation.kind === 'coordinator') applyCoordinator(row.id, mutation.coordinator)
      else notifySessionChanged(row.id, { force: true })
      return true as const
    })
  }
}

export function rootOperations(context: LifecycleApiContext): RootControlOperations {
  const mutate = applyViewMutation()
  return {
    available: () => true,
    launched: (widgetId, launchedBy) => {
      // A launcher on another machine hands down the lineage the hub knows.
      const remote = getWidget(launchedBy) ? null : (context.hub?.lineageFor(launchedBy) ?? null)
      if (remote) adoptLineage(widgetId, remote)
      const changed = remote ? [widgetId] : recordLauncher(widgetId, launchedBy)
      for (const id of changed) notifySessionChanged(id, { force: true })
    },
    adopt: (widgetId, lineage) => {
      adoptLineage(widgetId, lineage)
      notifySessionChanged(widgetId, { force: true })
    },
    remote: async (body, response) => {
      if (!context.hub) {
        sendJson(response, 400, { error: 'unknown_host', host: body.host })
        return
      }
      try {
        await context.hub.create(response, '/v1/roots', body)
      } catch (error) {
        if (!(error instanceof HttpError)) throw error
        sendError(response, error)
      }
    },
    place: async (requestId, raw, rawPool, host) => {
      const needs = parseNeeds(raw)
      if (!needs)
        return {
          kind: 'refused',
          status: 400,
          body: { error: 'invalid_body', field: 'needs', reason: NEEDS_SHAPE },
        }
      const pool = parsePool(rawPool)
      if (!pool)
        return {
          kind: 'refused',
          status: 400,
          body: { error: 'invalid_body', field: 'pool', reason: POOL_SHAPE },
        }
      if (!context.placement)
        return {
          kind: 'refused',
          status: 400,
          body: { error: 'unknown_host', host: host ?? AUTO_HOST },
        }
      if (host !== undefined && host !== LOCAL_HOST && context.hub) {
        const peer = context.hub.peerView(host)
        // A newly running host can still be connecting. Use create's existing
        // readiness wait before judging its room; a powered-off host still
        // reserves room before create wakes it.
        if (!peer || (!peer.live && peer.state !== 'powered_off'))
          try {
            await context.hub.wakeHost(host)
          } catch (error) {
            if (!(error instanceof HttpError)) throw error
            return {
              kind: 'refused',
              status: error.status,
              body: { error: error.code, ...error.extra },
            }
          }
      }
      const placed = await context.placement.place(requestId, needs, pool, host)
      if (placed.kind === 'placed') return placed
      if (placed.kind === 'unknown_host')
        return { kind: 'refused', status: 400, body: { error: 'unknown_host', host: placed.host } }
      if (placed.kind === 'placed_elsewhere')
        return {
          kind: 'refused',
          status: 409,
          body: {
            error: 'request_conflict',
            host: placed.host,
            reason: `this request is already on ${placed.host}`,
          },
        }
      if (placed.kind === 'unknown_pool')
        return {
          kind: 'refused',
          status: 400,
          body: { error: 'unknown_pool', pool, pools: placed.pools },
        }
      // Nothing was reserved or created: the same create can be repeated.
      return {
        kind: 'refused',
        status: 409,
        body: {
          error: 'at_capacity',
          hosts: placed.verdicts.slice(0, MAX_VERDICTS).map(atCapacityLine),
        },
      }
    },
    remoteRoots: (search) => context.hub?.roots(search) ?? Promise.resolve([]),
    validate: (request) => {
      if (isBlankSlateRoot(request.projectRoot)) ensureBlankSlateWorkspace(request.projectRoot)
      return Boolean(getTui(request.tool)?.enabled && isDir(request.projectRoot))
    },
    refuse: async (request) => {
      // Two agents must never resume one conversation, whoever already holds it.
      if (request.resumeSessionId && !request.entry) {
        try {
          const holder = await holderOf(context, request.resumeSessionId)
          if (holder)
            return {
              status: 409,
              error: 'conversation_open',
              reason: `session ${holder} is already on this conversation; end it first`,
            }
        } catch (error) {
          if (!(error instanceof ConversationUnknown)) throw error
          return { status: 503, error: 'unavailable', reason: error.message }
        }
      }
      const spec = getTui(request.tool)
      // An entry's agent runs elsewhere: this host's model list says nothing about it.
      if (!spec || !request.model || request.entry) return null
      if ((await listsModel(spec, request.model)) !== false) return null
      return {
        status: 422,
        error: 'unknown_model',
        reason: `${request.tool} on ${hostname()} has no model ${request.model} (${[spec.command[0], ...(spec.modelSelection?.listModels ?? [])].join(' ')})`,
      }
    },
    resumeOwner: (resumeSessionId) => context.recovery?.resumeOwner(resumeSessionId) ?? null,
    agentExit: (row) => {
      const marker = agentExitOf(row)
      if (marker?.state === 'exit') return { status: marker.status }
      if (marker?.state === 'signal') return { signal: marker.signal }
      return null
    },
    launchDeferral: (widgetId) => {
      const failure = lastEnsureFailure(widgetId)
      return failure?.code === 'admission_denied' ? failure.reason : null
    },
    ensure: async (widgetId, prompt, resumeSessionId, options) => {
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
        options,
      ).finally(() => {
        // Its agent can't be seen on the conversation yet; a launch deferred by admission renews this.
        if (resumeSessionId) holdResume(widgetId, resumeSessionId)
      })
      const latest = getWidget(widgetId)
      // Verify now so `GET /v1/sessions` agrees with `GET /v1/sessions/:id`.
      if (latest) await verifySessionStatus(latest).catch(() => undefined)
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

/** A body `projectRoot` on create and switch-project: the /v1/roots path
 * rule, then an existing directory. switch-project also checks the rule
 * before its session lookup. */
function requireProjectRoot(value: unknown): string {
  if (!isProjectRootPath(value)) throw new HttpError(400, 'invalid_body', { field: 'projectRoot' })
  if (!isDir(value)) throw new HttpError(400, 'unknown_project')
  return value
}

async function resolveProject(
  context: LifecycleApiContext,
  projectId: string,
): Promise<string | null> {
  const list = await context.projects.list()
  learnProjects(context, list.projects)
  const match = list.projects.find((project) => project.id === projectId)
  return match ? match.root : null
}

/** Record project roots and names; names that changed retitle every session. */
export function learnProjects(
  context: Pick<LifecycleApiContext, 'projectRoots'>,
  projects: Project[],
): void {
  for (const project of projects) context.projectRoots.set(project.id, project.root)
  if (rememberProjects(projects))
    for (const row of listSessions()) notifySessionChanged(row.id, { force: true })
}

/** What a reopened session's agent is told first. */
const REOPEN_PROMPT =
  'The owner reopened this session after it ended. Processes, servers and watchers you started before are gone. Wait for their next message.'

/** Who holds this conversation (conversation-holder.ts); 503 when nobody can say. */
export async function conversationHolder(
  context: LifecycleApiContext,
  resumeId: string,
): Promise<string | null> {
  try {
    return await holderOf(context, resumeId)
  } catch (error) {
    if (error instanceof ConversationUnknown) throw new HttpError(503, 'reopen_unavailable')
    throw error
  }
}

function createSession(context: LifecycleApiContext): Handler {
  const { store } = context
  return async (req, res) => {
    const body = await readJsonObject(req)
    onlyFields(body, [
      'tool',
      'projectId',
      'projectRoot',
      'blankSlate',
      'instructions',
      'name',
      'origin',
      'aTermSessionId',
      'size',
      'host',
      'continueFrom',
      'resumeId',
    ])
    if (body.host !== undefined && body.host !== null) {
      if (body.continueFrom != null) throw new HttpError(400, 'continue_on_this_host_only')
      if (body.resumeId != null) throw new HttpError(400, 'reopen_on_this_host_only')
      if (!context.hub) throw new HttpError(400, 'unknown_host', { host: body.host })
      await context.hub.create(res, '/v1/sessions', body)
      return
    }
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
    if (!tool?.enabled) throw new HttpError(400, 'unknown_tool')
    let projectId: string | null = null
    let projectRoot: string | null = null
    if (body.projectId !== undefined && body.projectId !== null) {
      if (typeof body.projectId !== 'string' || !body.projectId)
        throw new HttpError(400, 'invalid_body', { field: 'projectId' })
      projectId = body.projectId
    }
    if (body.projectRoot !== undefined && body.projectRoot !== null)
      projectRoot = requireProjectRoot(body.projectRoot)
    if (projectId && !projectRoot) {
      projectRoot = await resolveProject(context, projectId)
      if (!projectRoot) throw new HttpError(400, 'unknown_project')
    }
    if (body.resumeId != null && (body.continueFrom != null || body.blankSlate === true))
      throw new HttpError(400, 'invalid_body', { field: 'resumeId' })
    // Continue another session: a recap of it is this one's first prompt, in the same checkout.
    let recap: string | null = null
    if (body.continueFrom !== undefined && body.continueFrom !== null) {
      if (typeof body.continueFrom !== 'string' || !SESSION_ID_RE.test(body.continueFrom))
        throw new HttpError(400, 'invalid_body', { field: 'continueFrom' })
      if (body.tool === undefined) throw new HttpError(400, 'invalid_body', { field: 'tool' })
      if (body.blankSlate === true)
        throw new HttpError(400, 'invalid_body', { field: 'blankSlate' })
      try {
        const old = getWidget(body.continueFrom)
        const found = await continuation({
          history: context.history,
          from: body.continueFrom,
          source: old,
          tool: tool.slug,
        })
        recap = found.prompt
        if (!projectId && !projectRoot) {
          projectId = found.projectId
          projectRoot = found.projectRoot
        }
        name ??= parseLabel(found.name)
      } catch (error) {
        if (error instanceof ContinuationError) throw new HttpError(error.status, error.code)
        throw error
      }
    }
    // Reopen an ended session: its tool resumes its own conversation in the same checkout. Never
    // a conversation another session is running or resuming now.
    let resumeId: string | null = null
    if (body.resumeId !== undefined && body.resumeId !== null) {
      if (body.tool === undefined) throw new HttpError(400, 'invalid_body', { field: 'tool' })
      if (!isResumeSessionId(getTui(tool.slug), body.resumeId))
        throw new HttpError(400, 'invalid_body', { field: 'resumeId' })
      if (!projectRoot) throw new HttpError(400, 'reopen_needs_project')
      const holder = await conversationHolder(context, body.resumeId)
      if (holder) throw new HttpError(409, 'conversation_open', { session: holder })
      resumeId = body.resumeId
    }
    // Blank Slate: a fresh empty workspace instead of a project (blank-slate.ts).
    if (body.blankSlate !== undefined && body.blankSlate !== false) {
      if (body.blankSlate !== true || projectId || projectRoot)
        throw new HttpError(400, 'invalid_body', { field: 'blankSlate' })
      if (!supportsBlankSlate(tool.slug)) throw new HttpError(400, 'blank_slate_unsupported')
    }
    // A prompt revision the caller resolved (tui/instructions.ts).
    const instructions =
      body.instructions === undefined || body.instructions === null
        ? null
        : parseInstructions(body.instructions)
    if (body.instructions != null && !instructions)
      throw new HttpError(400, 'invalid_body', { field: 'instructions' })
    if (instructions && !supportsInstructions(tool.slug))
      throw new HttpError(400, 'instructions_unsupported')
    await whenReady()
    if (!lingerEnabled()) throw new HttpError(503, 'linger_required')

    if (body.blankSlate === true) projectRoot = createBlankSlateWorkspace()
    const id = allocateWidgetId()
    insertWidget(id, tool.slug, Date.now(), { origin: origin as SessionOrigin, aTermSessionId })
    if (projectId || projectRoot) setWidgetProject(id, projectId, projectRoot)
    if (name) setWidgetName(id, name)
    if (instructions) saveInstructions(id, instructions)
    const launch = () => ensureSessionSerialized(id, grid)
    // Checked again here: nothing awaits between this and withRootPrompt claiming it.
    const racing =
      resumeId === null
        ? null
        : (launchingResume(resumeId, id) ?? context.recovery?.resumeOwner(resumeId) ?? null)
    if (racing) {
      if (discardNeverAllocated(id)) notifySessionChanged(id, { ended: true })
      throw new HttpError(409, 'conversation_open', { session: racing })
    }
    // Held from before the launch claim ends until its agent can be seen, so no gap opens.
    if (resumeId !== null) holdResume(id, resumeId)
    const started = await (resumeId !== null
      ? withRootPrompt(id, REOPEN_PROMPT, launch, resumeId).finally(() => holdResume(id, resumeId))
      : recap === null
        ? launch()
        : withRootPrompt(id, recap, launch))
    if (!started) {
      const failure = lastEnsureFailure(id)
      if (failure?.code === 'admission_denied' || failure?.code === 'linger_required') {
        // Refused before allocation: nothing exists, so nothing is kept.
        if (discardNeverAllocated(id)) notifySessionChanged(id, { ended: true })
        const refusalStatus = failure.code === 'linger_required' ? 503 : 409
        throw new HttpError(refusalStatus, failure.code, {
          reason: failure.reason,
        })
      }
    }
    const settled = await settleRunning(id)
    if (!settled) throw new HttpError(409, 'outcome_uncertain')
    const result = descriptor(settled.row, settled.status)
    if (!started) result.failure = lastEnsureFailure(id) ?? null
    sendJson(res, settled.status === 'running' ? 201 : 202, result)
  }
}

function transferSession(context: LifecycleApiContext): Handler {
  const { store } = context
  return async (req, res, params) => {
    const body = await readJsonObject(req)
    onlyFields(body, ['generation', 'coordinatorId', 'coordinatorGeneration', 'fromCoordinatorId'])
    const generation = requireGeneration(body)
    if (
      typeof body.coordinatorId !== 'string' ||
      !/^[0-9a-f]{8}$/.test(body.coordinatorId) ||
      typeof body.fromCoordinatorId !== 'string' ||
      !/^[0-9a-f]{8}$/.test(body.fromCoordinatorId) ||
      typeof body.coordinatorGeneration !== 'string' ||
      !GENERATION_RE.test(body.coordinatorGeneration)
    )
      throw new HttpError(400, 'invalid_body')
    const lane = requireSession(params.id),
      lead = requireSession(body.coordinatorId)
    fence(lane, generation)
    fence(lead, body.coordinatorGeneration)
    const members = coordinatorSubtree(lane.id)
    const locks: {
      id: string
      owner: NonNullable<ReturnType<typeof lifecycleOwners.acquire>>
    }[] = []
    try {
      for (const id of [...new Set([lead.id, ...members.map((row) => row.id)])].sort()) {
        const owner = lifecycleOwners.acquire(id)
        if (!owner) throw new HttpError(409, 'busy')
        locks.push({ id, owner })
      }
      // Verify both exact runtimes under ownership. A transfer never launches,
      // injects into, ends, rebooks or replaces either session.
      for (const row of [lane, lead]) {
        if (
          row.launchState !== 'dispatched' ||
          (await rootManagedGateState(row)) !== 'active-workload'
        )
          throw new HttpError(409, 'workload_unavailable')
        fence(requireSession(row.id), generationOf(row))
      }
      const current = requireSession(lane.id),
        target = requireSession(lead.id)
      fence(current, generation)
      fence(target, body.coordinatorGeneration)
      if (
        !target.coordinator ||
        target.coordinatorId !== null ||
        target.parentId !== null ||
        target.id === current.id
      )
        throw new HttpError(409, 'not_top_level_coordinator')
      if (current.coordinator || !current.launched || !current.coordinatorId)
        throw new HttpError(409, 'lane_not_linked')
      const already = current.coordinatorId === target.id && current.parentId === target.id
      if (!already && current.coordinatorId !== body.fromCoordinatorId)
        throw new HttpError(409, 'lineage_changed')
      const previous = getWidget(body.fromCoordinatorId)
      if (
        !already &&
        (!previous?.coordinator || previous.coordinatorId !== null || previous.parentId !== null)
      )
        throw new HttpError(409, 'not_top_level_coordinator')
      const latest = coordinatorSubtree(current.id)
      if (
        latest.length !== members.length ||
        latest.some(
          (row, i) =>
            row.id !== members[i].id ||
            generationOf(row) !== generationOf(members[i]) ||
            row.coordinatorId !== current.coordinatorId,
        )
      )
        throw new HttpError(409, 'lineage_changed')
      const asks = new AskStore(store.db)
      store.transaction(() => {
        transferCoordinator(current.id, target, latest)
        const movedAsks = latest
          .filter((row) => row.launched)
          .flatMap((row) =>
            asks.transferLineage(
              row.id,
              row.id === current.id ? target.id : row.parentId,
              target.id,
            ),
          )
        if (context.asks && !already) transferAskNotices(movedAsks, context.asks)
      })
      for (const row of latest) {
        // Update report routing before yielding to delivery timers, rather
        // than waiting for the asynchronous descriptor publication.
        const view = laneView(descriptor(requireSession(row.id), cachedSessionStatus(row)), null)
        if (view) context.lanes?.observe(view)
        notifySessionChanged(row.id, { force: true })
      }
      sendJson(res, 200, {
        ...descriptor(requireSession(current.id), 'running'),
        transferred: latest.map((row) => row.id),
      })
    } finally {
      for (const { id, owner } of locks.reverse()) releaseLifecycleOwner(id, owner)
    }
  }
}

function endSessionRoute(context: LifecycleApiContext): Handler {
  return async (req, res, params) => {
    const body = await readJsonObject(req)
    onlyFields(body, ['generation', 'keepWakes', 'endedBy'])
    const generation = requireGeneration(body)
    if (body.keepWakes !== undefined && typeof body.keepWakes !== 'boolean')
      throw new HttpError(400, 'invalid_body', { field: 'keepWakes' })
    // The session asking for this End (`st aico root end` from a lane's
    // coordinator): it gets no lane `ended` line for it (API 21).
    if (
      body.endedBy !== undefined &&
      (typeof body.endedBy !== 'string' || !/^[0-9a-f]{8}$/.test(body.endedBy))
    )
      throw new HttpError(400, 'invalid_body', { field: 'endedBy' })
    const endedBy = body.endedBy as string | undefined
    const row = requireSession(params.id)
    await whenReady()
    // Kept wakes outlive the row (the End trigger drops every other one);
    // an End that does not happen takes the mark back.
    let kept = 0
    let keptWaits = 0
    if (body.keepWakes === true && context.wakes && generationOf(row) === generation) {
      const wakes = context.wakes
      const armed = context.waits?.store.countArmed(row.id) ?? 0
      if (wakes.store.checkIns(row.id).length || armed) {
        const snapshot = await wakes.endedSnapshot(row)
        kept = wakes.store.keep(row.id, snapshot)
        if (armed) keptWaits = context.waits?.keep(row.id, snapshot) ?? 0
      }
    }
    const lanes = context.lanes
    const marked =
      endedBy !== undefined && endedBy !== row.id && lanes
        ? lanes.store.markEnd(row.id, endedBy, Date.now())
        : false
    let result: Awaited<ReturnType<typeof endSession>>
    // A kept wake relaunches the coordinator and rejoins its lanes, so End does not promote them.
    if ((kept || keptWaits) && row.coordinator) holdPromotion(row.id)
    try {
      result = await endSession(params.id as string, generation)
    } finally {
      if (marked) lanes?.store.unmarkEnd(row.id)
      releasePromotion(row.id)
    }
    if (kept || keptWaits) {
      if (result.status === 'ended') context.wakes?.changed(null)
      else if (getWidget(row.id)) {
        context.wakes?.store.unkeep(row.id)
        context.waits?.unkeep(row.id)
      }
    }
    if (result.status === 'ended') sendJson(res, 200, { ...result, keptWakes: kept, keptWaits })
    else if (result.status === 'absent') throw new HttpError(404, 'not_found')
    else if (result.status === 'stale') throw new HttpError(409, 'stale_generation')
    else if (result.status === 'busy') throw new HttpError(409, 'busy')
    else throw new HttpError(409, 'blocked', { reason: result.reason })
  }
}

/** `GET /v1/placement`: where `host: "auto"` would put these needs now. */
function registerPlacementRoutes(router: Router, context: LifecycleApiContext): void {
  router
    // Where `host: "auto"` would put these needs now; reserves nothing.
    .add('GET', '/v1/placement', async (_req, res, _params, query) => {
      const needs = needsFromQuery(query)
      if (!needs) throw new HttpError(400, 'invalid_body', { field: 'needs', reason: NEEDS_SHAPE })
      const pool = parsePool(query.get('pool') ?? undefined)
      if (!pool) throw new HttpError(400, 'invalid_body', { field: 'pool', reason: POOL_SHAPE })
      if (!context.placement) throw new HttpError(400, 'unknown_host', { host: AUTO_HOST })
      let verdicts: HostVerdict[]
      try {
        verdicts = await context.placement.check(needs, pool)
      } catch (error) {
        if (!(error instanceof UnknownPool)) throw error
        throw new HttpError(400, 'unknown_pool', { pool, pools: error.pools })
      }
      const hosts = verdicts.slice(0, MAX_VERDICTS)
      sendJson(res, 200, {
        needs,
        pool,
        host: hosts.find((verdict) => verdict.fits)?.host ?? null,
        hosts,
        reservations: context.placement.list(),
      })
    })
}

/** List, create, read and rename sessions. */
function registerSessionCatalogRoutes(router: Router, context: LifecycleApiContext): void {
  router
    .add('GET', '/v1/sessions', async (_req, res, _params, query) => {
      const project = query.get('project')
      const origin = query.get('origin')
      const tool = query.get('tool')
      const wanted = (row: { projectId: unknown; origin: unknown; tool: unknown }) =>
        (project === null || row.projectId === project) &&
        (origin === null || row.origin === origin) &&
        (tool === null || row.tool === tool)
      const rows = listSessions().filter(wanted)
      // Remote hosts' sessions, asked in parallel with this computer's.
      const remote = context.hub?.sessions() ?? Promise.resolve([])
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
      const remoteItems = (await remote).filter((item) =>
        wanted({ projectId: item.projectId, origin: item.origin, tool: item.tool }),
      )
      sendJson(res, 200, { items: [...items, ...remoteItems] })
    })
    .add('POST', '/v1/sessions', createSession(context))
    .add('GET', '/v1/sessions/:id', async (_req, res, params) => {
      const row = requireSession(params.id)
      const generation = generationOf(row)
      const status = await verifySessionStatus(row)
      const latest = getWidget(row.id)
      if (!latest) throw new HttpError(404, 'not_found')
      if (generationOf(latest) !== generation) throw new HttpError(409, 'identity_changed')
      // `resumeId`: the native conversation ID of a Claude Code or Codex session, as last
      // observed; null when none is known.
      sendJson(res, 200, {
        ...descriptor(latest, status),
        resumeId: context.continuity?.resumeIdOf(latest.id, latest.tool) ?? null,
      })
    })
    .add('PATCH', '/v1/sessions/:id', async (req, res, params) => {
      const body = await readJsonObject(req)
      onlyFields(body, ['generation', 'name'])
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
}

/** Hand a lane to another coordinator, end, respawn, and swap a session's tool or project. */
function registerSessionLifecycleRoutes(router: Router, context: LifecycleApiContext): void {
  router
    .add('POST', '/v1/sessions/:id/transfer', transferSession(context))
    .add('POST', '/v1/sessions/:id/end', endSessionRoute(context))
    .add('POST', '/v1/sessions/:id/respawn', async (req, res, params) => {
      const body = await readJsonObject(req)
      onlyFields(body, ['generation'])
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
      onlyFields(body, ['generation', 'tool'])
      const generation = requireGeneration(body)
      if (typeof body.tool !== 'string') throw new HttpError(400, 'invalid_body', { field: 'tool' })
      const tool = context.store.resolveTool(body.tool)
      const spec = tool?.enabled ? getTui(tool.slug) : undefined
      if (!spec) throw new HttpError(400, 'unknown_tool')
      // A chat has no terminal to put in a pane.
      const row = requireSession(params.id)
      fence(row, generation)
      if (
        isBlankSlateRoot(row.projectRoot) &&
        !supportsBlankSlate(spec.slug) &&
        spec.command.length
      )
        throw new HttpError(400, 'blank_slate_unsupported')
      await whenReady()
      await answerReplacement(
        res,
        row.id,
        await loadTui(row.id, spec, { expectedGeneration: generation, generationOf }),
      )
    })
    .add('POST', '/v1/sessions/:id/switch-project', async (req, res, params) => {
      const body = await readJsonObject(req)
      onlyFields(body, ['generation', 'projectId', 'projectRoot'])
      const generation = requireGeneration(body)
      // Exactly one of projectId (resolved once) or projectRoot (an absolute
      // directory with no project, as on create).
      const byId = body.projectId !== undefined && body.projectId !== null
      const byRoot = body.projectRoot !== undefined && body.projectRoot !== null
      if (byId === byRoot)
        throw new HttpError(400, 'invalid_body', { detail: 'send projectId or projectRoot' })
      if (byId && (typeof body.projectId !== 'string' || !body.projectId))
        throw new HttpError(400, 'invalid_body', { field: 'projectId' })
      // The path rule is body shape, checked up front; existence waits until
      // the session and generation check out, as with projectId.
      if (byRoot && !isProjectRootPath(body.projectRoot))
        throw new HttpError(400, 'invalid_body', { field: 'projectRoot' })
      const row = requireSession(params.id)
      fence(row, generation)
      const projectId = byId ? (body.projectId as string) : null
      const projectRoot = projectId
        ? await resolveProject(context, projectId)
        : requireProjectRoot(body.projectRoot)
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
}

/** Diagnostics, agent-state hooks and the context-hook check. */
function registerSessionStateRoutes(router: Router, context: LifecycleApiContext): void {
  router
    .add('GET', '/v1/sessions/:id/diagnostics', async (_req, res, params) => {
      const row = requireSession(params.id)
      sendJson(res, 200, { ...(await sessionDiagnostics(row.id)), agent: agentStateOf(row.id) })
    })
    // Agent hooks inside the pane (Claude Code Notification/UserPromptSubmit)
    // report state changes here; see docs/agent-state.md.
    .add('POST', '/v1/sessions/:id/agent-event', async (req, res, params) => {
      const row = requireSession(params.id)
      const report = parseHookReport(await readJsonObject(req))
      const applied = reportAgentState(row.id, report)
      sendJson(res, 200, { applied, ...agentStateOf(row.id) })
    })
    .add('POST', '/v1/sessions/:id/context-check', async (_req, res, params) => {
      const row = requireSession(params.id)
      const spec = sessionSpec(getTui(row.tool), row.projectRoot, row.id)
      if (spec) await probeContext(row.id, spec)
      const latest = requireSession(row.id)
      sendJson(res, 200, { generation: generationOf(latest), contextHook: contextHookOf(latest) })
    })
}

/** Read a session's terminal: pane mode, attach recipe, capture, scrollback, sign-in link. */
function registerTerminalReadRoutes(router: Router, context: LifecycleApiContext): void {
  router
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
    // The agent's last message and context fill, for a coordinator reading a lane. An ended
    // session's transcript stays readable, so its report does too.
    .add('GET', '/v1/sessions/:id/comes-back', (_req, res, params) => {
      const id = params.id ?? ''
      if (!/^[0-9a-f]{8}$/.test(id)) throw new HttpError(404, 'not_found')
      sendJson(res, 200, {
        comesBack: Boolean(context.wakes?.store.keptFor(id) || context.waits?.store.keptFor(id)),
      })
    })
    .add('GET', '/v1/sessions/:id/report', (_req, res, params) => {
      const id = params.id ?? ''
      if (!/^[0-9a-f]{8}$/.test(id)) throw new HttpError(404, 'not_found')
      const tool = getWidget(id)?.tool
      const closing = context.history?.closingMessage(id, tool, REPORT_TEXT_MAX) ?? null
      const { tokens, model } = context.history?.contextOf(id, tool) ?? {
        tokens: null,
        model: null,
      }
      const window = model ? (MODEL_CATALOG.get(model)?.context_window ?? null) : null
      sendJson(res, 200, {
        id,
        text: closing?.text ?? null,
        at: closing?.at ?? null,
        contextTokens: tokens,
        contextWindow: window,
        contextPercent: tokens !== null && window ? Math.round((tokens / window) * 100) : null,
        model,
      })
    })
    // The sign-in link on a `Sign in: <tool>` session's screen, joined into one
    // URL; `url` is null until the tool has printed it. 404 for any other session.
    .add('GET', '/v1/sessions/:id/sign-in-link', async (_req, res, params) => {
      const row = requireSession(params.id)
      const tool = signInToolOf(row.name)
      const link = tool ? adapterOf(tool)?.login.signInLink : undefined
      if (!tool || !link) throw new HttpError(404, 'no_sign_in_link')
      if (isNeverAllocatedWidget(row)) throw new HttpError(409, 'workload_unavailable')
      let text: string
      try {
        text = await runTmux(captureVisibleTargetArgs(tmuxPaneTargetForWidget(row.id), false))
      } catch {
        throw new HttpError(409, 'workload_unavailable')
      }
      sendJson(res, 200, { tool, url: extractSignInLink(text, link.host) })
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
}

/** Write to a session's terminal: inject, rewind, and the viewer size claim. */
function registerTerminalInputRoutes(router: Router, context: LifecycleApiContext): void {
  const { events } = context
  router
    .add('POST', '/v1/sessions/:id/inject', async (req, res, params) => {
      const body = await readJsonObject(req)
      onlyFields(body, ['generation', 'text', 'mode', 'submit', 'model', 'thinkingLevel', 'from'])
      const generation = requireGeneration(body)
      // The sending session (`st aico root send`): a wait it sets on this one
      // counts turns from here.
      const from = body.from
      if (from !== undefined && (typeof from !== 'string' || !/^[0-9a-f]{8}$/.test(from)))
        throw new HttpError(400, 'invalid_body', { field: 'from' })
      const sentAt = Date.now()
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
      if (body.model !== undefined) throw new HttpError(400, 'invalid_body', { field: 'model' })
      if (body.thinkingLevel !== undefined)
        throw new HttpError(400, 'invalid_body', { field: 'thinkingLevel' })
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
      if (from && from !== row.id && submit) context.waits?.store.recordSend(from, row.id, sentAt)
      if (submit && from !== row.id) context.lanes?.reached(row.id, 'a send reached it')
      sendJson(res, 200, { generation, delivered: true })
    })
    // Rewind a Claude Code session to before the prompt its standing model
    // switch names (docs/api-v1.md "Model switches"), through its rewind menu.
    .add('POST', '/v1/sessions/:id/rewind', async (req, res, params) => {
      const body = await readJsonObject(req)
      onlyFields(body, ['generation'])
      const generation = requireGeneration(body)
      const row = requireSession(params.id)
      fence(row, generation)
      if (!adapterOf(row.tool)?.capabilities.rewind)
        throw new HttpError(409, 'rewind_unsupported', { tool: row.tool })
      const change = sessionModelSwitch(row.id)
      if (!change?.rewindTo) throw new HttpError(409, 'no_rewind_target')
      if (agentStateOf(row.id).state === 'working') throw new HttpError(409, 'agent_busy')
      if (modelWatch?.rewoundOf(row.id) === change.key) throw new HttpError(409, 'already_rewound')
      const target = modelWatch?.promptOf(row.id) ?? null
      if (target?.key !== change.key) throw new HttpError(409, 'rewind_target_unreadable')
      let refused: RewindRefused | null = null
      const done = await withRunningSession(row.id, generation, async (current) => {
        const pane = tmuxPaneTargetForWidget(current.id)
        try {
          return await rewindClaude(
            {
              capture: () => runTmux(captureVisibleTargetArgs(pane, false)),
              press: async (key) => {
                await runTmux(sendKeyTargetArgs(pane, key))
              },
              sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            },
            target.text,
            target.after,
          )
        } catch (error) {
          if (error instanceof RewindRefused) {
            refused = error
            return null
          }
          throw error
        }
      })
      if (refused) {
        const { step, reason } = refused as RewindRefused
        throw new HttpError(409, 'rewind_refused', { step, reason })
      }
      if (!done) throw new HttpError(409, 'workload_unavailable')
      modelWatch?.markRewound(row.id, change.key)
      console.log(
        `[tether:models] session=${row.id} rewound ${done.up} prompt(s) back${done.cleared ? '' : ', its text left in the input'}`,
      )
      sendJson(res, 200, { generation, rewound: true, up: done.up, cleared: done.cleared })
    })
    // Aico has no desktop windows: a show request gets a plain refusal.
    .add('POST', '/v1/sessions/:id/show', () => {
      throw new HttpError(410, 'windows_retired')
    })
    .add('POST', '/v1/sessions/:id/resize-claim', async (req, res, params) => {
      const body = await readJsonObject(req)
      onlyFields(body, ['generation', 'clientPid', 'cols', 'rows', 'viewer'])
      const generation = requireGeneration(body)
      const viewer = parseViewerLabel(body.viewer)
      if (viewer === null) throw new HttpError(400, 'invalid_viewer')
      const row = requireSession(params.id)
      fence(row, generation)
      const isCurrent = () => {
        const latest = getWidget(row.id)
        return Boolean(latest && generationOf(latest) === generation)
      }
      let result: ResizeClaimResult | { applied: false; reason: 'tmux_unavailable' }
      try {
        result = await claimTmuxViewSize(
          tmuxTargetForWidget(row.id),
          body.clientPid as number,
          body.cols as number,
          body.rows as number,
          (args) => runTmux(args),
          isCurrent,
        )
      } catch {
        result = { applied: false, reason: 'tmux_unavailable' }
      }
      if (result.applied) {
        // Aico claims the size when a view gains focus: that pane is foreground.
        void foregroundMemory().focus(getWidget(row.id)?.scopeUnit ?? null)
        const holder = recordSizeHolder(row.id, {
          clientPid: body.clientPid as number,
          cols: body.cols as number,
          rows: body.rows as number,
          generation,
          viewer,
        })
        events.publish('session.resized', {
          id: row.id,
          generation,
          clientPid: holder.clientPid,
          cols: holder.cols,
          rows: holder.rows,
          changed: result.changed,
          viewer: holder.viewer,
        })
        sendJson(res, 200, { applied: true, changed: result.changed })
      } else {
        sendJson(res, 200, { applied: false, reason: result.reason })
      }
    })
    .add('GET', '/v1/sessions/:id/resize-claim', async (_req, res, params) => {
      const row = requireSession(params.id)
      const generation = generationOf(row)
      sendJson(res, 200, { generation, holder: sizeHolderOf(row.id, generation) })
    })
}

/** Roots and the compact widget routes share Aico's one handler. */
function registerRootRoutes(router: Router, context: LifecycleApiContext): void {
  const rootHandler = createRootHandler(rootOperations(context), undefined, context.rootState)
  const root = (req: IncomingMessage, res: ServerResponse) => rootHandler(req, res)
  router
    .add('GET', '/v1/roots', root)
    .add('POST', '/v1/roots', root)
    .add('GET', '/v1/roots/:requestId', root)
    .add('POST', '/v1/roots/:requestId/:action', root)
    .add('GET', '/v1/roots/:requestId/:action', root)
    .add('GET', '/v1/widgets/:id', root)
    .add('POST', '/v1/widgets/:id/:action', root)
}

export function registerLifecycleRoutes(router: Router, context: LifecycleApiContext): void {
  if (context.continuity) registerRebootRoutes(router, context.continuity)
  if (context.recovery) registerRecoveryRoutes(router, context.recovery)
  if (context.wakes) registerWakeRoutes(router, context.wakes)
  registerLaneRoutes(
    router,
    () => context.lanes ?? null,
    (id) => getWidget(id) !== undefined,
  )
  registerWaitRoutes(
    router,
    () => context.waits ?? null,
    (id) => getWidget(id) !== undefined,
  )
  registerPlacementRoutes(router, context)
  registerSessionCatalogRoutes(router, context)
  registerSessionLifecycleRoutes(router, context)
  registerSessionStateRoutes(router, context)
  registerTerminalReadRoutes(router, context)
  registerTerminalInputRoutes(router, context)
  registerRootRoutes(router, context)
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
