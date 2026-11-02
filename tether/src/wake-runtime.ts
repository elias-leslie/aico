// Session wakes against the running daemon: the scheduler's live operations
// (agent state, the visible input line, tmux clients, the paste, the desktop,
// a kept wake's relaunch), the End hook that keeps wakes, and the HTTP routes
// (docs/api-v1.md "Wakes"). The scheduling rules live in wakes.ts.

import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { type ContinuitySnapshot, nodeProcFs, observeAgent, readJsonFile } from './continuity'
import { DeliveryLog, registerDeliveryRoutes } from './deliveries'
import { HttpError, type Router, readJsonObject, sendJson } from './http'
import { AgentAdmissionDenied } from './lifecycle/agent-admission'
import {
  allocateWidgetId,
  clearLaunched,
  getSessionEntry,
  getWidget,
  insertWidget,
  joinCoordinator,
  listLanes,
  recordLauncher,
  relaunchLauncher,
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
import { AGENT_HUB_TOOL, getTui, isDeliveryTool } from './lifecycle/tui/registry'
import { agentStateOf, type LifecycleApiContext, pasteIntoRunningSession } from './lifecycle-api'
import {
  applyWakePolicyPatch,
  cleanNote,
  clockLabel,
  durationLabel,
  type EndedSession,
  inputLineEmpty,
  parseStoredWakePolicy,
  reachesSession,
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
/** How long a "session told session" mark is kept. */
const TOLD_KEEP_MS = 6 * 3600_000

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

/** An Agent Hub session is an agent with no pane (src/agent-hub/). */
function isHub(row: WidgetRow | undefined): boolean {
  return row?.backend === 'agent-hub'
}

/** The session's wakes for its descriptor (`wakes`), oldest first. */
let bound: WakeStore | null = null

export function bindWakeStore(store: WakeStore | null): void {
  bound = store
}

export function sessionWakes(sessionId: string): Record<string, unknown>[] {
  return (bound?.checkIns(sessionId) ?? []).map((wake) => ({
    id: wake.id,
    dueAt: wake.dueAt,
    note: wake.note,
    createdBy: wake.createdBy,
  }))
}

/** The waits' own `waitingOn` (src/waits.ts), bound by the daemon. */
let boundWaits: ((sessionId: string) => string | null) | null = null

export function bindWaitingOn(waitingOn: ((sessionId: string) => string | null) | null): void {
  boundWaits = waitingOn
}

/** What the session's agent waits on, for its descriptor (`waitingOn`): its
 * oldest armed wait, else its earliest check-in. A lane that waits is not
 * reported as finished. */
export function sessionWaitingOn(sessionId: string, now = Date.now()): string | null {
  const wait = boundWaits?.(sessionId)
  if (wait) return wait
  const first = bound?.checkIns(sessionId)[0]
  if (!first) return null
  return first.dueAt <= now
    ? 'a check-in that is due'
    : `a check-in at ${clockLabel(first.dueAt, now)}`
}

export class WakeService {
  readonly store: WakeStore
  readonly scheduler: WakeScheduler
  /** What became of lines other owners queued (src/deliveries.ts). */
  readonly deliveries: DeliveryLog
  private readonly home: string
  private readonly now: () => number

  constructor(
    private readonly context: LifecycleApiContext,
    options: { home?: string; now?: () => number; operations?: Partial<WakeOperations> } = {},
  ) {
    this.store = new WakeStore(context.store.db)
    this.deliveries = new DeliveryLog(context.store.db)
    this.home = options.home ?? process.env.HOME ?? homedir()
    const now = options.now ?? Date.now
    this.now = now
    this.scheduler = new WakeScheduler(this.store, {
      now,
      policy: () => this.policy(),
      busy: (id) => this.busy(id),
      inputEmpty: (id) => this.inputEmpty(id),
      lastKeyAt: (id) => this.lastKeyAt(id),
      deliver: (id, text) => pasteIntoRunningSession(id, text),
      delivered: (id, rows, via) => {
        this.deliveries.delivered(
          rows,
          via === 'native' ? 'native' : isHub(getWidget(id)) ? 'turn' : 'paste',
          now(),
        )
        this.noteReached(id, rows)
      },
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

  /** Whether event lines (lane reports, waits, deliveries) go to this
   * session: an agent session Tether delivers to (Claude Code, Codex, Pi, agy,
   * Agent Hub). */
  receiver(id: string): boolean {
    const row = getWidget(id)
    return Boolean(row && (isHub(row) || isDeliveryTool(row.tool)))
  }

  /** Queue an event line due now on a session (coalesced by source while
   * undelivered) and look at the queue. */
  queueEvent(
    sessionId: string,
    source: string,
    line: string,
    ride = false,
    reach?: { reached: boolean; replyFrom?: readonly string[] },
  ): Wake {
    const wake = this.store.addEvent({
      sessionId,
      source,
      note: line,
      now: this.now(),
      ride,
      ...(reach ? { reached: reach.reached } : {}),
      ...(reach?.replyFrom?.length ? { replyFrom: reach.replyFrom } : {}),
    })
    this.changed(sessionId)
    return wake
  }

  /** An owner's answer to an ask, queued on the session that gets it. The
   * session only has to be there and take lines: its agent state may be
   * unknown (Tether just restarted), the line waits until the state is read.
   * The line is logged like a producer's, so an answer whose session ended
   * before it went out can be queued again (handOffAsks). Returns the row's
   * id, or null (logged with the reason) when it cannot be queued. */
  queueAnswer(sessionId: string, text: string, source: string): string | null {
    const row = getWidget(sessionId)
    if (!row || !this.receiver(sessionId)) {
      console.log(
        `[tether:wakes] answer line ${source} not queued: session=${sessionId} takes no lines`,
      )
      return null
    }
    const note = cleanNote(text, this.policy().noteMaxChars)
    if (note === null) {
      console.log(`[tether:wakes] answer line ${source} not queued: the line is not valid text`)
      return null
    }
    const now = this.now()
    const wake = this.store.addEvent({ sessionId: row.id, source, note, now })
    this.deliveries.record({ id: wake.id, sessionId: row.id, source, now })
    this.changed(row.id)
    return wake.id
  }

  /** Take back a queued line its owner no longer wants delivered (`why`), and
   * say so: a line that never went out is never dropped silently. */
  cancelLine(wakeId: string, why: string): void {
    const wake = this.store.get(wakeId)
    if (!wake || !this.store.remove(wakeId)) return
    console.log(
      `[tether:wakes] dropped undelivered line ${wake.source ?? 'check-in'} on session=${wake.sessionId} (${why}), queued ${durationLabel(this.now() - wake.dueAt)} earlier`,
    )
    this.changed(wake.sessionId)
  }

  /** Sessions that told another, `from>to` -> when: a lane that messaged its
   * launcher during a turn needs no went-idle line for it (lane-reports.ts).
   * Memory only: after a restart the lane gets its line, as before. */
  private readonly told = new Map<string, number>()

  /** A wake-class delivery carried a message from each of `from` to `to`.
   * Each sent to `to` (session_sends, as a root send does: a lane's repeat
   * went-idle line is a first line again once its receiver sent it work);
   * with `told`, each also told `to` something (a request, not an ack). */
  noteSent(from: readonly string[], to: string, told = true): void {
    const now = this.now()
    for (const id of from) {
      if (id === to) continue
      this.context.waits?.store.recordSend(id, to, now)
      if (told) this.told.set(`${id}>${to}`, now)
    }
    for (const [key, at] of this.told) if (now - at > TOLD_KEEP_MS) this.told.delete(key)
  }

  /** Rows that went out to a session (pasted, an Agent Hub turn, or taken
   * by its puller or hook): if one came from outside, a lane's next went-idle
   * line is a first line (LaneReporter.reached). */
  noteReached(sessionId: string, rows: readonly Wake[]): void {
    const from = rows.find(reachesSession)
    if (from) this.context.lanes?.reached(sessionId, `got ${from.source ?? 'a check-in'}`)
  }

  /** A reply (an ack) from each of `from` to `to`: whatever it answers
   * reached the replier, though maybe not through a line Tether delivered
   * (an inbox it read itself). A ride-along reply wakes nobody, so it also
   * takes back the replier's "told" to `to`: its went-idle line for the turn
   * must still go out and carry the reply (review of SummitFlow ebd6ea870 P1). */
  noteReplied(from: readonly string[], to: string, ride = false): void {
    for (const id of from) {
      if (id === to) continue
      if (ride) this.told.delete(`${id}>${to}`)
      this.context.lanes?.reached(id, `replied to ${to}`)
    }
  }

  /** A lane went idle waiting on something of its own, so no went-idle line
   * carries its ride-along replies: those still queued for its receivers
   * become wakes (WakeStore.promoteReplies). Returns the receivers woken. */
  promoteReplies(lane: string, receivers: readonly string[]): string[] {
    const promoted = this.store.promoteReplies(lane, receivers)
    for (const receiver of promoted) this.changed(receiver)
    return promoted
  }

  /** Whether `from` told `to` at or after `since`. */
  toldSince(from: string, to: string, since: number): boolean {
    return (this.told.get(`${from}>${to}`) ?? -1) >= since
  }

  /** Take back a source's undelivered line(s) (docs/api-v1.md "Deliveries"). */
  withdrawEvents(
    sessionId: string | null,
    source: string,
  ): { withdrawn: number; sending: boolean } {
    const { withdrawn, sending } = this.scheduler.withdraw(sessionId, source)
    for (const id of new Set(withdrawn.map((wake) => wake.sessionId))) if (id) this.changed(id)
    if (withdrawn.length)
      console.log(
        `[tether:wakes] withdrew ${withdrawn.length} line(s) from ${source}${sessionId ? ` on session=${sessionId}` : ''}, queued ${durationLabel(this.now() - Math.min(...withdrawn.map((wake) => wake.dueAt)))} earlier`,
      )
    return { withdrawn: withdrawn.length, sending }
  }

  /** Whether wakes can be delivered to this session: an agent whose state
   * Tether reads (a shell reports none, so idle would never come). */
  supports(row: WidgetRow): boolean {
    if (isHub(row)) return true
    return isAgent(row.tool) && agentStateOf(row.id).state !== 'unknown'
  }

  private async busy(sessionId: string): Promise<string | null> {
    const row = getWidget(sessionId)
    if (!row) return 'the session is gone'
    if (!(isHub(row) || isAgent(row.tool))) return `${row.tool} is not an agent`
    const agent = agentStateOf(sessionId)
    if (agent.state !== 'idle') return `the agent is ${agent.state} (${agent.stateSource})`
    const status = await verifySessionStatus(row).catch(() => 'uncertain')
    return status === 'running' ? null : `the session is ${status}`
  }

  /** A wake as the API shows it, with why it waits once due. */
  json(wake: Wake): Record<string, unknown> {
    const waitingFor =
      wake.sessionId && wake.dueAt <= this.now() ? this.scheduler.heldReason(wake.sessionId) : null
    return { ...wakeJson(wake), waitingFor }
  }

  private async inputEmpty(sessionId: string): Promise<boolean> {
    const row = getWidget(sessionId)
    // No input line: a follow-up is a turn, not typing.
    if (isHub(row)) return true
    try {
      return inputLineEmpty(
        await runTmux(captureVisibleTargetArgs(tmuxPaneTargetForWidget(sessionId), true)),
        (row && getTui(row.tool)?.inputLine) ?? 'prompt',
      )
    } catch {
      return false
    }
  }

  private async lastKeyAt(sessionId: string): Promise<number | null> {
    if (isHub(getWidget(sessionId))) return null
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

  private async conversationHolder(resumeId: string): Promise<string | null> {
    const continuity = this.context.continuity
    if (!continuity) return null
    const observed = await continuity.observe().catch(() => [])
    return observed.find((entry) => entry.resumeId === resumeId)?.row.id ?? null
  }

  /** What a kept wake needs to start this session's conversation again. */
  async endedSnapshot(row: WidgetRow): Promise<EndedSession> {
    let resumeId: string | null = null
    if (isHub(row)) return endedSnapshotOf(row, null)
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
    return endedSnapshotOf(row, resumeId)
  }

  /** A new session for a kept wake: the ended session's tool, project, name
   * and lineage, resuming its conversation with the message as the prompt. */
  private async relaunch(
    ended: EndedSession,
    message: string,
  ): Promise<{ status: 'started'; id: string } | { status: 'retry' | 'failed'; reason: string }> {
    await whenReady()
    // A kept wake has no Agent Hub conversation to start again: the session
    // was closed with its End.
    if (ended.tool === AGENT_HUB_TOOL)
      return { status: 'failed', reason: 'an ended Agent Hub session cannot be started again' }
    // Never on this host: its agent ran through an entry that ended with it.
    if (ended.entry)
      return {
        status: 'failed',
        reason: `a session that ran through entry ${ended.entry.name} cannot be started again`,
      }
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
      recordLauncher(id, relaunchLauncher(ended.coordinatorId, ended.parentId ?? null))
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
      // It never ran: its delete must not tell the coordinator a lane ended.
      clearLaunched(id)
      if (discardNeverAllocated(id)) notifySessionChanged(id, { ended: true })
      const reason = failure?.reason ?? 'launch did not start'
      return failure?.code === 'admission_denied' || failure?.code === 'linger_required'
        ? { status: 'retry', reason }
        : { status: 'failed', reason }
    }
    const latest = getWidget(id)
    if (latest) await verifySessionStatus(latest).catch(() => undefined)
    notifySessionChanged(id, { force: true })
    return { status: 'started', id }
  }
}

function endedSnapshotOf(row: WidgetRow, resumeId: string | null): EndedSession {
  return {
    id: row.id,
    tool: row.tool,
    projectId: row.projectId,
    projectRoot: row.projectRoot,
    name: row.name,
    origin: row.origin,
    coordinator: row.coordinator,
    coordinatorId: row.coordinatorId,
    parentId: row.parentId,
    resumeId,
    ...entrySnapshot(row.id),
  }
}

function entrySnapshot(id: string): { entry?: { name: string; arg: string } } {
  const entry = getSessionEntry(id)
  return entry ? { entry } : {}
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
  // Event lines are Tether's, not check-ins: not listed, moved or cancelled.
  if (wake?.kind !== 'time') throw new HttpError(404, 'not_found')
  return wake
}

export function registerWakeRoutes(
  router: Router,
  service: WakeService,
  now: () => number = Date.now,
): void {
  const policyJson = () => ({ policy: service.policy() })
  registerDeliveryRoutes(router, {
    log: () => service.deliveries,
    exists: (id) => getWidget(id) !== undefined,
    receiver: (id) => service.receiver(id),
    maxChars: () => service.policy().noteMaxChars,
    queue: (id, source, line, ride, reach) => service.queueEvent(id, source, line, ride, reach),
    sent: (from, to, told) => service.noteSent(from, to, told),
    replied: (from, to, ride) => service.noteReplied(from, to, ride),
    takeRide: (id) => service.scheduler.takeRide(id),
    peekRide: (id) => service.scheduler.peekRide(id),
    confirmRide: (id, token) => service.scheduler.confirmRide(id, token),
    withdraw: (id, source) => service.withdrawEvents(id, source),
    pending: (id) => service.store.get(id) !== undefined || service.scheduler.inFlight(id),
    pull: (id, ms, aborted, alive) => service.scheduler.pull(id, ms, aborted, alive),
    now,
  })
  router
    .add('GET', '/v1/wakes', (_req, res) => {
      sendJson(res, 200, {
        items: service.store.checkIns().map((wake) => service.json(wake)),
        ...policyJson(),
      })
    })
    .add('GET', '/v1/sessions/:id/wakes', (_req, res, params) => {
      const row = params.id && /^[0-9a-f]{8}$/.test(params.id) ? getWidget(params.id) : undefined
      if (!row) throw new HttpError(404, 'not_found')
      sendJson(res, 200, {
        items: service.store.checkIns(row.id).map((wake) => service.json(wake)),
        ...policyJson(),
      })
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
      if (service.store.checkIns(row.id).length >= policy.maxPerSession)
        throw new HttpError(409, 'too_many_wakes', { max: policy.maxPerSession })
      const wake = service.store.add({ sessionId: row.id, dueAt: at, note, createdBy, now: now() })
      service.changed(row.id)
      sendJson(res, 201, service.json(wake))
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
      sendJson(res, 200, service.json(updated))
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
