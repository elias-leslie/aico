// Session wakes against the running daemon: the scheduler's live operations
// (agent state, the visible input line, tmux clients, the paste, the desktop,
// a kept wake's relaunch), the End hook that keeps wakes, and the HTTP routes
// (docs/api-v1.md "Wakes"). The scheduling rules live in wakes.ts.

import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { type ContinuitySnapshot, nodeProcFs, observeAgent, readJsonFile } from './continuity'
import { HttpError, type Router, readJsonObject, sendJson } from './http'
import { AgentAdmissionDenied } from './lifecycle/agent-admission'
import {
  allocateWidgetId,
  getWidget,
  insertWidget,
  joinCoordinator,
  listLanes,
  recordLauncher,
  type SessionOrigin,
  setCoordinator,
  setWidgetName,
  setWidgetProject,
  type WidgetRow,
} from './lifecycle/catalog'
import {
  discardNeverAllocated,
  ensureSessionSerialized,
  isDir,
  lastEnsureFailure,
  lingerEnabled,
  notifySessionChanged,
  tmuxPaneTargetForWidget,
  tmuxTargetForWidget,
  verifiedCurrentManagedPane,
  verifySessionStatus,
  whenReady,
} from './lifecycle/engine'
import { withRootPrompt } from './lifecycle/root-launch'
import { terminalClientEnv } from './lifecycle/terminal-env'
import { captureVisibleTargetArgs, clientActivityTargetArgs } from './lifecycle/tmux'
import { ensureBlankSlateWorkspace, isBlankSlateRoot } from './lifecycle/tui/blank-slate'
import { isResumeSessionId } from './lifecycle/tui/launch'
import { getTui } from './lifecycle/tui/registry'
import {
  agentStateOf,
  generationOf,
  type LifecycleApiContext,
  pasteIntoRunningSession,
} from './lifecycle-api'
import {
  applyWakePolicyPatch,
  cleanNote,
  type EndedSession,
  inputLineEmpty,
  parseStoredWakePolicy,
  type Wake,
  type WakeOperations,
  type WakePolicy,
  WakePolicyError,
  WakeScheduler,
  WakeStore,
  wakeJson,
} from './wakes'

const execFileAsync = promisify(execFile)
const TMUX_BIN = '/usr/bin/tmux'
const TMUX_TIMEOUT_MS = 2_000
const POLICY_KEY = 'wake_policy'
/** The furthest ahead a wake may be set. */
const MAX_AHEAD_MS = 366 * 24 * 3600_000
/** A time this far in the past is a mistake, not "now". */
const MAX_BEHIND_MS = 5 * 60_000
const WAKE_ID = /^[0-9a-f]{12}$/

async function runTmux(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(TMUX_BIN, args, {
    encoding: 'utf8',
    env: terminalClientEnv(),
    timeout: TMUX_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  })
  return stdout
}

function isAgent(tool: string): boolean {
  return (getTui(tool)?.command.length ?? 0) > 0
}

/** The session's wakes for its descriptor (`wakes`), oldest first. */
let bound: WakeStore | null = null

export function bindWakeStore(store: WakeStore | null): void {
  bound = store
}

export function sessionWakes(sessionId: string): Record<string, unknown>[] {
  return (bound?.forSession(sessionId) ?? []).map((wake) => ({
    id: wake.id,
    dueAt: wake.dueAt,
    note: wake.note,
    createdBy: wake.createdBy,
  }))
}

export class WakeService {
  readonly store: WakeStore
  readonly scheduler: WakeScheduler
  private readonly home: string
  private readonly now: () => number

  constructor(
    private readonly context: LifecycleApiContext,
    options: { home?: string; now?: () => number; operations?: Partial<WakeOperations> } = {},
  ) {
    this.store = new WakeStore(context.store.db)
    this.home = options.home ?? process.env.HOME ?? homedir()
    const now = options.now ?? Date.now
    this.now = now
    this.scheduler = new WakeScheduler(this.store, {
      now,
      policy: () => this.policy(),
      idle: (id) => this.idle(id),
      inputEmpty: (id) => this.inputEmpty(id),
      lastKeyAt: (id) => this.lastKeyAt(id),
      deliver: (id, text) => pasteIntoRunningSession(id, text),
      reopen: (id) => this.reopen(id),
      conversationHolder: (resumeId) => this.conversationHolder(resumeId),
      relaunch: (ended, message) => this.relaunch(ended, message),
      changed: (id) => this.changed(id),
      log: (message) => console.log(`[tether:wakes] ${message}`),
      ...options.operations,
    })
  }

  policy(): WakePolicy {
    return parseStoredWakePolicy(this.context.store.getSetting(POLICY_KEY))
  }

  setPolicy(patch: Record<string, unknown>, now: number): WakePolicy {
    const next = applyWakePolicyPatch(this.policy(), patch)
    this.context.store.putSetting(POLICY_KEY, JSON.stringify(next), now)
    return next
  }

  changed(sessionId: string | null): void {
    if (sessionId && getWidget(sessionId)) notifySessionChanged(sessionId, { force: true })
    this.context.events.publish('wakes.changed', { sessionId })
    this.scheduler.nudge()
  }

  /** Whether wakes can be delivered to this session: an agent whose state
   * Tether reads (a shell or Pi reports none, so idle would never come). */
  supports(row: WidgetRow): boolean {
    return isAgent(row.tool) && agentStateOf(row.id).state !== 'unknown'
  }

  private async idle(sessionId: string): Promise<boolean> {
    const row = getWidget(sessionId)
    if (!row || !isAgent(row.tool)) return false
    if (agentStateOf(sessionId).state !== 'idle') return false
    return (await verifySessionStatus(row).catch(() => 'uncertain')) === 'running'
  }

  private async inputEmpty(sessionId: string): Promise<boolean> {
    try {
      return inputLineEmpty(
        await runTmux(captureVisibleTargetArgs(tmuxPaneTargetForWidget(sessionId), true)),
      )
    } catch {
      return false
    }
  }

  private async lastKeyAt(sessionId: string): Promise<number | null> {
    let stdout: string
    try {
      stdout = await runTmux(clientActivityTargetArgs(tmuxTargetForWidget(sessionId)))
    } catch {
      // No clients is not an error to tmux; a failure means unknown, so wait.
      return this.now()
    }
    const times = stdout
      .split('\n')
      .map((line) => Number(line.trim()))
      .filter((n) => Number.isSafeInteger(n) && n > 0)
    return times.length ? Math.max(...times) * 1000 : null
  }

  /** Reopen the session's window if the desktop has shown it. Best effort:
   * the desktop decides, and answers `no_view` for a session it never showed. */
  private reopen(sessionId: string): void {
    const row = getWidget(sessionId)
    if (!row || !this.context.gui.connected()) return
    void this.context.gui
      .send({ kind: 'show', sessionId, generation: generationOf(row), ifViewed: true })
      .catch(() => {})
  }

  private async conversationHolder(resumeId: string): Promise<string | null> {
    const continuity = this.context.continuity
    if (!continuity) return null
    const observed = await continuity.observe().catch(() => [])
    return observed.find((entry) => entry.resumeId === resumeId)?.row.id ?? null
  }

  /** What a kept wake needs to start this session's conversation again. */
  async endedSnapshot(row: WidgetRow): Promise<EndedSession> {
    let resumeId: string | null = null
    const tool = getTui(row.tool)
    const pane = await verifiedCurrentManagedPane(row).catch(() => null)
    const agent = pane ? observeAgent(nodeProcFs, this.home, pane.pid) : null
    if (agent && isResumeSessionId(tool, agent.resumeId)) resumeId = agent.resumeId
    if (!resumeId) {
      // The continuity observer's last sighting (every minute).
      const snapshot = readJsonFile<ContinuitySnapshot>(
        join(this.context.paths.stateDir, 'continuity.json'),
      )
      const seen = snapshot?.sessions.find((session) => session.id === row.id)?.resumeId ?? null
      if (seen && isResumeSessionId(tool, seen)) resumeId = seen
    }
    return {
      id: row.id,
      tool: row.tool,
      projectId: row.projectId,
      projectRoot: row.projectRoot,
      name: row.name,
      origin: row.origin,
      coordinator: row.coordinator,
      coordinatorId: row.coordinatorId,
      resumeId,
    }
  }

  /** A new session for a kept wake: the ended session's tool, project, name
   * and lineage, resuming its conversation with the message as the prompt. */
  private async relaunch(
    ended: EndedSession,
    message: string,
  ): Promise<{ status: 'started'; id: string } | { status: 'retry' | 'failed'; reason: string }> {
    await whenReady()
    if (!lingerEnabled()) return { status: 'retry', reason: 'linger is not enabled' }
    const tool = this.context.store.resolveTool(ended.tool)
    const spec = tool?.enabled ? getTui(tool.slug) : undefined
    if (!tool || !spec) return { status: 'failed', reason: `tool ${ended.tool} is not available` }
    const root = ended.projectRoot
    if (root && isBlankSlateRoot(root)) ensureBlankSlateWorkspace(root)
    if (!root || !isDir(root)) return { status: 'failed', reason: 'the project folder is gone' }
    const resume = ended.resumeId && isResumeSessionId(spec, ended.resumeId) ? ended.resumeId : null
    // A root's request stays a tombstone; the new session is a plain one.
    const origin: SessionOrigin = ended.origin === 'root' ? 'aico' : (ended.origin as SessionOrigin)
    const id = allocateWidgetId()
    insertWidget(id, tool.slug, Date.now(), { origin })
    setWidgetProject(id, ended.projectId, root)
    if (ended.name) setWidgetName(id, ended.name)
    if (ended.coordinator) {
      setCoordinator(id, true)
      for (const lane of listLanes(ended.id)) joinCoordinator(lane, id)
    } else if (ended.coordinatorId && getWidget(ended.coordinatorId)) {
      recordLauncher(id, ended.coordinatorId)
    }
    let started = false
    try {
      started = await withRootPrompt(
        id,
        message,
        () => ensureSessionSerialized(id, { cols: 100, rows: 30 }),
        resume,
      )
    } catch (error) {
      if (!(error instanceof AgentAdmissionDenied)) throw error
    }
    if (!started) {
      const failure = lastEnsureFailure(id)
      if (discardNeverAllocated(id)) notifySessionChanged(id, { ended: true })
      const reason = failure?.reason ?? 'launch did not start'
      return failure?.code === 'admission_denied' || failure?.code === 'linger_required'
        ? { status: 'retry', reason }
        : { status: 'failed', reason }
    }
    const latest = getWidget(id)
    if (latest) await verifySessionStatus(latest).catch(() => undefined)
    notifySessionChanged(id, { force: true })
    // A desktop-started session comes back in a window; a web-started one does not.
    if (latest && origin !== 'a-term' && this.context.gui.connected())
      void this.context.gui
        .send({ kind: 'show', sessionId: id, generation: generationOf(latest) })
        .catch(() => {})
    return { status: 'started', id }
  }
}

function only(body: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key))
  if (unknown.length) throw new HttpError(400, 'invalid_body', { fields: unknown })
}

function dueAt(value: unknown, now: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < now - MAX_BEHIND_MS ||
    value > now + MAX_AHEAD_MS
  )
    throw new HttpError(400, 'invalid_body', { field: 'dueAt' })
  return value
}

function requireWake(service: WakeService, id: string | undefined): Wake {
  const wake = id && WAKE_ID.test(id) ? service.store.get(id) : undefined
  if (!wake) throw new HttpError(404, 'not_found')
  return wake
}

export function registerWakeRoutes(
  router: Router,
  service: WakeService,
  now: () => number = Date.now,
): void {
  const policyJson = () => ({ policy: service.policy() })
  router
    .add('GET', '/v1/wakes', (_req, res) => {
      sendJson(res, 200, { items: service.store.list().map(wakeJson), ...policyJson() })
    })
    .add('GET', '/v1/sessions/:id/wakes', (_req, res, params) => {
      const row = params.id && /^[0-9a-f]{8}$/.test(params.id) ? getWidget(params.id) : undefined
      if (!row) throw new HttpError(404, 'not_found')
      sendJson(res, 200, { items: service.store.forSession(row.id).map(wakeJson), ...policyJson() })
    })
    .add('POST', '/v1/sessions/:id/wakes', async (req, res, params) => {
      const body = await readJsonObject(req)
      only(body, ['dueAt', 'note', 'createdBy'])
      const policy = service.policy()
      const at = dueAt(body.dueAt, now())
      const note = cleanNote(body.note, policy.noteMaxChars)
      if (note === null) throw new HttpError(400, 'invalid_body', { field: 'note' })
      const createdBy = body.createdBy ?? 'agent'
      if (createdBy !== 'agent' && createdBy !== 'owner')
        throw new HttpError(400, 'invalid_body', { field: 'createdBy' })
      const row = params.id && /^[0-9a-f]{8}$/.test(params.id) ? getWidget(params.id) : undefined
      if (!row) throw new HttpError(404, 'not_found')
      if (!service.supports(row)) throw new HttpError(409, 'wake_unsupported')
      if (service.store.forSession(row.id).length >= policy.maxPerSession)
        throw new HttpError(409, 'too_many_wakes', { max: policy.maxPerSession })
      const wake = service.store.add({ sessionId: row.id, dueAt: at, note, createdBy, now: now() })
      service.changed(row.id)
      sendJson(res, 201, wakeJson(wake))
    })
    .add('PATCH', '/v1/wakes/:wakeId', async (req, res, params) => {
      const body = await readJsonObject(req)
      only(body, ['dueAt', 'note'])
      const wake = requireWake(service, params.wakeId)
      const patch: { dueAt?: number; note?: string } = {}
      if (body.dueAt !== undefined) patch.dueAt = dueAt(body.dueAt, now())
      if (body.note !== undefined) {
        const note = cleanNote(body.note, service.policy().noteMaxChars)
        if (note === null) throw new HttpError(400, 'invalid_body', { field: 'note' })
        patch.note = note
      }
      const updated = service.store.update(wake.id, patch)
      if (!updated) throw new HttpError(404, 'not_found')
      service.changed(updated.sessionId)
      sendJson(res, 200, wakeJson(updated))
    })
    .add('DELETE', '/v1/wakes/:wakeId', (_req, res, params) => {
      const wake = requireWake(service, params.wakeId)
      service.store.remove(wake.id)
      service.changed(wake.sessionId)
      sendJson(res, 200, { deleted: true })
    })
    .add('GET', '/v1/wake-policy', (_req, res) => {
      sendJson(res, 200, policyJson())
    })
    .add('PUT', '/v1/wake-policy', async (req, res) => {
      const body = await readJsonObject(req)
      try {
        service.setPolicy(body, now())
      } catch (error) {
        if (error instanceof WakePolicyError)
          throw new HttpError(400, 'invalid_body', { field: error.field, detail: error.message })
        throw error
      }
      service.changed(null)
      sendJson(res, 200, policyJson())
    })
}
