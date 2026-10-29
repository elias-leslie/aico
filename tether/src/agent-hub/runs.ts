// Workflow runs as children of the session that launched them.
//
// A run records `launched_by`, the AICO_SESSION_ID of the session that created
// it (`st workflow create`), which is the launching session's ownership id.
// Tether asks Agent Hub, through the SDK, for the runs of each live session by
// that id, reads the full view of every run that is active (and of an ended one
// once), and keeps the result as team members (runs-view.ts).
//
// - Active runs are read on every poll, for their live phase.
// - An ended run drops off on its own `endedRetentionMs` after its last activity
//   (or at once when dismissed through the API; dismissals are kept across restarts).
// - A run whose launching session has ended stays while it is active, so a
//   decision it asks of the owner is not lost with the coordinator.
// - A failed look keeps the last answer, marked stale; before any look has
//   worked it reads unavailable.
//
// Runs started outside Aico have no `launched_by` and are never listed.

import type { RunAction, RunList, RunListItem, RunView } from '@agent-hub/sdk'
import type { RunDecision, RunMember, RunsAnswer } from '../client/index'
import type { RunsConfig } from './config'
import { isActiveRun, type PauseNotice, parseTime, pauseNotice, runMembers } from './runs-view'
import { classifyHubError, type HubApi } from './runtime'

/** The slice of the SDK's workflow API Tether uses. */
export type RunsApi = HubApi['workflowRuns']

/** A session that may launch runs. */
export interface Launcher {
  /** Tether's session id. */
  id: string
  /** The id runs record as `launched_by`. */
  ownershipId: string
  /** Other ids the same session's runs may record. An Agent Hub chat session
   * launches from Agent Hub's own shell, which names the chat's Agent Hub
   * session id (`AGENT_HUB_SESSION_ID`); a terminal session names its Aico id. */
  alsoOwnedAs?: string[]
}

/** The sessions to look for runs of: every terminal session by its Aico id,
 * and every Agent Hub chat session by its Aico id and its Agent Hub session id. */
export function sessionLaunchers(
  rows: readonly { id: string; sessionId: string; backend: string }[],
  hubSessionIdOf: (id: string) => string | undefined,
): Launcher[] {
  return rows.map((row) => {
    const hubId = row.backend === 'agent-hub' ? hubSessionIdOf(row.id) : undefined
    return {
      id: row.id,
      ownershipId: row.sessionId,
      ...(hubId && hubId !== row.sessionId ? { alsoOwnedAs: [hubId] } : {}),
    }
  })
}

export type RunControlCode = 'unknown_run' | 'unknown_step' | 'not_allowed' | 'no_session'

/** A control Tether refuses before asking Agent Hub. */
export class RunControlError extends Error {
  constructor(
    readonly code: RunControlCode,
    message: string,
  ) {
    super(message)
  }
}

/** The dismissed runs (run id to when), kept by the caller across restarts. */
export interface DismissedStore {
  read(): Record<string, number>
  write(dismissed: Record<string, number>): void
}

/** The pauses already told to the launching session (run id to the pause's key
 * and when), kept by the caller across restarts so a pause is told once. */
export interface PauseNoticeStore {
  read(): Record<string, { key: string; at: number }>
  write(told: Record<string, { key: string; at: number }>): void
}

/** Where a pause is told to the session that launched the run. */
export interface PauseNotices {
  store: PauseNoticeStore
  /** The longest note the session takes. */
  maxChars: () => number
  /** Hand the note to the session; true once it is queued for it, false when
   * the session cannot take one now (tried again at the next look). */
  tell(launcherId: string, notice: PauseNotice): boolean | Promise<boolean>
}

/** What the read-only view of a step's attempt needs. */
export interface StepSession {
  sessionId: string
  agentSlug: string
  requestedModel: string | null
  attempt: number | null
  title: string
}

export interface RunTrackerOptions {
  api: () => RunsApi
  /** The sessions to look for runs of. */
  launchers: () => Launcher[]
  config: RunsConfig
  dismissed: DismissedStore
  /** Tell the launching session when a run waits for the owner. */
  pauses?: PauseNotices
  /** The listed runs changed. */
  notify: () => void
  now?: () => number
  log?: (message: string) => void
}

interface Tracked {
  launcherId: string
  view: RunView
  members: RunMember[]
}

/** Dismissals older than this are forgotten; the run itself is long past retention. */
const DISMISSED_KEEP_MS = 30 * 86_400_000

const FAILURE_WORDS: Record<string, string> = {
  agent_hub_unavailable: 'Agent Hub is not reachable',
  agent_hub_refused: 'Agent Hub refused the request',
}

export class RunTracker {
  private readonly tracked = new Map<string, Tracked>()
  private readonly now: () => number
  private readonly log: (message: string) => void
  private dismissed: Record<string, number>
  private told: Record<string, { key: string; at: number }>
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false
  private stopped = false
  private lastOk: number | null = null
  private lastError: string | null = null
  private shown = ''

  constructor(private readonly options: RunTrackerOptions) {
    this.now = options.now ?? Date.now
    this.log = options.log ?? ((message) => console.log(`[tether:runs] ${message}`))
    this.dismissed = options.dismissed.read()
    this.told = options.pauses?.store.read() ?? {}
  }

  start(): void {
    if (this.timer) return
    this.stopped = false
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.options.config.pollMs)
    this.timer.unref()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** The runs and steps to show, runs oldest first. */
  snapshot(): RunsAnswer {
    const items = [...this.tracked.values()]
      .filter((entry) => this.visible(entry.view))
      .sort((a, b) => (parseTime(a.view.created_at) ?? 0) - (parseTime(b.view.created_at) ?? 0))
      .flatMap((entry) => entry.members)
    const status = this.lastError ? (this.lastOk === null ? 'unavailable' : 'stale') : 'ok'
    return { status, error: this.lastError, updatedAt: this.lastOk, items }
  }

  private visible(
    view: Pick<RunListItem, 'id' | 'state' | 'last_activity_at' | 'created_at'>,
  ): boolean {
    if (isActiveRun(view.state)) return true
    if (this.dismissed[view.id]) return false
    const at = parseTime(view.last_activity_at) ?? parseTime(view.created_at) ?? 0
    return this.now() - at <= this.options.config.endedRetentionMs
  }

  // --- polling ------------------------------------------------------------------

  async tick(): Promise<void> {
    if (this.ticking || this.stopped) return
    this.ticking = true
    try {
      await this.poll()
    } catch (error) {
      this.fail(error)
    } finally {
      this.ticking = false
    }
    this.publish()
  }

  private fail(error: unknown): void {
    const failure = classifyHubError(error)
    this.lastError = FAILURE_WORDS[failure.code] ?? failure.message
    this.log(`look failed: ${failure.code}`)
  }

  private async poll(): Promise<void> {
    const { api: apiOf, config } = this.options
    const api = apiOf()
    const launchers = this.options.launchers()
    const live = new Set(launchers.map((launcher) => launcher.id))
    const listed = new Map<string, { item: RunListItem; launcherId: string }>()
    const reached = new Set<string>()
    const missed = new Set<string>()
    let failure: unknown = null

    const queue = launchers.flatMap((launcher) =>
      [launcher.ownershipId, ...(launcher.alsoOwnedAs ?? [])].map((ownedAs) => ({
        launcherId: launcher.id,
        ownedAs,
      })),
    )
    await Promise.all(
      Array.from({ length: Math.min(config.concurrency, queue.length) }, async () => {
        for (let look = queue.shift(); look; look = queue.shift()) {
          if (this.stopped) return
          try {
            const answer: RunList = await api.list({
              launched_by: look.ownedAs,
              limit: config.listLimit,
            })
            reached.add(look.launcherId)
            for (const item of answer.runs)
              listed.set(item.id, { item, launcherId: look.launcherId })
          } catch (error) {
            missed.add(look.launcherId)
            failure ??= error
          }
        }
      }),
    )
    // A launcher is reached only when every id of it answered.
    for (const id of missed) reached.delete(id)
    if (this.stopped) return

    const reads: Promise<void>[] = []
    const read = (runId: string, launcherId: string) =>
      reads.push(
        api.get(runId).then(
          (view) => {
            // A run left by its launcher is followed only while it is going.
            if (!live.has(launcherId) && !isActiveRun(view.state)) this.tracked.delete(runId)
            else this.accept(launcherId, view)
          },
          (error) => {
            const status = (error as { status?: number })?.status
            if (status === 404) this.tracked.delete(runId)
            else failure ??= error
          },
        ),
      )

    for (const [runId, { item, launcherId }] of listed) {
      const cached = this.tracked.get(runId)
      if (isActiveRun(item.state) && this.dismissed[runId]) {
        // Reopened by new steps: it is going again, so it is no longer dismissed.
        delete this.dismissed[runId]
        this.options.dismissed.write(this.dismissed)
      }
      if (!this.visible(item)) {
        this.tracked.delete(runId)
        continue
      }
      const unchanged =
        cached &&
        !isActiveRun(item.state) &&
        cached.view.state === item.state &&
        cached.view.last_activity_at === item.last_activity_at
      if (cached && cached.launcherId !== launcherId) cached.launcherId = launcherId
      if (!unchanged) read(runId, launcherId)
    }
    for (const [runId, entry] of this.tracked) {
      if (listed.has(runId)) continue
      if (reached.has(entry.launcherId)) {
        // Its launcher answered and no longer lists it.
        this.tracked.delete(runId)
      } else if (!live.has(entry.launcherId)) {
        // The launcher ended: follow the run only while it is active.
        if (isActiveRun(entry.view.state)) read(runId, entry.launcherId)
        else this.tracked.delete(runId)
      }
      // A launcher that is live but could not be asked keeps its runs, stale.
    }
    await Promise.all(reads)
    this.pruneDismissed()
    await this.tellPauses(live)

    if (failure) this.fail(failure)
    else {
      this.lastOk = this.now()
      this.lastError = null
    }
  }

  private accept(launcherId: string, view: RunView): void {
    const ctx = { launcherId, url: this.pageUrl(view.id) }
    this.tracked.set(view.id, { launcherId, view, members: runMembers(view, ctx) })
  }

  /** Once per pause, tell the session that launched a run waiting for the
   * owner. A run that is not waiting forgets its last pause, so the next one
   * is told again; a launcher that has ended is not told (the owner answers
   * from the expanded run). */
  private async tellPauses(live: Set<string>): Promise<void> {
    const pauses = this.options.pauses
    if (!pauses) return
    let changed = false
    for (const [runId, entry] of this.tracked) {
      const notice =
        entry.view.state === 'needs_owner' ? pauseNotice(entry.view, pauses.maxChars()) : null
      if (!notice) {
        if (this.told[runId]) {
          delete this.told[runId]
          changed = true
        }
        continue
      }
      if (this.told[runId]?.key === notice.key || !live.has(entry.launcherId)) continue
      let told = false
      try {
        told = await pauses.tell(entry.launcherId, notice)
      } catch (error) {
        this.log(`could not tell the session about a paused run: ${(error as Error).message}`)
      }
      if (!told) continue
      this.told[runId] = { key: notice.key, at: this.now() }
      changed = true
    }
    const cutoff = this.now() - DISMISSED_KEEP_MS
    for (const [runId, { at }] of Object.entries(this.told))
      if (at < cutoff) {
        delete this.told[runId]
        changed = true
      }
    if (changed) pauses.store.write(this.told)
  }

  /** The session of a step's latest attempt, for reading it (or, with
   * `sessionId`, that one of the step's attempts). Only a step of a run
   * Tether lists. */
  stepSession(runId: string, stepKey: string, sessionId?: string): StepSession {
    const entry = this.run(runId)
    const step = entry.view.steps?.find((candidate) => candidate.key === stepKey)
    if (!step) throw new RunControlError('unknown_step', `The run has no step ${stepKey}`)
    const history = step.attempt_history ?? []
    const attempt = sessionId
      ? history.find((candidate) => candidate.session_id === sessionId)
      : history[history.length - 1]
    if (!attempt?.session_id)
      throw new RunControlError('no_session', 'That step has not started an attempt yet')
    return {
      sessionId: attempt.session_id,
      agentSlug: step.agent_slug ?? '',
      requestedModel: attempt.requested_model ?? step.chain?.[0] ?? step.chosen_model ?? null,
      attempt: typeof attempt.attempt === 'number' ? attempt.attempt : null,
      title: stepKey,
    }
  }

  private pageUrl(runId: string): string {
    return `${this.options.config.frontendUrl}/workflow-runs/${encodeURIComponent(runId)}`
  }

  private pruneDismissed(): void {
    const cutoff = this.now() - DISMISSED_KEEP_MS
    const stale = Object.entries(this.dismissed).filter(([, at]) => at < cutoff)
    if (!stale.length) return
    for (const [id] of stale) delete this.dismissed[id]
    this.options.dismissed.write(this.dismissed)
  }

  private publish(): void {
    const key = JSON.stringify(this.snapshot())
    if (key === this.shown) return
    this.shown = key
    this.options.notify()
  }

  // --- controls -----------------------------------------------------------------

  private run(runId: string): Tracked {
    const entry = this.tracked.get(runId)
    if (!entry) throw new RunControlError('unknown_run', 'Aico is not following that run')
    return entry
  }

  private member(entry: Tracked, stepKey: string | null): RunMember {
    const member = entry.members.find((m) => m.stepKey === stepKey)
    if (!member) throw new RunControlError('unknown_step', `The run has no step ${stepKey}`)
    return member
  }

  /** Look at one run again now, so the answer to a control shows at once. */
  private async refresh(runId: string, launcherId: string): Promise<void> {
    try {
      this.accept(launcherId, await this.options.api().get(runId))
    } catch (error) {
      if ((error as { status?: number })?.status === 404) this.tracked.delete(runId)
    }
    this.publish()
  }

  /** Answer a run waiting on the owner: retry, skip or fail one step (a pause
   * that names no step is decided on the run, `stepKey` null). */
  async resume(runId: string, stepKey: string | null, action: RunDecision): Promise<RunAction> {
    const entry = this.run(runId)
    const member = this.member(entry, stepKey)
    if (!member.can.decide)
      throw new RunControlError('not_allowed', 'That does not wait for an answer from you')
    try {
      return await this.options
        .api()
        .resume(runId, { action, ...(stepKey ? { step_key: stepKey } : {}) })
    } finally {
      await this.refresh(runId, entry.launcherId)
    }
  }

  async cancel(runId: string, stepKey: string | null): Promise<RunAction> {
    const entry = this.run(runId)
    const member = this.member(entry, stepKey)
    if (!member.can.cancel) throw new RunControlError('not_allowed', 'That cannot be cancelled now')
    try {
      const api = this.options.api()
      return stepKey ? await api.cancelStep(runId, stepKey) : await api.cancel(runId)
    } finally {
      await this.refresh(runId, entry.launcherId)
    }
  }

  /** Drop an ended run from the lists. */
  dismiss(runId: string): void {
    const entry = this.run(runId)
    if (!this.member(entry, null).can.dismiss)
      throw new RunControlError('not_allowed', 'A run that is still going cannot be dismissed')
    this.dismissed[runId] = this.now()
    this.options.dismissed.write(this.dismissed)
    this.publish()
  }
}
