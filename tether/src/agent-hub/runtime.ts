// The Agent Hub session kind. A session of this kind has no pane: Tether holds
// its Agent Hub session id and drives it through the shared TypeScript SDK.
//
//   create  the Agent Hub session is created under an id Tether picked and
//           stored first (creation is idempotent), then the first prompt is
//           posted as a turn;
//   send    a follow-up is a turn; while a turn is running it waits in a
//           durable queue and goes out when the session is idle;
//   state   Agent Hub's turn state: running is `working`, idle is `idle`,
//           anything else (unreachable, closed, gone) is `unknown`;
//   end     cancel a running turn, close the Agent Hub session, drop the row;
//   restart Tether polls every Agent Hub row by its stored id, so nothing is
//           lost across a restart.
//
// Nothing here touches tmux. `AgentHubRuntime` only needs the structural
// `HubApi`, which the SDK client satisfies and a test can fake.

import type {
  AgentsApi,
  IdleEvent,
  ModelsApi,
  SessionsApi,
  TurnEvent,
  TurnsApi,
  WorkflowRunsApi,
} from '@agent-hub/sdk'
import type { AgentStateRecord, AgentStateTracker } from '../agent-state'
import {
  type AgentHubSessionRow,
  agentHubQueueLength,
  enqueueAgentHubText,
  getAgentHubSession,
  getWidget,
  listAgentHubQueue,
  listAgentHubSessions,
  markAgentHubCreated,
  markAgentHubPromptSent,
  peekAgentHubQueue,
  removeAgentHubQueued,
  removeWidgetIfOwnership,
  rootRequestForWidget,
  type WidgetRow,
} from '../lifecycle/catalog'
import type { EndResult, SessionStatus } from '../lifecycle/engine'
import { ownershipGeneration, sessionGeneration } from '../lifecycle/owner-retirement'

/** The slice of the SDK client Tether uses. */
export interface HubApi {
  sessions: Pick<SessionsApi, 'create' | 'get' | 'close'>
  turns: Pick<TurnsApi, 'stream' | 'cancel' | 'attach'>
  agents: Pick<AgentsApi, 'list'>
  models: Pick<ModelsApi, 'list'>
  /** Workflow runs (runs.ts follows the ones this machine's sessions launch). */
  workflowRuns: Pick<WorkflowRunsApi, 'list' | 'get' | 'resume' | 'cancel' | 'cancelStep'>
}

export type HubErrorCode =
  | 'agent_hub_unavailable'
  | 'agent_hub_refused'
  | 'unknown_agent'
  | 'unknown_model'
  | 'turn_running'
  | 'not_started'

/** A failure the API maps to a status; the message never carries a prompt. */
export class HubError extends Error {
  constructor(
    readonly code: HubErrorCode,
    message: string,
  ) {
    super(message)
  }
}

interface SdkErrorShape {
  name?: string
  status?: number
  code?: string
  message?: string
}

/** Sort an SDK failure into what Tether does about it. */
export function classifyHubError(error: unknown): HubError {
  if (error instanceof HubError) return error
  const e = (error ?? {}) as SdkErrorShape
  const status = typeof e.status === 'number' ? e.status : 0
  if (status === 409 && e.code === 'turn_running')
    return new HubError('turn_running', 'a turn is already running')
  if (status === 0 || status >= 500 || status === 429)
    return new HubError('agent_hub_unavailable', e.message ?? 'Agent Hub is not reachable')
  return new HubError('agent_hub_refused', e.message ?? `Agent Hub refused the request (${status})`)
}

/** What the last look at the Agent Hub session found. */
interface Observation {
  at: number
  reachable: boolean
  /** The session is gone from Agent Hub (404). */
  missing: boolean
  hubStatus: string | null
  turnState: 'running' | 'idle' | null
  turnPhase: string | null
  model: string | null
}

const LIVE_STATUS = 'active'
const CONNECT_TIMEOUT_MS = 30_000
const SOURCE_METADATA = { transport: 'tether', surface: 'aico', source_client: 'aico-tether' }

export interface AgentHubRuntimeOptions {
  api: () => HubApi
  /** Per-session agent state, kept apart from the tmux tracker (whose poller
   * forgets every id it does not see in a pane). */
  states: AgentStateTracker
  /** A session's descriptor changed (status, queue). */
  notify: (id: string) => void
  /** Re-verify through the engine so its status cache and events follow. */
  verifyStatus: (row: WidgetRow) => Promise<SessionStatus>
  now?: () => number
  pollMs?: number
  log?: (message: string) => void
}

export interface HubDescription {
  sessionId: string
  agentSlug: string
  /** The catalog model the root asked for, if it overrode the agent's own. */
  requestedModel: string | null
  /** The model Agent Hub reports for the session. */
  model: string | null
  turnState: 'running' | 'idle' | null
  turnPhase: string | null
  queued: number
  reachable: boolean | null
  created: boolean
  promptSent: boolean
}

export class AgentHubRuntime {
  private readonly observations = new Map<string, Observation>()
  private readonly lastStatus = new Map<string, SessionStatus>()
  private readonly chains = new Map<string, Promise<unknown>>()
  private readonly now: () => number
  private readonly pollMs: number
  private readonly log: (message: string) => void
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false
  private stopped = false
  private readonly inflight = new Set<AbortController>()

  constructor(private readonly options: AgentHubRuntimeOptions) {
    this.now = options.now ?? Date.now
    this.pollMs = options.pollMs ?? 2_000
    this.log = options.log ?? ((message) => console.log(`[tether:agent-hub] ${message}`))
  }

  // --- lifecycle ----------------------------------------------------------------

  start(): void {
    if (this.timer) return
    this.stopped = false
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.pollMs)
    this.timer.unref()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const controller of this.inflight) controller.abort()
    this.inflight.clear()
  }

  // --- create -------------------------------------------------------------------

  /** Refuse a root before it is reserved: the agent must exist, be routable
   * (with the requested model, if any), and Agent Hub must answer. */
  async check(agentSlug: string, model: string | null): Promise<void> {
    await this.resolve(agentSlug, model)
  }

  private async resolve(
    agentSlug: string,
    model: string | null,
  ): Promise<{ provider: string; model: string }> {
    const api = this.options.api()
    let agents: Awaited<ReturnType<HubApi['agents']['list']>>
    let models: Awaited<ReturnType<HubApi['models']['list']>>
    try {
      ;[agents, models] = await Promise.all([api.agents.list({ limit: 500 }), api.models.list()])
    } catch (error) {
      throw classifyHubError(error)
    }
    const agent = agents.find((candidate) => candidate.slug === agentSlug)
    if (!agent) throw new HubError('unknown_agent', `Agent Hub has no active agent ${agentSlug}`)
    const wanted = model ?? agent.primary_model_id
    const info = models.find((candidate) => candidate.id === wanted)
    if (!info?.routable) throw new HubError('unknown_model', `Agent Hub cannot route ${wanted}`)
    return { provider: info.provider, model: info.id }
  }

  /**
   * Make the root's Agent Hub session exist and hold its first prompt. Safe to
   * repeat: creation is idempotent under Tether's session id, and a prompt
   * already posted (the session has messages or a running turn) is not posted
   * twice. Never throws; the caller reads the descriptor for the outcome.
   */
  ensure(widgetId: string, prompt: string): Promise<void> {
    return this.serial(widgetId, async () => {
      const row = getWidget(widgetId)
      const hub = getAgentHubSession(widgetId)
      if (!row || !hub || row.backend !== 'agent-hub' || !row.projectId || !row.projectRoot) return
      try {
        const api = this.options.api()
        if (!hub.created) {
          const target = await this.resolve(hub.agentSlug, hub.model)
          const request = rootRequestForWidget(widgetId)
          await api.sessions.create({
            session_id: hub.hubSessionId,
            project_id: row.projectId,
            provider: target.provider,
            model: target.model,
            session_type: 'agent',
            agent_slug: hub.agentSlug,
            external_id: row.sessionId,
            cwd: row.projectRoot,
            ...(request?.workRole
              ? {
                  work_role: {
                    id: request.workRole,
                    source: `aico-tether:${request.requestId}`,
                    ...(request.workRoleDisplayName
                      ? { display_name: request.workRoleDisplayName }
                      : {}),
                  },
                }
              : {}),
          })
          markAgentHubCreated(widgetId)
        }
        if (!hub.promptSent) {
          const existing = await api.sessions.get(hub.hubSessionId, { includeMessages: false })
          if ((existing.message_count ?? 0) > 0 || existing.turn_state === 'running') {
            markAgentHubPromptSent(widgetId)
          } else {
            await this.startTurn(row, hub, prompt)
            markAgentHubPromptSent(widgetId)
          }
        }
        await this.observe(row, getAgentHubSession(widgetId) ?? hub)
      } catch (error) {
        const failure = classifyHubError(error)
        this.log(`create ${widgetId} not finished: ${failure.code}`)
      }
      this.options.notify(widgetId)
    })
  }

  // --- turns --------------------------------------------------------------------

  /** Post one user message as a turn and return once Agent Hub has accepted it
   * (its `connected` event). The turn runs on the server and does not need
   * this connection, so it is closed straight away. */
  private async startTurn(row: WidgetRow, hub: AgentHubSessionRow, text: string): Promise<void> {
    const controller = new AbortController()
    this.inflight.add(controller)
    const timeout = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS)
    const events = this.options.api().turns.stream(
      {
        messages: [{ role: 'user', content: text }],
        project_id: row.projectId ?? '',
        agent_slug: hub.agentSlug,
        ...(hub.model ? { model: hub.model } : {}),
        session_id: hub.hubSessionId,
        external_id: row.sessionId,
        working_dir: row.projectRoot,
        execute_tools: true,
        source_metadata: SOURCE_METADATA,
      },
      { signal: controller.signal, reattach: false },
    )
    try {
      const first = await events.next()
      if (first.done) throw new HubError('agent_hub_refused', 'Agent Hub ended the turn at once')
      if (first.value.type === 'error') {
        const message = (first.value as { error?: string }).error
        throw new HubError('agent_hub_refused', message ?? 'Agent Hub refused the turn')
      }
    } catch (error) {
      throw classifyHubError(error)
    } finally {
      clearTimeout(timeout)
      this.inflight.delete(controller)
      controller.abort()
      await events.return(undefined).catch(() => undefined)
    }
    this.options.states.observe(row.id, {
      state: 'working',
      source: 'agent-hub',
      detail: null,
      at: null,
      agentSessionId: null,
    })
  }

  /**
   * Deliver a follow-up: now when the session is idle, else queued until it
   * is. Refuses while the session is not started or Agent Hub is unreachable.
   */
  send(widgetId: string, text: string): Promise<{ queued: boolean }> {
    return this.serial(widgetId, async () => {
      const row = getWidget(widgetId)
      const hub = getAgentHubSession(widgetId)
      if (!row || !hub || row.backend !== 'agent-hub') throw new HubError('not_started', 'gone')
      if (!hub.created || !hub.promptSent)
        throw new HubError('not_started', 'the first prompt has not been posted')
      const observed = await this.observe(row, hub)
      if (!observed.reachable)
        throw new HubError('agent_hub_unavailable', 'Agent Hub is not reachable')
      if (observed.missing || observed.hubStatus !== LIVE_STATUS)
        throw new HubError('not_started', 'the Agent Hub session is closed')
      if (observed.turnState === 'running' || agentHubQueueLength(widgetId) > 0) {
        enqueueAgentHubText(widgetId, text, this.now())
        this.options.notify(widgetId)
        return { queued: true }
      }
      try {
        await this.startTurn(row, hub, text)
      } catch (error) {
        const failure = classifyHubError(error)
        if (failure.code !== 'turn_running') throw failure
        enqueueAgentHubText(widgetId, text, this.now())
        this.options.notify(widgetId)
        return { queued: true }
      }
      return { queued: false }
    })
  }

  // --- chat view ----------------------------------------------------------------

  /** The Agent Hub session id of a started chat; refuses one not created yet. */
  private startedHubId(widgetId: string): string {
    const hub = getAgentHubSession(widgetId)
    if (!getWidget(widgetId) || !hub) throw new HubError('not_started', 'gone')
    if (!hub.created) throw new HubError('not_started', 'the Agent Hub session is not created yet')
    return hub.hubSessionId
  }

  /** The chat as Agent Hub holds it (messages unless `includeMessages` is
   * false) and the follow-ups waiting in Tether's queue, oldest first. */
  async chat(
    widgetId: string,
    includeMessages: boolean,
  ): Promise<{ session: Awaited<ReturnType<SessionsApi['get']>>; queued: string[] }> {
    const hubId = this.startedHubId(widgetId)
    try {
      const session = await this.options.api().sessions.get(hubId, { includeMessages })
      return { session, queued: listAgentHubQueue(widgetId) }
    } catch (error) {
      throw classifyHubError(error)
    }
  }

  /** Follow the session's turn from `afterSeq` (the SDK reconnects itself).
   * Aborting `signal` closes the connection; the turn keeps running. */
  attach(
    widgetId: string,
    afterSeq: number,
    signal: AbortSignal,
  ): AsyncGenerator<TurnEvent | IdleEvent, void, undefined> {
    return this.options.api().turns.attach(this.startedHubId(widgetId), { afterSeq, signal })
  }

  /** Ask Agent Hub to stop the running turn. False when none was running. */
  async cancelTurn(widgetId: string): Promise<boolean> {
    const hubId = this.startedHubId(widgetId)
    try {
      return (await this.options.api().turns.cancel(hubId)).cancelled === true
    } catch (error) {
      const status = (error as SdkErrorShape).status
      if (status === 404 || status === 409) return false
      throw classifyHubError(error)
    }
  }

  /** The model catalog, for the chat's model picker. */
  async models(): Promise<Awaited<ReturnType<ModelsApi['list']>>> {
    try {
      return await this.options.api().models.list()
    } catch (error) {
      throw classifyHubError(error)
    }
  }

  // --- state --------------------------------------------------------------------

  /** Look at the Agent Hub session and update the session's agent state. */
  private async observe(row: WidgetRow, hub: AgentHubSessionRow): Promise<Observation> {
    let observation: Observation
    try {
      const info = await this.options
        .api()
        .sessions.get(hub.hubSessionId, { includeMessages: false })
      observation = {
        at: this.now(),
        reachable: true,
        missing: false,
        hubStatus: info.status ?? null,
        turnState: info.turn_state ?? null,
        turnPhase: info.turn_phase ?? null,
        model: info.effective_model ?? info.model ?? null,
      }
    } catch (error) {
      const failure = error as SdkErrorShape
      const missing = failure.status === 404
      observation = {
        at: this.now(),
        reachable: missing,
        missing,
        hubStatus: null,
        turnState: null,
        turnPhase: null,
        model: null,
      }
    }
    this.observations.set(row.id, observation)
    const live =
      observation.reachable && !observation.missing && observation.hubStatus === LIVE_STATUS
    this.options.states.observe(
      row.id,
      live && observation.turnState
        ? {
            state: observation.turnState === 'running' ? 'working' : 'idle',
            source: 'agent-hub',
            detail: observation.turnState === 'running' ? observation.turnPhase : null,
            at: null,
            agentSessionId: null,
          }
        : null,
    )
    return observation
  }

  private statusOf(
    hub: AgentHubSessionRow | undefined,
    observation: Observation | undefined,
  ): SessionStatus {
    if (!hub?.created) return 'pending'
    if (!observation) return 'uncertain'
    return observation.reachable && !observation.missing && observation.hubStatus === LIVE_STATUS
      ? 'running'
      : 'uncertain'
  }

  /** The engine's status check for a session of this kind. */
  async verify(row: WidgetRow): Promise<SessionStatus> {
    const hub = getAgentHubSession(row.id)
    if (!hub?.created) return 'pending'
    let observation = this.observations.get(row.id)
    if (!observation || this.now() - observation.at > this.pollMs * 2)
      observation = await this.observe(row, hub)
    const status = this.statusOf(hub, observation)
    this.lastStatus.set(row.id, status)
    return status
  }

  /** The session's agent state, or null for an id this runtime has not observed. */
  stateOf(id: string): AgentStateRecord | null {
    return this.options.states.ids().includes(id) ? this.options.states.get(id) : null
  }

  describe(id: string): HubDescription | null {
    const hub = getAgentHubSession(id)
    if (!hub) return null
    const observation = this.observations.get(id)
    return {
      sessionId: hub.hubSessionId,
      agentSlug: hub.agentSlug,
      requestedModel: hub.model,
      model: observation?.model ?? null,
      turnState: observation?.turnState ?? null,
      turnPhase: observation?.turnPhase ?? null,
      queued: agentHubQueueLength(id),
      reachable: observation ? observation.reachable : null,
      created: hub.created,
      promptSent: hub.promptSent,
    }
  }

  // --- polling and the follow-up queue -----------------------------------------

  async tick(): Promise<void> {
    if (this.ticking || this.stopped) return
    this.ticking = true
    try {
      for (const row of listAgentHubSessions()) {
        if (this.stopped) return
        const hub = getAgentHubSession(row.id)
        if (!hub?.created) continue
        const observation = await this.observe(row, hub)
        const status = this.statusOf(hub, observation)
        if (this.lastStatus.get(row.id) !== status) {
          this.lastStatus.set(row.id, status)
          await this.options.verifyStatus(row).catch(() => undefined)
          this.options.notify(row.id)
        }
        if (hub.promptSent && observation.turnState === 'idle') await this.pump(row.id)
      }
      for (const id of [...this.observations.keys()]) if (!getAgentHubSession(id)) this.forget(id)
    } catch (error) {
      this.log(`poll failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.ticking = false
    }
  }

  /** Send the oldest queued follow-up now that the session is idle. */
  private pump(widgetId: string): Promise<void> {
    return this.serial(widgetId, async () => {
      const row = getWidget(widgetId)
      const hub = getAgentHubSession(widgetId)
      const next = peekAgentHubQueue(widgetId)
      if (!row || !hub || !next) return
      try {
        await this.startTurn(row, hub, next.text)
      } catch (error) {
        const failure = classifyHubError(error)
        if (failure.code === 'agent_hub_refused') {
          // It can never succeed; do not retry it every poll.
          removeAgentHubQueued(next.id)
          this.log(`queued follow-up for ${widgetId} dropped: ${failure.message}`)
          this.options.notify(widgetId)
        }
        return
      }
      removeAgentHubQueued(next.id)
      this.options.notify(widgetId)
    })
  }

  // --- end ----------------------------------------------------------------------

  /** End: cancel a running turn, close the Agent Hub session, drop the row. */
  end(widgetId: string, generation: string | undefined): Promise<EndResult> {
    return this.serial(widgetId, async (): Promise<EndResult> => {
      const row = getWidget(widgetId)
      if (!row) return { status: 'absent' }
      if (generation && sessionGeneration(row) !== generation) return { status: 'stale' }
      const hub = getAgentHubSession(widgetId)
      if (hub?.created) {
        const api = this.options.api()
        try {
          const info = await api.sessions
            .get(hub.hubSessionId, { includeMessages: false })
            .catch((error: SdkErrorShape) => {
              if (error.status === 404) return null
              throw error
            })
          if (info?.turn_state === 'running')
            await api.turns.cancel(hub.hubSessionId).catch((error: SdkErrorShape) => {
              // A turn that ended meanwhile, or a session already gone, is fine.
              if (error.status !== 404 && error.status !== 409) throw error
            })
          if (info)
            await api.sessions.close(hub.hubSessionId).catch((error: SdkErrorShape) => {
              if (error.status !== 404) throw error
            })
        } catch (error) {
          const failure = classifyHubError(error)
          return {
            status: 'blocked',
            reason: `Agent Hub did not close the session: ${failure.message}`,
          }
        }
      }
      const latest = getWidget(widgetId)
      if (!latest) return { status: 'ended' }
      if (sessionGeneration(latest) !== sessionGeneration(row)) return { status: 'stale' }
      if (!removeWidgetIfOwnership(widgetId, ownershipGeneration(row))) return { status: 'stale' }
      this.forget(widgetId)
      return { status: 'ended' }
    })
  }

  private forget(id: string): void {
    this.observations.delete(id)
    this.lastStatus.delete(id)
    this.options.states.forget(id)
  }

  // --- internals ----------------------------------------------------------------

  /** One operation at a time per session. */
  private serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const prior = this.chains.get(id) ?? Promise.resolve()
    const next = prior.catch(() => undefined).then(work)
    this.chains.set(id, next)
    const clear = () => {
      if (this.chains.get(id) === next) this.chains.delete(id)
    }
    next.then(clear, clear)
    return next
  }
}
