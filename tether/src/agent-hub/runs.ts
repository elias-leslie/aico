// Workflow runs as children of the session that launched them.
//
// A run records `launched_by`, the AICO_SESSION_ID of the session that created
// it (`st workflow create`), which is the launching session's ownership id.
// Each look asks Agent Hub, through the SDK, for one page of its newest runs and
// keeps those launched by a live session; a session Tether has not seen before
// is asked for by its id once, so an older run of it is found too. Tether reads
// the full view of every run that is active (and of an ended one once), and
// keeps the result as team members (runs-view.ts).
//
// Looks come every `pollMs` while a run is active or soon after a session's
// agent changed state (`poke`, when a run is most likely created), every
// `idleMs` otherwise, and back off up to `backoffMaxMs` while Agent Hub fails.
// Without a client id Agent Hub refuses every call, so none is made.
//
// - Active runs are read on every look, for their live phase.
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

/** A pause told to the launching session: the pause's key, when, and the
 * session and queued note it went to, so the note can be withdrawn. */
export interface ToldPause {
  key: string
  at: number
  to?: string
  note?: string
}

/** The pauses already told to the launching session (run id to the told
 * pause), kept by the caller across restarts so a pause is told once. */
export interface PauseNoticeStore {
  read(): Record<string, ToldPause>
  write(told: Record<string, ToldPause>): void
}

/** Where a pause is told to the session that launched the run. */
export interface PauseNotices {
  store: PauseNoticeStore
  /** The longest note the session takes. */
  maxChars: () => number
  /** Hand the note to the session; the queued note's id once it is queued for
   * it, false when the session cannot take one now (tried again at the next look). */
  tell(launcherId: string, notice: PauseNotice): string | false | Promise<string | false>
  /** Take back a note not yet delivered: the pause it told of is over. */
  withdraw(launcherId: string, noteId: string): void
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
  /** Why Agent Hub cannot be asked at all (no client id), else null. */
  unusable?: () => string | null
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
  private told: Record<string, ToldPause>
  private timer: ReturnType<typeof setTimeout> | null = null
  private dueAt = 0
  private lookedAt: number | null = null
  private failures = 0
  private poked = false
  /** Launcher ids already asked for by id; a new one is asked once. */
  private asked = new Set<string>()
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
    this.schedule(0)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** A session's agent changed state, the moment a run is most likely created
   * or answered: look within `pollMs` instead of the idle delay. */
  poke(): void {
    if (this.stopped || !this.timer || this.failures) return
    this.poked = true
    const at = (this.lookedAt ?? 0) + this.options.config.pollMs
    if (at < this.dueAt) this.schedule(Math.max(0, at - this.now()))
  }

  private schedule(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.dueAt = this.now() + delayMs
    this.timer = setTimeout(() => {
      void this.tick().finally(() => {
        if (!this.stopped) this.schedule(this.nextDelay())
      })
    }, delayMs)
    this.timer.unref()
  }

  /** The wait before the next look: backed off while failing, short while a
   * run is going or a session was just busy, else the idle delay. */
  nextDelay(random: () => number = Math.random): number {
    const { pollMs, idleMs, backoffMaxMs } = this.options.config
    if (this.failures) {
      const ceiling = Math.min(backoffMaxMs, pollMs * 2 ** Math.min(this.failures, 16))
      return Math.round(ceiling / 2 + (ceiling / 2) * random())
    }
    const active = [...this.tracked.values()].some((entry) => isActiveRun(entry.view.state))
    return active || this.poked ? pollMs : idleMs
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
    this.poked = false
    this.lookedAt = this.now()
    try {
      const unusable = this.options.unusable?.() ?? null
      if (unusable) {
        if (this.lastError !== unusable) this.log(`not asking Agent Hub: ${unusable}`)
        this.lastError = unusable
      } else await this.poll()
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
    // Logged when it starts failing, not on every backed-off retry.
    if (!this.failures) this.log(`look failed: ${failure.code}`)
    this.failures += 1
  }

  private async poll(): Promise<void> {
    const { api: apiOf, config } = this.options
    const api = apiOf()
    const launchers = this.options.launchers()
    const live = new Set(launchers.map((launcher) => launcher.id))
    const ownerOf = new Map<string, string>()
    for (const launcher of launchers)
      for (const ownedAs of [launcher.ownershipId, ...(launcher.alsoOwnedAs ?? [])])
        ownerOf.set(ownedAs, launcher.id)
    const listed = new Map<string, { item: RunListItem; launcherId: string }>()
    const take = (items: readonly RunListItem[]) => {
      for (const item of items) {
        const launcherId = item.launched_by ? ownerOf.get(item.launched_by) : undefined
        if (launcherId) listed.set(item.id, { item, launcherId })
      }
    }
    let failure: unknown = null

    // One page of the newest runs answers for every session at once.
    const page: RunList = await api.list({ limit: config.listLimit })
    take(page.runs)
    // A page shorter than the limit holds every run; otherwise a run older
    // than its oldest one may simply be off the page.
    const complete = page.runs.length < config.listLimit
    const oldest = Math.min(...page.runs.map((item) => parseTime(item.created_at) ?? 0))
    const offPage = (view: RunView) => !complete && (parseTime(view.created_at) ?? 0) < oldest

    // A session not seen before is asked for once by its id, for a run of it
    // that is older than the page.
    for (const ownedAs of this.asked) if (!ownerOf.has(ownedAs)) this.asked.delete(ownedAs)
    const queue = [...ownerOf.keys()].filter((ownedAs) => !this.asked.has(ownedAs))
    await Promise.all(
      Array.from({ length: Math.min(config.concurrency, queue.length) }, async () => {
        for (let ownedAs = queue.shift(); ownedAs; ownedAs = queue.shift()) {
          if (this.stopped) return
          try {
            take((await api.list({ launched_by: ownedAs, limit: config.listLimit })).runs)
            this.asked.add(ownedAs)
          } catch (error) {
            failure ??= error
          }
        }
      }),
    )
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
      if (!live.has(entry.launcherId) || offPage(entry.view)) {
        // The launcher ended, or the run is older than the page: follow it by
        // its id while it is active, and keep an ended one until it lapses.
        if (isActiveRun(entry.view.state)) read(runId, entry.launcherId)
        else if (!live.has(entry.launcherId) || !this.visible(entry.view))
          this.tracked.delete(runId)
      } else {
        // Agent Hub answered and no longer has it.
        this.tracked.delete(runId)
      }
    }
    await Promise.all(reads)
    this.pruneDismissed()
    await this.tellPauses(live)

    if (failure) this.fail(failure)
    else {
      this.lastOk = this.now()
      this.lastError = null
      this.failures = 0
    }
  }

  private accept(launcherId: string, view: RunView): void {
    const ctx = { launcherId, url: this.pageUrl(view.id) }
    this.tracked.set(view.id, { launcherId, view, members: runMembers(view, ctx) })
  }

  /** Once per pause, tell the session that launched a run waiting for the
   * owner. A run that is not waiting forgets its last pause, so the next one
   * is told again; a launcher that has ended is not told (the owner answers
   * from the expanded run). A note not yet delivered is taken back once its
   * pause is over (answered, cancelled, replaced by a new pause, or the run
   * gone from a launcher that still answers), so no stale ask arrives late. */
  private async tellPauses(live: Set<string>): Promise<void> {
    const pauses = this.options.pauses
    if (!pauses) return
    let changed = false
    const forget = (runId: string) => {
      const told = this.told[runId]
      if (!told) return
      if (told.to && told.note) {
        try {
          pauses.withdraw(told.to, told.note)
        } catch (error) {
          this.log(`could not take back a note about a paused run: ${(error as Error).message}`)
        }
      }
      delete this.told[runId]
      changed = true
    }
    for (const [runId, entry] of this.tracked) {
      const notice =
        entry.view.state === 'needs_owner' ? pauseNotice(entry.view, pauses.maxChars()) : null
      if (!notice) {
        forget(runId)
        continue
      }
      if (this.told[runId]?.key === notice.key || !live.has(entry.launcherId)) continue
      forget(runId)
      let note: string | false = false
      try {
        note = await pauses.tell(entry.launcherId, notice)
      } catch (error) {
        this.log(`could not tell the session about a paused run: ${(error as Error).message}`)
      }
      if (!note) continue
      this.told[runId] = { key: notice.key, at: this.now(), to: entry.launcherId, note }
      changed = true
    }
    // A run no longer followed whose launcher is still here has ended or was
    // dismissed: its pause is over too.
    for (const [runId, told] of Object.entries(this.told))
      if (!this.tracked.has(runId) && told.to && live.has(told.to)) forget(runId)
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
