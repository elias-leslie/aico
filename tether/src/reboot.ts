// Reboot continuity service: the observer that keeps continuity.json current,
// the restore that runs after startup reconciliation, and the routes
// Nightshift uses around a planned reboot (docs/reboot-continuity.md).

import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  CHECKPOINT_PROMPT,
  type ContinuitySnapshot,
  currentBootId,
  mergeSnapshot,
  nodeProcFs,
  observeAgent,
  RESUME_PROMPT,
  type RestoreEntry,
  type RestoreReport,
  readJsonFile,
  restoreCandidates,
  writeJsonFile,
} from './continuity'
import { HttpError, type Router, readJsonObject, sendJson } from './http'
import { AgentAdmissionDenied } from './lifecycle/agent-admission'
import { getWidget, listWidgets, type WidgetRow } from './lifecycle/catalog'
import {
  ensureSessionSerialized,
  lastEnsureFailure,
  verifiedCurrentManagedPane,
  verifySessionStatus,
  whenReady,
} from './lifecycle/engine'
import { withRootPrompt } from './lifecycle/root-launch'
import { isResumeSessionId } from './lifecycle/tui/launch'
import { getTui } from './lifecycle/tui/registry'
import { generationOf, type LifecycleApiContext, pasteIntoRunningSession } from './lifecycle-api'
import type { Recovery } from './recovery'

const OBSERVE_INTERVAL_MS = 60_000
const RESTORE_RETRY_MS = 30_000
const RESTORE_GIVE_UP_MS = 15 * 60_000
const DESKTOP_WAIT_MS = 5 * 60_000
const PREPARE_POLL_MS = 3_000
/** An agent may still report idle for a moment after the checkpoint prompt lands. */
const PREPARE_SETTLE_MS = 15_000

export interface PreparedSession {
  id: string
  name: string | null
  tool: string
  agent: boolean
  resumable: boolean
  idle: boolean | null
  notified: boolean
}

export interface PrepareResult {
  ready: boolean
  bootId: string
  sessions: PreparedSession[]
}

export interface ContinuityOptions {
  /** True once the desktop session's variables reach the user manager. */
  desktopReady?: () => boolean
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  log?: (message: string) => void
}

interface Observed {
  row: WidgetRow
  resumeId: string | null
  idle: boolean | null
  /** At a permission prompt or question, where a pasted Enter could answer it. */
  blocked: boolean
}

function isAgent(tool: string): boolean {
  return (getTui(tool)?.command.length ?? 0) > 0
}

function entry(row: WidgetRow | undefined, id: string, tool: string): RestoreEntry {
  return { id, name: row?.name ?? null, tool: row?.tool ?? tool }
}

export class Continuity {
  private timer: NodeJS.Timeout | null = null
  private observing: Promise<Observed[]> | null = null
  private readonly snapshotPath: string
  private readonly reportPath: string
  private readonly home: string
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly log: (message: string) => void
  private readonly desktopReady: () => boolean
  /** Sessions still waiting to be restored; the observer keeps them listed. */
  private readonly awaitingRestore = new Set<string>()
  /** Crash recovery: told about each agent session on every pass. */
  private recovery: Recovery | null = null

  constructor(
    private readonly context: LifecycleApiContext,
    options: ContinuityOptions = {},
  ) {
    this.snapshotPath = join(context.paths.stateDir, 'continuity.json')
    this.reportPath = join(context.paths.stateDir, 'restore.json')
    this.home = process.env.HOME ?? homedir()
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.log = options.log ?? ((message) => console.log(`[tether:continuity] ${message}`))
    this.desktopReady = options.desktopReady ?? (() => true)
  }

  /** Restore what the last boot left running, then keep the snapshot fresh. */
  async start(): Promise<void> {
    await whenReady()
    const restoring = this.restoreAfterStart().catch((error) =>
      this.log(`restore failed: ${(error as Error).message}`),
    )
    this.timer = setInterval(() => void this.observe().catch(() => {}), OBSERVE_INTERVAL_MS)
    this.timer.unref()
    await restoring
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  setRecovery(recovery: Recovery | null): void {
    this.recovery = recovery
  }

  isAwaitingRestore(id: string): boolean {
    return this.awaitingRestore.has(id)
  }

  /** One serialized pass over running sessions; rewrites continuity.json. */
  observe(): Promise<Observed[]> {
    if (!this.observing) {
      this.observing = this.observeOnce().finally(() => {
        this.observing = null
      })
    }
    return this.observing
  }

  private async observeOnce(): Promise<Observed[]> {
    const observed: Observed[] = []
    for (const row of listWidgets()) {
      if (this.awaitingRestore.has(row.id)) continue
      let status: string
      try {
        status = await verifySessionStatus(row)
      } catch {
        continue
      }
      if (status !== 'running') {
        if (isAgent(row.tool)) await this.recovery?.inspect(row, status, null, null).catch(() => {})
        continue
      }
      let resumeId: string | null = null
      let idle: boolean | null = null
      let blocked = false
      if (isAgent(row.tool)) {
        const pane = await verifiedCurrentManagedPane(row).catch(() => null)
        const agent = pane ? observeAgent(nodeProcFs, this.home, pane.pid) : null
        if (agent && isResumeSessionId(getTui(row.tool), agent.resumeId)) resumeId = agent.resumeId
        idle = agent?.idle ?? null
        blocked = agent?.blocked ?? false
        await this.recovery
          ?.inspect(row, status, pane?.pid ?? null, agent?.pid ?? null)
          .catch(() => {})
      }
      observed.push({ row, resumeId, idle, blocked })
    }
    const snapshot = mergeSnapshot(
      readJsonFile<ContinuitySnapshot>(this.snapshotPath),
      observed.map(({ row, resumeId }) => ({ id: row.id, tool: row.tool, resumeId })),
      (id) => this.awaitingRestore.has(id) || Boolean(this.recovery?.retains(id)),
      currentBootId(),
      this.now(),
    )
    writeJsonFile(this.snapshotPath, snapshot)
    return observed
  }

  /** Ask every running agent to checkpoint, then wait until they are idle. */
  async prepare(options: { timeoutMs: number; notify: boolean }): Promise<PrepareResult> {
    await whenReady()
    const started = this.now()
    const notified = new Set<string>()
    let observed = await this.observe()
    if (options.notify) {
      for (const { row, blocked } of observed) {
        // A submitted paste into a prompt could pick its default answer.
        if (blocked || !isAgent(row.tool)) continue
        if (await pasteIntoRunningSession(row.id, CHECKPOINT_PROMPT)) notified.add(row.id)
      }
      if (notified.size) await this.sleep(Math.min(PREPARE_SETTLE_MS, options.timeoutMs))
    }
    const busy = () => observed.some(({ row, idle }) => isAgent(row.tool) && idle === false)
    observed = await this.observe()
    while (busy() && this.now() - started < options.timeoutMs) {
      await this.sleep(PREPARE_POLL_MS)
      observed = await this.observe()
    }
    const snapshot = readJsonFile<ContinuitySnapshot>(this.snapshotPath)
    const resumeIds = new Map((snapshot?.sessions ?? []).map((s) => [s.id, s.resumeId]))
    return {
      ready: !busy(),
      bootId: currentBootId(),
      sessions: observed.map(({ row, idle }) => ({
        id: row.id,
        name: row.name ?? null,
        tool: row.tool,
        agent: isAgent(row.tool),
        resumable: Boolean(resumeIds.get(row.id)),
        idle,
        notified: notified.has(row.id),
      })),
    }
  }

  /** Nightshift's post-boot view (contract agreed with LANE A2). */
  status(): Record<string, unknown> {
    const report = readJsonFile<RestoreReport>(this.reportPath)
    const snapshot = readJsonFile<ContinuitySnapshot>(this.snapshotPath)
    return {
      boot_id: currentBootId(),
      restore_boot_id: report?.bootId ?? null,
      restore_started_at: report?.startedAt ?? null,
      restore_finished_at: report?.finishedAt ?? null,
      restored: report?.restored ?? [],
      failed: report?.failed ?? [],
      pending: report?.pending ?? [],
      snapshot_updated_at: snapshot?.updatedAt ?? null,
      snapshot_sessions: snapshot?.sessions.length ?? 0,
    }
  }

  /** Relaunch every session the snapshot saw running whose tmux server is
   * gone (a reboot, or the server ended), resuming its agent. */
  async restoreAfterStart(): Promise<RestoreReport | null> {
    const snapshot = readJsonFile<ContinuitySnapshot>(this.snapshotPath)
    const statuses = new Map<string, string>()
    for (const session of snapshot?.sessions ?? []) {
      const row = getWidget(session.id)
      if (row) statuses.set(row.id, await verifySessionStatus(row).catch(() => 'uncertain'))
    }
    // A session crash recovery holds is resumed there, never twice.
    const candidates = restoreCandidates(snapshot, (id) => statuses.get(id) ?? null).filter(
      (session) => !this.recovery?.retains(session.id),
    )
    if (candidates.length === 0) return null
    for (const session of candidates) this.awaitingRestore.add(session.id)
    const report: RestoreReport = {
      v: 1,
      bootId: currentBootId(),
      startedAt: this.now(),
      finishedAt: null,
      restored: [],
      failed: [],
      pending: candidates.map((s) => entry(getWidget(s.id), s.id, s.tool)),
    }
    writeJsonFile(this.reportPath, report)
    this.log(`restoring ${candidates.length} session(s) from the last boot`)

    // Panes started before the desktop session would have no DISPLAY.
    const waitUntil = this.now() + DESKTOP_WAIT_MS
    while (!this.desktopReady() && this.now() < waitUntil) await this.sleep(5_000)

    let queue = candidates
    const giveUp = this.now() + RESTORE_GIVE_UP_MS
    while (queue.length) {
      const retry: typeof queue = []
      for (const session of queue) {
        const outcome = await this.restoreOne(session.id, session.resumeId)
        const row = getWidget(session.id)
        report.pending = report.pending.filter((p) => p.id !== session.id)
        if (outcome.status === 'restored') {
          this.awaitingRestore.delete(session.id)
          report.restored.push({
            ...entry(row, session.id, session.tool),
            resumed: outcome.resumed,
          })
        } else if (outcome.status === 'retry' && this.now() < giveUp) {
          retry.push(session)
          report.pending.push({ ...entry(row, session.id, session.tool), reason: outcome.reason })
        } else {
          this.awaitingRestore.delete(session.id)
          report.failed.push({ ...entry(row, session.id, session.tool), reason: outcome.reason })
        }
        writeJsonFile(this.reportPath, report)
      }
      queue = retry
      if (queue.length) await this.sleep(RESTORE_RETRY_MS)
    }
    report.finishedAt = this.now()
    writeJsonFile(this.reportPath, report)
    this.log(`restore finished: ${report.restored.length} restored, ${report.failed.length} failed`)
    void this.observe().catch(() => {})
    return report
  }

  private async restoreOne(
    id: string,
    resumeId: string | null,
  ): Promise<
    { status: 'restored'; resumed: boolean } | { status: 'retry' | 'failed'; reason: string }
  > {
    const row = getWidget(id)
    if (!row) return { status: 'failed', reason: 'session was ended' }
    const tool = getTui(row.tool)
    const resume = resumeId !== null && isResumeSessionId(tool, resumeId) ? resumeId : null
    try {
      const launch = () => ensureSessionSerialized(id, { cols: 100, rows: 30 })
      const ok = resume ? await withRootPrompt(id, RESUME_PROMPT, launch, resume) : await launch()
      const latest = getWidget(id)
      const status = latest ? await verifySessionStatus(latest) : 'pending'
      if (!ok || status === 'pending') {
        const failure = lastEnsureFailure(id)
        const reason = failure?.reason ?? 'launch did not start'
        return failure?.code === 'admission_denied'
          ? { status: 'retry', reason }
          : { status: 'failed', reason }
      }
      if (latest && this.context.gui.connected()) {
        void this.context.gui.send({
          kind: 'show',
          sessionId: id,
          generation: generationOf(latest),
        })
      }
      return { status: 'restored', resumed: Boolean(resume) }
    } catch (error) {
      const reason = (error as Error).message
      return error instanceof AgentAdmissionDenied
        ? { status: 'retry', reason }
        : { status: 'failed', reason }
    }
  }
}

export function registerRebootRoutes(router: Router, continuity: Continuity): void {
  router
    .add('POST', '/v1/reboot/prepare', async (req, res) => {
      const body = await readJsonObject(req)
      for (const key of Object.keys(body))
        if (key !== 'timeoutSec' && key !== 'notify')
          throw new HttpError(400, 'invalid_body', { field: key })
      const timeoutSec = body.timeoutSec ?? 300
      if (
        typeof timeoutSec !== 'number' ||
        !Number.isFinite(timeoutSec) ||
        timeoutSec < 0 ||
        timeoutSec > 3600
      )
        throw new HttpError(400, 'invalid_body', { field: 'timeoutSec' })
      if (body.notify !== undefined && typeof body.notify !== 'boolean')
        throw new HttpError(400, 'invalid_body', { field: 'notify' })
      const result = await continuity.prepare({
        timeoutMs: timeoutSec * 1000,
        notify: body.notify !== false,
      })
      sendJson(res, 200, result)
    })
    .add('GET', '/v1/reboot/status', async (_req, res) => {
      sendJson(res, 200, continuity.status())
    })
}
