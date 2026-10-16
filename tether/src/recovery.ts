// Crash self-recovery (docs/adr/0001-tether-owns-sessions.md, "Crash restore").
//
// A session the owner did not end can die three ways: its pane scope fails
// (an OOM kill under OOMPolicy=stop, a signal) or every process in it is
// killed at once, its agent is killed while the pane survives and falls back
// to a shell, or its tmux server dies. Tether proves which from the user
// journal (the exact scope unit and invocation), the agent's exit status and
// the pane supervisor's exit marker, keeps the agent's resume ID, and resumes the
// same session in place, with the same widget, window, origin and root
// lineage, through the reboot-restore launch path and a short synopsis prompt.
// An End deletes the row, so an ended session is never recovered.
//
// Loop protection: at most 2 automatic recoveries per session in 6 hours; the
// first waits until host admission has allowed launches for 60 s, the second
// waits at least 10 minutes after the first; a crash within 10 minutes of a
// recovery holds; an agent that was itself the memory hog twice holds; one
// recovery runs at a time. A held session keeps its pane's own status
// (running while the fallback shell is up, uncertain once the pane is gone);
// its reason is in <stateDir>/recoveries.json, which Nightshift reads to push
// the owner.

import { execFile } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { agentExitMarkerDir } from './config'
import {
  type ContinuitySnapshot,
  currentBootId,
  nodeProcFs,
  observeAgent,
  processTree,
  readJsonFile,
  UUID_RE,
  writeJsonFile,
} from './continuity'
import { HttpError, type Router, sendJson } from './http'
import {
  admissionOverrideFromEnv,
  nightshiftAdmissionPath,
  readNightshiftAdmission,
} from './lifecycle/agent-admission'
import { getWidget, listWidgets, rootRequestForWidget, type WidgetRow } from './lifecycle/catalog'
import {
  type AbandonedScope,
  ensureSessionSerialized,
  lastEnsureFailure,
  notifySessionChanged,
  type RespawnResult,
  reconcileSessionNow,
  releaseCrashedSessionBinding,
  respawnAndRelaunch,
  verifiedCurrentManagedPane,
} from './lifecycle/engine'
import { processEnvironment } from './lifecycle/procfs'
import { launchingResume, withRootPrompt } from './lifecycle/root-launch'
import { paneExitedEventPath } from './lifecycle/tmux'
import {
  AGENT_EXIT_ENV,
  type AgentExitMarker,
  isResumeSessionId,
  parseAgentExitMarker,
} from './lifecycle/tui/launch'
import { getTui } from './lifecycle/tui/registry'
import type { TuiSpec } from './lifecycle/tui/spec'
import type { LifecycleApiContext } from './lifecycle-api'
import { generationOf } from './lifecycle-api'
import {
  CRASH_RESULTS,
  type CrashFacts,
  type CrashKind,
  claudeTranscriptFacts,
  findClaudeTranscript,
  type GitState,
  kernelOomVictims,
  nodeFileReader,
  type OomVictim,
  PANE_KILLED,
  parseGitState,
  parseJournal,
  renderDetail,
  renderSynopsis,
  SERVER_LOST,
  type TranscriptFacts,
  unitOutcome,
  victimsInScope,
} from './recovery-facts'

const execFileAsync = promisify(execFile)

export const MAX_AUTO_RECOVERIES = 2
export const RECOVERY_WINDOW_MS = 6 * 3600_000
export const LOOP_WINDOW_MS = 10 * 60_000
export const ADMIT_SETTLE_MS = 60_000
const TICK_MS = 5_000
const RETRY_MS = 30_000
const GIVE_UP_MS = 15 * 60_000
const CLASSIFY_POLLS = 10
const CLASSIFY_POLL_MS = 2_000
const KEEP_MS = 24 * 3600_000
const DETAIL_KEEP_MS = 7 * 24 * 3600_000
/** Exit markers of panes no session owns any more (an End, a respawn) are
 * removed once they are this old. */
const MARKER_KEEP_MS = 10 * 60_000
const MARKER_SWEEP_MS = 3600_000
/** A resumed agent must show up in its pane within this time. */
const CONFIRM_MS = 120_000
const CONFIRM_POLL_MS = 5_000
/** systemd logs a unit's result as its last process goes, before Tether sees
 * the pane gone; a result logged later than this belongs to a later stop. */
const RESULT_GRACE_MS = 10_000
const RECONCILE_EVERY_MS = 60_000
/** Continuity observes once a minute; an agent seen running this recently was
 * still running when its tmux server died. */
const AGENT_SEEN_FRESH_MS = 150_000
/** Exit statuses of an agent killed by SIGKILL (an OOM kill) or a crash
 * signal (SIGILL, SIGABRT, SIGBUS, SIGFPE, SIGSEGV). SIGHUP, SIGINT and
 * SIGTERM are how people and services stop an agent on purpose. */
const CRASH_EXIT_STATUSES: ReadonlySet<number> = new Set([132, 134, 135, 136, 137, 139])

export type RecoveryState = 'waiting' | 'recovering' | 'recovered' | 'held'

export interface CrashRecord {
  id: string
  name: string | null
  tool: string
  origin: string
  state: RecoveryState
  kind: CrashKind
  cause: string
  signal: number | null
  victim: Pick<OomVictim, 'pid' | 'comm' | 'rssBytes' | 'constraint'> | null
  agentWasHog: boolean
  diedAt: number
  /** Only the time Tether noticed the death is known (up to a minute late). */
  diedAtApprox?: boolean
  detectedAt: number
  bootId: string
  scopeUnit: string | null
  scopeInvocationId: string | null
  resumeId: string | null
  attempt: number
  notBefore: number
  firstTryAt: number | null
  /** When the resume was launched; set before Tether confirms it started. */
  launchedAt?: number | null
  recoveredAt: number | null
  reason: string | null
  detailFile: string | null
  manual: boolean
}

export interface RecoveryAttempt {
  id: string
  diedAt: number
  recoveredAt: number
  agentWasHog: boolean
  /** The owner asked for it; counts for the 10-minute rule only. */
  manual?: boolean
}

interface RecoveryFile {
  v: 1
  updatedAt: number
  records: CrashRecord[]
  history: RecoveryAttempt[]
  /** Pane scope invocation whose fallback shell still says the agent was
   * killed, though that crash was settled (the owner restarted the agent by
   * hand); never recorded again. */
  dismissed?: Record<string, string>
}

export type RecoveryDecision = { hold: string } | { notBefore: number; attempt: number }

/** Loop protection for one new crash of a session, given its earlier
 * automatic recoveries. */
export function decideRecovery(
  history: RecoveryAttempt[],
  crash: { diedAt: number; agentWasHog: boolean },
  now: number,
): RecoveryDecision {
  const recent = history.filter((attempt) => now - attempt.recoveredAt < RECOVERY_WINDOW_MS)
  const automatic = recent.filter((attempt) => !attempt.manual)
  const last = recent.reduce((max, attempt) => Math.max(max, attempt.recoveredAt), 0)
  if (last && crash.diedAt - last < LOOP_WINDOW_MS)
    return { hold: 'it crashed again within 10 minutes of being recovered' }
  if (automatic.length >= MAX_AUTO_RECOVERIES)
    return { hold: 'it was already recovered automatically twice in the last 6 hours' }
  if (crash.agentWasHog && recent.some((attempt) => attempt.agentWasHog))
    return { hold: 'its own process was the memory hog again' }
  return {
    notBefore: Math.max(now + ADMIT_SETTLE_MS, last ? last + LOOP_WINDOW_MS : 0),
    attempt: automatic.length + 1,
  }
}

/** An agent process found in a pane; `resumeId` is null until it has a
 * resumable conversation. */
export interface AgentSeen {
  pid: number
  resumeId: string | null
}

/** What recovery needs from the lifecycle engine and /proc; tests replace it. */
export interface RecoveryEngine {
  /** The session's live, verified pane, if it has one. */
  currentPane(row: WidgetRow): Promise<{ pid: number } | null>
  /** The agent running under a pane, if any. */
  agentIn(panePid: number, tool: string): AgentSeen | null
  /** The agent exit status the pane's fallback shell was given, if any. */
  agentExit(panePid: number): number | null
  reconcile(id: string): Promise<void>
  release(id: string): Promise<'released' | 'busy' | 'refused'>
  ensure(id: string): Promise<boolean>
  respawn(id: string, tool: TuiSpec | undefined): Promise<RespawnResult>
  lastFailure(id: string): { code: string; reason: string } | undefined
  notify(id: string): void
  /** When the tmux server's pane-exited hook last fired (epoch ms). */
  paneExitedAt(serverId: string): number | null
  /** Sessions running an agent now, with the conversation each one holds. */
  runningConversations(): Promise<{ id: string; resumeId: string | null }[]>
  /** What the pane supervisor recorded for this pane scope, and when. */
  agentExitMarker(scopeUnit: string): { marker: AgentExitMarker; at: number } | null
  /** Exit marker files: scope unit name and last write. */
  agentExitMarkers(): { scopeUnit: string; at: number }[]
  removeAgentExitMarker(scopeUnit: string): void
}

export interface RecoveryOptions {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  log?: (message: string) => void
  /** Sessions reboot continuity is restoring; recovery leaves them alone. */
  awaitingRestore?: (id: string) => boolean
  run?: (command: string, args: string[], timeoutMs: number) => Promise<string | null>
  engine?: Partial<RecoveryEngine>
}

function agentInPane(home: string, panePid: number, tool: string): AgentSeen | null {
  const observed = observeAgent(nodeProcFs, home, panePid)
  if (observed) return { pid: observed.pid, resumeId: observed.resumeId }
  // An agent that has no conversation yet still counts as running.
  const name = getTui(tool)?.processName
  if (!name) return null
  for (const pid of processTree(nodeProcFs, panePid)) {
    if (pid === panePid) continue
    try {
      if (nodeProcFs.readFile(`/proc/${pid}/comm`).trim() === name) return { pid, resumeId: null }
    } catch {
      // exited meanwhile
    }
  }
  return null
}

const SCOPE_NAME_RE = /^tmux-spawn-[0-9A-Za-z-]{1,64}\.scope$/

function defaultEngine(home: string, stateDir: string, markerDir: string): RecoveryEngine {
  const markerPath = (scopeUnit: string) =>
    SCOPE_NAME_RE.test(scopeUnit) ? join(markerDir, scopeUnit) : null
  return {
    currentPane: (row) => verifiedCurrentManagedPane(row),
    agentIn: (panePid, tool) => agentInPane(home, panePid, tool),
    agentExit: (panePid) => {
      const raw = processEnvironment(panePid)?.get(AGENT_EXIT_ENV)
      return raw !== undefined && /^[0-9]{1,3}$/.test(raw) ? Number(raw) : null
    },
    reconcile: (id) => reconcileSessionNow(id),
    release: (id) => releaseCrashedSessionBinding(id),
    ensure: (id) => ensureSessionSerialized(id, { cols: 100, rows: 30 }),
    respawn: (id, tool) => respawnAndRelaunch(id, tool, { initialLaunch: true }),
    lastFailure: (id) => lastEnsureFailure(id),
    notify: (id) => notifySessionChanged(id, { force: true }),
    paneExitedAt: (serverId) => {
      try {
        return statSync(paneExitedEventPath(serverId)).mtimeMs
      } catch {
        return null
      }
    },
    // Without the continuity observer, the last snapshot (up to a minute old).
    runningConversations: async () =>
      (readJsonFile<ContinuitySnapshot>(join(stateDir, 'continuity.json'))?.sessions ?? []).map(
        (session) => ({ id: session.id, resumeId: session.resumeId }),
      ),
    agentExitMarker: (scopeUnit) => {
      const path = markerPath(scopeUnit)
      if (!path) return null
      try {
        const marker = parseAgentExitMarker(readFileSync(path, 'utf8'))
        return marker ? { marker, at: statSync(path).mtimeMs } : null
      } catch {
        return null
      }
    },
    agentExitMarkers: () => {
      const out: { scopeUnit: string; at: number }[] = []
      let names: string[] = []
      try {
        names = readdirSync(markerDir)
      } catch {
        return out
      }
      for (const name of names) {
        if (!SCOPE_NAME_RE.test(name)) continue
        try {
          out.push({ scopeUnit: name, at: statSync(join(markerDir, name)).mtimeMs })
        } catch {
          // gone meanwhile
        }
      }
      return out
    },
    removeAgentExitMarker: (scopeUnit) => {
      const path = markerPath(scopeUnit)
      try {
        if (path) unlinkSync(path)
      } catch {
        // already gone
      }
    },
  }
}

async function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
    })
    return stdout
  } catch {
    return null
  }
}

const ACTIVE: ReadonlySet<RecoveryState> = new Set(['waiting', 'recovering', 'held'])

export class Recovery {
  private readonly path: string
  private readonly recoveryDir: string
  private readonly home: string
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly log: (message: string) => void
  private readonly awaitingRestore: (id: string) => boolean
  private readonly run: (
    command: string,
    args: string[],
    timeoutMs: number,
  ) => Promise<string | null>
  private readonly engine: RecoveryEngine
  private records = new Map<string, CrashRecord>()
  private history: RecoveryAttempt[] = []
  private dismissed: Record<string, string> = {}
  /** Transcript facts per crash, read once and reused across retries. */
  private readonly transcripts = new Map<string, TranscriptFacts | null>()
  /** Abandoned scopes whose journal outcome is still being read. */
  private readonly classifying = new Set<string>()
  /** Last agent pid seen per session, to tell whether the OOM victim was the agent. */
  private readonly agentPids = new Map<string, number>()
  private readonly agentSeenAt = new Map<string, number>()
  private readonly lastReconcile = new Map<string, number>()
  private admitSince: number | null = null
  private lastMarkerSweep = 0
  private timer: NodeJS.Timeout | null = null
  private busy = false

  constructor(
    private readonly context: LifecycleApiContext,
    options: RecoveryOptions = {},
  ) {
    this.path = join(context.paths.stateDir, 'recoveries.json')
    this.recoveryDir = join(context.paths.stateDir, 'recovery')
    this.home = process.env.HOME ?? homedir()
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.log = options.log ?? ((message) => console.log(`[tether:recovery] ${message}`))
    this.awaitingRestore = options.awaitingRestore ?? (() => false)
    this.run = options.run ?? runCommand
    this.engine = {
      ...defaultEngine(this.home, context.paths.stateDir, agentExitMarkerDir(context.paths)),
      ...options.engine,
    }
    this.load()
  }

  start(): void {
    this.timer = setInterval(() => void this.tick().catch(() => {}), TICK_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  // --- state ------------------------------------------------------------------

  private load(): void {
    const file = readJsonFile<RecoveryFile>(this.path)
    const boot = currentBootId()
    // Records from an earlier boot belong to reboot continuity, not here.
    for (const record of file?.records ?? [])
      if (record.bootId === boot) this.records.set(record.id, record)
    this.history = file?.history ?? []
    this.dismissed = { ...(file?.dismissed ?? {}) }
    for (const record of this.records.values())
      if (record.state === 'recovering') record.state = 'waiting'
    this.prune()
    this.removeOldDetailFiles()
    this.sweepExitMarkers()
  }

  /** Remove exit markers of pane scopes no session owns any more. */
  private sweepExitMarkers(): void {
    const now = this.now()
    this.lastMarkerSweep = now
    const owned = new Set<string>()
    for (const row of listWidgets()) {
      if (row.scopeUnit) owned.add(row.scopeUnit)
      if (row.pendingScopeUnit) owned.add(row.pendingScopeUnit)
    }
    for (const { scopeUnit, at } of this.engine.agentExitMarkers())
      if (!owned.has(scopeUnit) && now - at > MARKER_KEEP_MS)
        this.engine.removeAgentExitMarker(scopeUnit)
  }

  private removeOldDetailFiles(): void {
    let names: string[] = []
    try {
      names = readdirSync(this.recoveryDir)
    } catch {
      return
    }
    for (const name of names) {
      const path = join(this.recoveryDir, name)
      try {
        if (name.endsWith('.md') && this.now() - statSync(path).mtimeMs > DETAIL_KEEP_MS)
          unlinkSync(path)
      } catch {
        // gone meanwhile
      }
    }
  }

  private prune(): void {
    const now = this.now()
    for (const [id, record] of this.records) {
      // End deletes the row: an ended session is never recovered.
      if (!getWidget(id)) this.records.delete(id)
      else if (
        !ACTIVE.has(record.state) &&
        now - (record.recoveredAt ?? record.detectedAt) > KEEP_MS
      )
        this.records.delete(id)
    }
    this.history = this.history.filter(
      (attempt) => now - attempt.recoveredAt < RECOVERY_WINDOW_MS && getWidget(attempt.id),
    )
    for (const [id, invocation] of Object.entries(this.dismissed))
      if (getWidget(id)?.scopeInvocationId !== invocation) delete this.dismissed[id]
  }

  private save(): void {
    this.prune()
    mkdirSync(this.context.paths.stateDir, { recursive: true, mode: 0o700 })
    writeJsonFile(this.path, {
      v: 1,
      updatedAt: this.now(),
      records: [...this.records.values()],
      history: this.history,
      dismissed: this.dismissed,
    } satisfies RecoveryFile)
  }

  private update(record: CrashRecord, changes: Partial<CrashRecord>): void {
    Object.assign(record, changes)
    this.records.set(record.id, record)
    this.save()
    this.engine.notify(record.id)
  }

  /** Forget a crash record that no longer needs recovering. A fallback shell
   * still holding the killed agent's exit status is never recorded again. */
  private drop(record: CrashRecord, why: string, dismissInvocation: string | null = null): void {
    this.log(`${record.id}: recovery dropped: ${why}`)
    this.records.delete(record.id)
    this.transcripts.delete(`${record.id}:${record.diedAt}`)
    if (dismissInvocation) this.dismissed[record.id] = dismissInvocation
    this.save()
    this.engine.notify(record.id)
  }

  /** Continuity keeps this session's saved conversation: it is being
   * classified or has a crash record still waiting, recovering or held. */
  retains(id: string): boolean {
    if (this.classifying.has(id)) return true
    const record = this.records.get(id)
    return Boolean(record && ACTIVE.has(record.state))
  }

  /** A fresh start of this session must wait for crash recovery's resume. */
  holdsLaunch(id: string): boolean {
    return this.retains(id)
  }

  /** The session whose pending or held recovery owns this conversation, if any:
   * a second agent must not resume it elsewhere. */
  resumeOwner(resumeId: string): string | null {
    for (const record of this.records.values())
      if (ACTIVE.has(record.state) && record.resumeId === resumeId) return record.id
    // A session whose death is still being read keeps its conversation too.
    for (const id of this.classifying) if (this.resumeIdFor(id) === resumeId) return id
    return null
  }

  status(): Record<string, unknown> {
    this.prune()
    return {
      v: 1,
      boot_id: currentBootId(),
      updated_at: this.now(),
      max_attempts: MAX_AUTO_RECOVERIES,
      window_hours: RECOVERY_WINDOW_MS / 3600_000,
      sessions: [...this.records.values()].map((record) => ({
        id: record.id,
        name: getWidget(record.id)?.name ?? record.name,
        tool: record.tool,
        origin: record.origin,
        root_request_id: rootRequestForWidget(record.id)?.requestId ?? null,
        coordinator_id: getWidget(record.id)?.coordinatorId ?? null,
        state: record.state,
        kind: record.kind,
        cause: record.cause,
        signal: record.signal,
        agent_was_hog: record.agentWasHog,
        victim: record.victim
          ? {
              pid: record.victim.pid,
              comm: record.victim.comm,
              rss_bytes: record.victim.rssBytes,
              constraint: record.victim.constraint,
            }
          : null,
        died_at: record.diedAt,
        died_at_approx: Boolean(record.diedAtApprox),
        detected_at: record.detectedAt,
        recovered_at: record.recoveredAt,
        attempt: record.attempt,
        not_before: record.state === 'waiting' ? record.notBefore : null,
        reason: record.reason,
        detail_file: record.detailFile,
        resumable: Boolean(record.resumeId),
        resume_command: record.state === 'held' ? `tether recovery resume ${record.id}` : null,
      })),
    }
  }

  /** Owner request: try a held session again now, outside the loop limits. */
  resumeHeld(id: string): CrashRecord | null {
    const record = this.records.get(id)
    if (!record || record.state !== 'held') return null
    this.update(record, {
      state: 'waiting',
      manual: true,
      notBefore: this.now(),
      firstTryAt: null,
      launchedAt: null,
      reason: null,
    })
    return record
  }

  // --- detection ----------------------------------------------------------------

  /** Engine hook: a session's pane scope is gone. Settles once the death is
   * classified; the engine does not wait for it. */
  onAbandoned(event: AbandonedScope): Promise<void> {
    if (event.startup || this.awaitingRestore(event.widgetId)) return Promise.resolve()
    if (this.retains(event.widgetId)) return Promise.resolve()
    this.classifying.add(event.widgetId)
    return this.classify(event)
      .catch((error) => this.log(`classify ${event.widgetId} failed: ${(error as Error).message}`))
      .finally(() => {
        this.classifying.delete(event.widgetId)
        this.engine.removeAgentExitMarker(event.scopeUnit)
      })
  }

  private async journalUnit(unit: string, invocationId: string | null, until: number | null) {
    const text = await this.run(
      'journalctl',
      ['--user', '-b', '-o', 'json', '--no-pager', `USER_UNIT=${unit}`],
      10_000,
    )
    return unitOutcome(parseJournal(text ?? ''), unit, invocationId, until)
  }

  /** The host is shutting down or the user is logging out: units stop on
   * purpose and nothing that ends is a crash. */
  private async hostStopping(): Promise<boolean> {
    for (const scope of [[], ['--user']]) {
      const state = await this.run(
        'systemctl',
        [...scope, 'show', '--property=SystemState', '--value'],
        5_000,
      )
      if (state?.trim() === 'stopping') return true
    }
    return false
  }

  private async kernelVictims(since: number, until: number): Promise<OomVictim[]> {
    const text = await this.run(
      'journalctl',
      [
        '-k',
        '-b',
        '-o',
        'json',
        '--no-pager',
        `--since=@${Math.floor(since / 1000)}`,
        `--until=@${Math.ceil(until / 1000)}`,
      ],
      10_000,
    )
    return kernelOomVictims(parseJournal(text ?? ''))
  }

  private async classify(event: AbandonedScope): Promise<void> {
    const seenAt = this.agentSeenAt.get(event.widgetId)
    this.agentSeenAt.delete(event.widgetId)
    if (await this.hostStopping()) {
      this.log(`${event.widgetId}: pane ended while the host or user session is stopping`)
      return
    }
    const until = event.at + RESULT_GRACE_MS
    let pane = await this.journalUnit(event.scopeUnit, event.scopeInvocationId, until)
    let server =
      event.serverDead && event.serverUnit
        ? await this.journalUnit(event.serverUnit, event.serverInvocationId, until)
        : null
    // systemd logs the unit result a moment after the pane disappears.
    for (let poll = 1; poll < CLASSIFY_POLLS && !pane.result && !server?.result; poll += 1) {
      await this.sleep(CLASSIFY_POLL_MS)
      pane = await this.journalUnit(event.scopeUnit, event.scopeInvocationId, until)
      if (event.serverDead && event.serverUnit)
        server = await this.journalUnit(event.serverUnit, event.serverInvocationId, until)
    }
    const kernel = await this.kernelVictims(event.at - LOOP_WINDOW_MS, this.now())
    const victim = victimsInScope(kernel, event.scopeUnit).at(-1) ?? null
    const serverVictim =
      event.serverDead && event.serverUnit
        ? (victimsInScope(kernel, event.serverUnit).at(-1) ?? null)
        : null
    // A SIGKILL of the whole scope leaves systemd an empty scope and no
    // failure result. The pane supervisor writes the agent's exit before
    // anything else in the pane can end, so a marker still saying `started`
    // means the agent never got to exit. A pane from before the marker
    // counts when systemd itself logged sending SIGKILL to the scope before
    // Tether saw it go (Tether's own cleanup comes later and uses cgroup.kill).
    const marker = this.engine.agentExitMarker(event.scopeUnit)?.marker ?? null
    const sigkillAt =
      pane.kills.find((kill) => kill.signal === 'SIGKILL' && kill.at <= event.at)?.at ?? null
    const killedRunning =
      pane.result === null &&
      (marker?.state === 'started' || (marker === null && sigkillAt !== null))
    let serverCrash = server?.result && CRASH_RESULTS.has(server.result) ? server.result : null
    if (!serverCrash && serverVictim) serverCrash = 'oom-kill'
    else if (
      !serverCrash &&
      event.serverDead &&
      seenAt &&
      event.at - seenAt <= AGENT_SEEN_FRESH_MS &&
      !this.paneExitedSince(event.tmuxServerId, seenAt)
    )
      serverCrash = SERVER_LOST
    let paneCrash = pane.result && CRASH_RESULTS.has(pane.result) ? pane.result : null
    // The pane was killed first; a tmux server that then exited empty is a
    // consequence, not the cause.
    if (!paneCrash && killedRunning) paneCrash = PANE_KILLED
    if (!paneCrash && !serverCrash) {
      this.log(`${event.widgetId}: pane ${event.scopeUnit} ended without a failure; not recovering`)
      return
    }
    const exactDeath =
      victim?.at ??
      serverVictim?.at ??
      pane.at ??
      server?.at ??
      (paneCrash === PANE_KILLED ? (sigkillAt ?? pane.endedAt) : null) ??
      (serverCrash === SERVER_LOST ? (server?.endedAt ?? pane.endedAt) : null)
    await this.recordCrash({
      id: event.widgetId,
      kind: serverCrash && !paneCrash ? 'server-died' : 'pane-stopped',
      cause: paneCrash ?? (serverCrash as string),
      signal: paneCrash === PANE_KILLED ? 9 : null,
      victim: victim ?? serverVictim,
      diedAt: exactDeath ?? event.at,
      diedAtApprox: exactDeath === null,
      scopeUnit: event.scopeUnit,
      scopeInvocationId: event.scopeInvocationId,
    })
  }

  /** A pane on this server exited normally after `since`. tmux's pane-exited
   * hook runs for a pane that ends (an owner `exit`), not for a killed
   * server, so the server ending right after it is an exit, not a crash. */
  private paneExitedSince(serverId: string | null, since: number): boolean {
    const at = serverId ? this.engine.paneExitedAt(serverId) : null
    return at !== null && at >= since
  }

  /** Continuity observer hook, once per pass for each agent session. */
  async inspect(
    row: WidgetRow,
    status: string,
    panePid: number | null,
    agentPid: number | null,
  ): Promise<void> {
    if (agentPid !== null) {
      this.agentPids.set(row.id, agentPid)
      this.agentSeenAt.set(row.id, this.now())
      // The agent is running again (the owner restarted it by hand): a crash
      // record that never launched anything has nothing left to do.
      const record = this.records.get(row.id)
      if (record && (record.state === 'held' || (record.state === 'waiting' && !record.launchedAt)))
        this.drop(record, 'its agent is running again', row.scopeInvocationId)
      return
    }
    if (status !== 'running') {
      // A tmux server that died while Tether kept running leaves no pane-exit
      // event; reconciling notices it and reports the abandoned scope.
      const last = this.lastReconcile.get(row.id) ?? 0
      if (
        row.scopeUnit &&
        row.launchState === 'dispatched' &&
        this.now() - last >= RECONCILE_EVERY_MS
      ) {
        this.lastReconcile.set(row.id, this.now())
        await this.engine.reconcile(row.id).catch(() => {})
      }
      return
    }
    this.agentSeenAt.delete(row.id)
    if (panePid === null || this.retains(row.id) || this.awaitingRestore(row.id)) return
    if (row.scopeInvocationId && this.dismissed[row.id] === row.scopeInvocationId) return
    const exit = this.engine.agentExit(panePid)
    if (exit === null || !CRASH_EXIT_STATUSES.has(exit)) return
    const existing = this.records.get(row.id)
    if (existing?.kind === 'agent-exited' && existing.scopeInvocationId === row.scopeInvocationId)
      return
    const now = this.now()
    const victims = row.scopeUnit
      ? victimsInScope(await this.kernelVictims(now - LOOP_WINDOW_MS, now), row.scopeUnit)
      : []
    const agentPid_ = this.agentPids.get(row.id)
    const processName = getTui(row.tool)?.processName ?? ''
    const victim =
      victims.find((v) => v.pid === agentPid_) ??
      (agentPid_ === undefined ? victims.find((v) => v.comm === processName) : undefined) ??
      null
    // The supervisor wrote this exit status as the agent ended.
    const marker = row.scopeUnit ? this.engine.agentExitMarker(row.scopeUnit) : null
    const exitAt =
      marker?.marker.state === 'exit' && marker.marker.status === exit ? marker.at : null
    const exactDeath = victim?.at ?? exitAt
    await this.recordCrash({
      id: row.id,
      kind: 'agent-exited',
      cause: exit === 137 && victim ? 'oom-kill' : 'signal',
      signal: exit - 128,
      victim,
      agentWasHog: victim !== null,
      diedAt: exactDeath ?? now,
      diedAtApprox: exactDeath === null,
      scopeUnit: row.scopeUnit,
      scopeInvocationId: row.scopeInvocationId,
    })
  }

  private resumeIdFor(id: string): string | null {
    const snapshot = readJsonFile<ContinuitySnapshot>(
      join(this.context.paths.stateDir, 'continuity.json'),
    )
    const resumeId = snapshot?.sessions?.find((session) => session.id === id)?.resumeId ?? null
    return typeof resumeId === 'string' && UUID_RE.test(resumeId) ? resumeId : null
  }

  private async recordCrash(crash: {
    id: string
    kind: CrashKind
    cause: string
    signal: number | null
    victim: OomVictim | null
    agentWasHog?: boolean
    diedAt: number
    diedAtApprox?: boolean
    scopeUnit: string | null
    scopeInvocationId: string | null
  }): Promise<void> {
    const row = getWidget(crash.id)
    if (!row) return
    const now = this.now()
    const agentPid = this.agentPids.get(crash.id)
    const processName = getTui(row.tool)?.processName ?? ''
    const agentWasHog =
      crash.agentWasHog ??
      Boolean(
        crash.victim &&
          (agentPid !== undefined
            ? crash.victim.pid === agentPid
            : processName && crash.victim.comm === processName),
      )
    const decision = decideRecovery(
      this.history.filter((attempt) => attempt.id === crash.id),
      { diedAt: crash.diedAt, agentWasHog },
      now,
    )
    const resumeId = this.resumeIdFor(crash.id)
    const record: CrashRecord = {
      id: crash.id,
      name: row.name,
      tool: row.tool,
      origin: row.origin,
      state: 'hold' in decision || !resumeId ? 'held' : 'waiting',
      kind: crash.kind,
      cause: crash.cause,
      signal: crash.signal,
      victim: crash.victim
        ? {
            pid: crash.victim.pid,
            comm: crash.victim.comm,
            rssBytes: crash.victim.rssBytes,
            constraint: crash.victim.constraint,
          }
        : null,
      agentWasHog,
      diedAt: crash.diedAt,
      ...(crash.diedAtApprox ? { diedAtApprox: true } : {}),
      detectedAt: now,
      bootId: currentBootId(),
      scopeUnit: crash.scopeUnit,
      scopeInvocationId: crash.scopeInvocationId,
      resumeId,
      attempt: 'attempt' in decision ? decision.attempt : 0,
      notBefore: 'notBefore' in decision ? decision.notBefore : now,
      firstTryAt: null,
      recoveredAt: null,
      reason:
        'hold' in decision
          ? decision.hold
          : resumeId
            ? null
            : 'no saved conversation was seen for it, so there is nothing to resume',
      detailFile: null,
      manual: false,
    }
    this.update(record, {})
    this.log(
      `${crash.id}: ${crash.kind} (${crash.cause}${crash.victim ? `, kernel killed ${crash.victim.comm} pid ${crash.victim.pid}` : ''}); ` +
        (record.state === 'held'
          ? `held: ${record.reason}`
          : `recovery ${record.attempt} of ${MAX_AUTO_RECOVERIES} queued`),
    )
  }

  // --- recovery -----------------------------------------------------------------

  private async admissionSettled(now: number): Promise<boolean> {
    let override = false
    try {
      override = admissionOverrideFromEnv()
    } catch {
      // malformed override: launches use the normal verdict
    }
    const verdict = override ? null : await readNightshiftAdmission(nightshiftAdmissionPath(), now)
    if (verdict && !verdict.admit) this.admitSince = null
    else if (this.admitSince === null) this.admitSince = now
    return this.admitSince !== null && now - this.admitSince >= ADMIT_SETTLE_MS
  }

  /** One serialized step: recover the earliest due session, if any. */
  async tick(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      const now = this.now()
      if (now - this.lastMarkerSweep >= MARKER_SWEEP_MS) this.sweepExitMarkers()
      const settled = await this.admissionSettled(now)
      const due = [...this.records.values()]
        .filter((record) => record.state === 'waiting' && record.notBefore <= now)
        .sort((a, b) => a.notBefore - b.notBefore)[0]
      if (!due) return
      if (!settled && !due.manual) {
        const reason = 'waiting until host memory has allowed agent launches for a minute'
        if (due.reason !== reason) this.update(due, { reason })
        return
      }
      await this.recoverOne(due)
    } finally {
      this.busy = false
    }
  }

  private async gather(record: CrashRecord, row: WidgetRow, resumedAt: number) {
    const unitLines: string[] = []
    if (record.scopeUnit)
      unitLines.push(
        ...(await this.journalUnit(record.scopeUnit, record.scopeInvocationId, null)).lines,
      )
    const kernel = record.scopeUnit
      ? victimsInScope(
          await this.kernelVictims(record.diedAt - LOOP_WINDOW_MS, record.diedAt + 60_000),
          record.scopeUnit,
        )
      : []
    const victim = kernel.find((v) => v.pid === record.victim?.pid) ?? kernel.at(-1) ?? null
    const memctl = parseJournal(
      (await this.run(
        'journalctl',
        [
          '--user',
          '-u',
          'nightshift-memctl.service',
          '-o',
          'json',
          '--no-pager',
          `--since=@${Math.floor((record.diedAt - 15 * 60_000) / 1000)}`,
          `--until=@${Math.ceil((record.diedAt + 60_000) / 1000)}`,
        ],
        10_000,
      )) ?? '',
    )
      .map((entry) => (typeof entry.MESSAGE === 'string' ? entry.MESSAGE : ''))
      .filter(Boolean)
      .slice(-60)
    const events = record.scopeUnit
      ? await this.run(
          'nightshift',
          ['memory', 'events', '--scope', record.scopeUnit, '--json'],
          5_000,
        )
      : null
    let git: GitState | null = null
    if (row.projectRoot) {
      const log = await this.run(
        'git',
        ['-C', row.projectRoot, 'log', '-1', '--format=%h%x09%ct%x09%s'],
        5_000,
      )
      const status = await this.run('git', ['-C', row.projectRoot, 'status', '--porcelain'], 10_000)
      if (log !== null && status !== null) git = parseGitState(log, status)
    }
    const prefix = record.resumeId?.slice(0, 6)
    const leases = prefix
      ? ((await this.run('st', ['lease', '--list', '--all'], 8_000)) ?? '')
          .split('\n')
          .filter((line) => line.includes(`:${prefix} `) || line.includes(`:${prefix})`))
          .slice(0, 40)
      : []
    const key = `${record.id}:${record.diedAt}`
    if (!this.transcripts.has(key)) {
      let facts: TranscriptFacts | null = null
      if (record.resumeId && getTui(row.tool)?.slug === 'claude-code') {
        const path = findClaudeTranscript(nodeFileReader, this.home, record.resumeId)
        if (path)
          facts = claudeTranscriptFacts(
            nodeFileReader,
            path,
            record.diedAt,
            process.getuid?.() ?? 1000,
          )
      }
      this.transcripts.set(key, facts)
    }
    const transcript = this.transcripts.get(key) ?? null
    const detailFile = join(
      this.recoveryDir,
      `${row.id}-${new Date(record.diedAt).toISOString().replace(/[:.]/g, '-')}.md`,
    )
    const facts: CrashFacts = {
      kind: record.kind,
      cause: record.cause,
      signal: record.signal,
      victim,
      agentWasHog: record.agentWasHog,
      diedAt: record.diedAt,
      diedAtApprox: Boolean(record.diedAtApprox),
      resumedAt,
      attempt: record.attempt,
      manual: Boolean(record.manual),
      maxAttempts: MAX_AUTO_RECOVERIES,
      detailFile,
      git,
      transcript,
      leases,
    }
    const synopsis = renderSynopsis(facts)
    const detail = renderDetail(facts, {
      synopsis,
      unitLines,
      kernelLines: kernel.flatMap((v) => v.lines),
      memctlLines: memctl,
      memoryEvents: events ? events.slice(0, 16_000) : null,
      leases,
    })
    return { synopsis, detail, detailFile }
  }

  private async recoverOne(record: CrashRecord): Promise<void> {
    const row = getWidget(record.id)
    if (!row) {
      this.records.delete(record.id)
      this.save()
      return
    }
    if (row.tool !== record.tool) {
      this.drop(record, 'its tool changed')
      return
    }
    const tool = getTui(row.tool)
    if (!record.resumeId || !isResumeSessionId(tool, record.resumeId)) {
      this.update(record, { state: 'held', reason: 'its saved conversation ID is not resumable' })
      return
    }
    const now = this.now()
    if (record.firstTryAt !== null && now - record.firstTryAt > GIVE_UP_MS) {
      this.update(record, {
        state: 'held',
        reason: 'host admission refused the relaunch for 15 minutes',
      })
      return
    }
    const pane = await this.engine.currentPane(row).catch(() => null)
    const agent = pane ? this.engine.agentIn(pane.pid, row.tool) : null
    if (agent) {
      // Tether restarted after launching the resume, and it is running.
      if (record.launchedAt && agent.resumeId === record.resumeId) this.finish(record, row)
      // Or the owner restarted the agent by hand: never start a second one.
      else this.drop(record, 'its agent is running again', row.scopeInvocationId)
      return
    }
    const elsewhere = await this.conversationElsewhere(record)
    // The observer pass that answered may have settled the record meanwhile.
    if (this.records.get(record.id) !== record) return
    if (elsewhere) {
      this.drop(
        record,
        `session ${elsewhere} is already running conversation ${record.resumeId}`,
        pane ? row.scopeInvocationId : null,
      )
      return
    }
    this.update(record, { state: 'recovering', firstTryAt: record.firstTryAt ?? now })
    const { synopsis, detail, detailFile } = await this.gather(record, row, now)
    mkdirSync(this.recoveryDir, { recursive: true, mode: 0o700 })
    await writeFile(detailFile, detail, { mode: 0o600 })
    record.detailFile = detailFile
    let outcome: LaunchOutcome
    try {
      outcome = await this.launch(record, row, synopsis, pane !== null)
    } catch (error) {
      outcome = { kind: 'failed', reason: (error as Error).message }
    }
    if (outcome.kind === 'retry') {
      this.update(record, {
        state: 'waiting',
        notBefore: this.now() + RETRY_MS,
        reason: outcome.reason,
      })
      return
    }
    if (outcome.kind === 'failed') {
      this.update(record, { state: 'held', reason: `the relaunch failed: ${outcome.reason}` })
      this.log(`${row.id}: held: ${outcome.reason}`)
      return
    }
    this.update(record, { launchedAt: this.now() })
    if (!(await this.confirm(record))) {
      if (!getWidget(row.id)) return
      this.update(record, {
        state: 'held',
        reason:
          'the resume did not start: no agent with its conversation appeared within 2 minutes',
      })
      this.log(`${row.id}: held: the resumed agent did not appear`)
      return
    }
    this.finish(record, getWidget(row.id) ?? row)
  }

  private finish(record: CrashRecord, row: WidgetRow): void {
    const recoveredAt = this.now()
    this.history.push({
      id: row.id,
      diedAt: record.diedAt,
      recoveredAt,
      agentWasHog: record.agentWasHog,
      ...(record.manual ? { manual: true } : {}),
    })
    this.transcripts.delete(`${record.id}:${record.diedAt}`)
    this.update(record, { state: 'recovered', recoveredAt, reason: null })
    this.log(`${row.id}: resumed in place (attempt ${record.attempt})`)
    if (this.context.gui.connected())
      void this.context.gui.send({ kind: 'show', sessionId: row.id, generation: generationOf(row) })
  }

  /** Another session that is resuming or running this conversation now. */
  private async conversationElsewhere(record: CrashRecord): Promise<string | null> {
    const resumeId = record.resumeId as string
    const launching = launchingResume(resumeId, record.id)
    if (launching) return launching
    const running = await this.engine.runningConversations().catch(() => [])
    return running.find((s) => s.id !== record.id && s.resumeId === resumeId)?.id ?? null
  }

  /** The resumed agent shows up in the session's pane with its conversation. */
  private async confirm(record: CrashRecord): Promise<boolean> {
    const deadline = this.now() + CONFIRM_MS
    for (;;) {
      const row = getWidget(record.id)
      if (!row) return false
      const pane = await this.engine.currentPane(row).catch(() => null)
      if (pane && this.engine.agentIn(pane.pid, row.tool)?.resumeId === record.resumeId) return true
      if (this.now() >= deadline) return false
      await this.sleep(CONFIRM_POLL_MS)
    }
  }

  private async launch(
    record: CrashRecord,
    row: WidgetRow,
    prompt: string,
    panePresent: boolean,
  ): Promise<LaunchOutcome> {
    const resumeId = record.resumeId as string
    if (panePresent) {
      // The pane survived (the agent died, or a resume fell back to the
      // shell): respawn it with the resume.
      const result = await withRootPrompt(
        row.id,
        prompt,
        () => this.engine.respawn(row.id, getTui(row.tool)),
        resumeId,
      )
      if (result.status === 'replaced') return { kind: 'launched' }
      if (result.status === 'admission_denied')
        return { kind: 'retry', reason: `host admission deferred the relaunch: ${result.reason}` }
      if (result.status === 'busy')
        return { kind: 'retry', reason: 'another operation on the session was in progress' }
      return { kind: 'failed', reason: 'reason' in result ? result.reason : result.status }
    }
    // Releasing the crashed binding makes the row startable; host admission
    // refusals are retried against the same released row.
    const released = await this.engine.release(row.id)
    if (released === 'busy')
      return { kind: 'retry', reason: 'another operation on the session was in progress' }
    if (released === 'refused') {
      const latest = getWidget(row.id)
      // A pane came back meanwhile; the next try respawns it.
      if (latest && (await this.engine.currentPane(latest).catch(() => null)))
        return { kind: 'retry', reason: 'the session has a pane again' }
      return { kind: 'failed', reason: 'Tether could not release the crashed pane' }
    }
    const ok = await withRootPrompt(row.id, prompt, () => this.engine.ensure(row.id), resumeId)
    if (ok) return { kind: 'launched' }
    const failure = this.engine.lastFailure(row.id)
    if (failure?.code === 'admission_denied')
      return { kind: 'retry', reason: `host admission deferred the relaunch: ${failure.reason}` }
    return { kind: 'failed', reason: failure?.reason ?? 'the launch did not start' }
  }
}

type LaunchOutcome =
  | { kind: 'launched' }
  | { kind: 'retry'; reason: string }
  | { kind: 'failed'; reason: string }

export function registerRecoveryRoutes(router: Router, recovery: Recovery): void {
  router
    .add('GET', '/v1/recovery/status', async (_req, res) => {
      sendJson(res, 200, recovery.status())
    })
    .add('POST', '/v1/recovery/:id/resume', async (_req, res, params) => {
      const id = params.id ?? ''
      if (!recovery.resumeHeld(id)) throw new HttpError(409, 'not_held', { id })
      sendJson(res, 202, { id, state: 'waiting' })
    })
}
