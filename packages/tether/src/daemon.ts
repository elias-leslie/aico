import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Fleet } from '@aico/fleet/fleet'
import { readSettings } from '@aico/fleet/settings'
import { registryProjects } from '@aico/tasks/registry'
import { createHubApi } from './agent-hub/client'
import {
  type AgentHubConfig,
  resolveAgentHubConfig,
  resolveRunsConfig,
  resolveSettleMs,
} from './agent-hub/config'
import { RunTracker, readOverRuns, sessionLaunchers, type ToldPause } from './agent-hub/runs'
import { AgentHubRuntime, type HubApi } from './agent-hub/runtime'
import { AgentStatePoller, AgentStateTracker } from './agent-state'
import { type AskDelivery, AskStore, aicoOrigin, handOffAsks, type NeedsYouFeed } from './asks'
import {
  agentExitMarkerDir,
  resolveEntryScanConfig,
  resolveShowConfig,
  type TetherPaths,
} from './config'
import { observeAgent, writeJsonFile } from './continuity'
import { CoordinationDocs } from './coordination/docs'
import { DeadShells } from './dead-shells'
import { configureEntryScan } from './entry-files'
import { parseGraphicalEnvironment } from './env'
import { EventBus } from './events'
import { listenPrivateSocket } from './http'
import { Hub } from './hub/hub'
import { LOCAL_HOST, localRootFate, Placement } from './hub/placement'
import { LaneReporter, LaneReportStore, laneView } from './lane-reports'
import { nightshiftAdmissionPath, nightshiftAdmissionRed } from './lifecycle/agent-admission'
import {
  bindCatalog,
  claimLauncher,
  getAgentHubSession,
  getRootRequest,
  getWidget,
  isRetiredSessionId,
  listSessions,
  listWidgets,
} from './lifecycle/catalog'
import { displayTitle, leadName, setPersonalWorkspaceRoot } from './lifecycle/display'
import {
  agentExitOf,
  cachedSessionStatus,
  configureEngine,
  endSession,
  flushSessionEvents,
  notifySessionChanged,
  onAbandonedScope,
  setGenerationFunction,
  setHubBackend,
  setLaunchGuard,
  setSessionSnapshotFunction,
  startLifecycle,
  stopLifecycle,
  verifiedCurrentManagedPane,
  verifySessionStatus,
} from './lifecycle/engine'
import { setLifecycleInstance } from './lifecycle/ownership'
import { configureTmuxPaths } from './lifecycle/tmux'
import { AGENT_HUB_TOOL, adapterOf, bindToolSource, isDeliveryTool } from './lifecycle/tui/registry'
import {
  bindAgentHub,
  bindAgentStates,
  bindModelWatch,
  foregroundPaneScope,
  generationOf,
  learnProjects,
  pressKeysInRunningSession,
  sessionSnapshot,
} from './lifecycle-api'
import { startMemoryGuard } from './memory-guard'
import { ModelNotices, readModelNoticeState } from './model-notices'
import { ModelWatch, readAlternates, readWatchEntries, worktreeFacts } from './model-switch'
import { nodeFileTail, nodeProcFs } from './proc-fs'
import { activeProjectFileFromEnv, ProjectProvider, summitflowUrlFromEnv } from './projects'
import { Continuity } from './reboot'
import { Recovery, runCommand } from './recovery'
import type { StepChatSource } from './runs-api'
import { createTetherServer } from './server'
import { type History, historyFromEnv, startHistoryScan } from './sessions/history'
import { persistSizeHolders } from './size-holder'
import { Store } from './store'
import { VERSION } from './version'
import type { PullKind } from './wait-kinds'
import { anchorWidget, PullReaders, systemdCmdUnits, systemdProbe } from './wait-readers'
import { readWaitingState, WAIT_NOTICE_MS, WaitingNotices } from './waiting'
import { WaitService, WaitStore } from './waits'
import { bindWaitingOn, bindWakeStore, WakeService } from './wake-runtime'
import { cleanNote } from './wakes'

export interface RunningDaemon {
  server: Server
  store: Store
  events: EventBus
  /** The Agent Hub session kind's runtime (polls only where Tether observes sessions). */
  agentHub: AgentHubRuntime
  /** The hub over the remote hosts this instance federates; null when off. */
  hosts: Hub | null
  /** Resolves when startup reconciliation has finished (or was skipped). */
  ready: Promise<void>
  close(): Promise<void>
}

/** The hub federates hosts.json's remote Tethers wherever Tether observes
 * sessions, or where a test names its own registry (`TETHER_HOSTS_FILE`). */
export function hubEnabled(env: NodeJS.ProcessEnv): boolean {
  return reconcileEnabled(env) || Boolean(env.TETHER_HOSTS_FILE)
}

/** `TETHER_RECONCILE=off` keeps a scratch/test instance from observing,
 * adopting or stopping any tmux server or scope at startup. */
export function reconcileEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.TETHER_RECONCILE !== 'off'
}

const PROJECT_NAMES_MS = 300_000

/** The dismissed workflow runs, kept as one JSON setting (run id to when). */
const DISMISSED_RUNS_KEY = 'dismissed_runs'
/** Runs no longer followed and how they ended, for the waits on them. */
const OVER_RUNS_KEY = 'over_runs'

/** The run pauses already told to their launching session (run id to the
 * pause's key and when), so a restart does not tell one again. */
const TOLD_PAUSES_KEY = 'told_run_pauses'

/** Which client holds each session's window size, so a restart keeps it. */
const SIZE_HOLDERS_KEY = 'size_holders'

/** The waiting notices' seen marks and open notices, so a restart neither repeats nor strands one. */
const WAITING_KEY = 'waiting_notices'
const MODEL_WATCH_KEY = 'model_watch'
const MODEL_NOTICE_KEY = 'model_notices'

/** Runs `nightshift` (notice contract v1); logs the outcome, never throws. */
function nightshift(args: string[], what: string, input?: string): void {
  try {
    const child = execFile('nightshift', args, { timeout: 30_000 }, (error, stdout) => {
      const last =
        String(stdout ?? '')
          .trim()
          .split('\n')
          .pop()
          ?.trim() ?? ''
      const word = /^[a-z][a-z0-9 ,:/-]{0,39}$/.test(last) ? last.replace(/ /g, '_') : ''
      if (error?.code === 2)
        console.error(`[tether] Nightshift refused the ${what} (a bug): ${error.message}`)
      console.log(
        `[tether:event] ${what} result=${error ? 'failed' : 'ok'}${word ? ` nightshift=${word}` : ''}${error ? ` exit=${String(error.code ?? 'error')}` : ''}`,
      )
    })
    if (input !== undefined) {
      child.stdin?.on('error', () => {})
      child.stdin?.end(input)
    }
  } catch (error) {
    console.warn(`[tether] nightshift ${args[0]} failed to start: ${(error as Error).message}`)
  }
}

function readTold(raw: string | null): Record<string, ToldPause> {
  try {
    const value = JSON.parse(raw ?? '{}') as Record<string, unknown>
    return Object.fromEntries(
      Object.entries(value).filter(([, entry]) => {
        const e = entry as { key?: unknown; at?: unknown; to?: unknown; note?: unknown } | null
        return (
          typeof e?.key === 'string' &&
          typeof e.at === 'number' &&
          Number.isFinite(e.at) &&
          (e.to === undefined || typeof e.to === 'string') &&
          (e.note === undefined || typeof e.note === 'string')
        )
      }),
    ) as Record<string, ToldPause>
  } catch {
    return {}
  }
}

function readDismissedRuns(raw: string | null): Record<string, number> {
  try {
    const value = JSON.parse(raw ?? '{}') as Record<string, unknown>
    return Object.fromEntries(
      Object.entries(value).filter(([, at]) => typeof at === 'number' && Number.isFinite(at)),
    ) as Record<string, number>
  } catch {
    return {}
  }
}

/** The desktop variables the graphical session imported into the user
 * manager; empty before login or when systemctl cannot answer. */
function userManagerGraphicalEnvironment(): Record<string, string> {
  try {
    return parseGraphicalEnvironment(
      execFileSync('systemctl', ['--user', 'show-environment'], {
        encoding: 'utf8',
        timeout: 2_000,
      }),
    )
  } catch {
    return {}
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  })
}

export async function startDaemon(
  paths: TetherPaths,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RunningDaemon> {
  const show = resolveShowConfig(env)
  configureEntryScan(resolveEntryScanConfig(env))
  mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 })
  chmodSync(paths.stateDir, 0o700)
  mkdirSync(agentExitMarkerDir(paths), { recursive: true, mode: 0o700 })
  const store = new Store(paths.dbPath)
  const events = new EventBus()
  const projects = new ProjectProvider({
    registry: () => registryProjects(env),
    summitflowUrl: summitflowUrlFromEnv(env),
    localFile: paths.localProjectsFile,
  })
  const projectRoots = new Map<string, string>()

  // One process serves one instance: bind the extracted lifecycle modules.
  setLifecycleInstance(paths.instance)
  configureTmuxPaths({
    // Non-default instances get a path that is never created, so a
    // lifecycle-v0 target can never address Aico's historical server.
    historicalSocket: paths.historicalTmuxSocket ?? join(paths.runtimeDir, 'no-historical-tmux'),
    paneExitMarkerDir: paths.paneExitMarkerDir,
  })
  bindCatalog(store.db)
  bindToolSource(store)
  setGenerationFunction(generationOf)
  setSessionSnapshotFunction(sessionSnapshot)
  persistSizeHolders(
    {
      read: () => store.getSetting(SIZE_HOLDERS_KEY),
      write: (value) => store.putSetting(SIZE_HOLDERS_KEY, value, Date.now()),
    },
    (id) => getWidget(id) !== undefined,
  )
  configureEngine({
    paths,
    events,
    env,
    projectRoot: (projectId) => projectRoots.get(projectId) ?? null,
    graphicalEnv: reconcileEnabled(env) ? userManagerGraphicalEnvironment : undefined,
  })

  const coordDocs = new CoordinationDocs(store.db, Date.now)
  const context = {
    coordDocs,
    show,
    paths,
    store,
    events,
    projects,
    projectRoots,
    activeProjectFile: activeProjectFileFromEnv(env, env.HOME ?? homedir()),
    history: undefined as History | undefined,
    startedAt: Date.now(),
    continuity: undefined as Continuity | undefined,
    recovery: undefined as Recovery | undefined,
    wakes: undefined as WakeService | undefined,
    asks: undefined as AskDelivery | undefined,
    // The Nightshift tray reads this file for its Aico row.
    asksFeed: {
      write: (feed: NeedsYouFeed) => writeJsonFile(join(paths.stateDir, 'needs-you.json'), feed),
      nameOf: (id: string) => {
        const row = getWidget(id)
        return row ? displayTitle(row) : null
      },
      origin: aicoOrigin(env.TETHER_AICO_URL),
    },
    runs: undefined as RunTracker | undefined,
    waiting: undefined as WaitingNotices | undefined,
    stepChats: undefined as StepChatSource | undefined,
    hub: undefined as Hub | undefined,
    placement: undefined as Placement | undefined,
    lanes: undefined as LaneReporter | undefined,
    waits: undefined as WaitService | undefined,
    memoryPolicy: startMemoryGuard(paths, store, env, {
      foreground: foregroundPaneScope,
      sessionOf: () =>
        new Map(
          listWidgets().flatMap((row) => (row.scopeUnit ? [[row.scopeUnit, row.id] as const] : [])),
        ),
    }),
  }
  if (reconcileEnabled(env)) {
    // The session history: each tool's transcripts, read in small passes.
    context.history = historyFromEnv(store.db, env, projectRoots)
  }
  if (reconcileEnabled(env)) {
    const graphical = () => userManagerGraphicalEnvironment()
    const continuity = new Continuity(context, {
      // TETHER_HEADLESS=1: an instance with no desktop never waits for DISPLAY.
      headless: env.TETHER_HEADLESS === '1',
      desktopReady: () => Boolean(graphical().DISPLAY || graphical().WAYLAND_DISPLAY),
    })
    const recovery = new Recovery(context, {
      awaitingRestore: (id) => continuity.isAwaitingRestore(id),
      // A fresh pass, so a session started a moment ago is seen too.
      engine: {
        runningConversations: async () =>
          (await continuity.observe()).map(({ row, resumeId }) => ({ id: row.id, resumeId })),
      },
    })
    continuity.setRecovery(recovery)
    const deadShells = new DeadShells({
      awaitingRestore: (id) => continuity.isAwaitingRestore(id),
      restorePlanned: continuity.restorePlanned,
      restoreFinished: continuity.restoreFinished,
      list: listWidgets,
      status: verifySessionStatus,
      end: endSession,
      generationOf,
    })
    onAbandonedScope((event) => {
      void recovery.onAbandoned(event)
      deadShells.onAbandoned(event)
    })
    void deadShells.settleStartup(context.startedAt)
    setLaunchGuard((id) => recovery.holdsLaunch(id))
    context.continuity = continuity
    context.recovery = recovery
  }
  const wakes = new WakeService(context)
  context.wakes = wakes
  bindWakeStore(wakes.store)
  // An owner's answer to an ask goes to the asking session as an event line
  // on its delivery queue, or to the session that launched it once the asker
  // has ended; a session Tether cannot deliver to reads it with `tether ask get`.
  // A session that is there (not ended), even while its state is unknown.
  const askReceiver = (id: string): boolean => Boolean(getWidget(id))
  context.asks = {
    wake: (sessionId, text, source) =>
      wakes.queueAnswer(sessionId, text, source ?? `ask:${Date.now()}`),
    lost: (wakeId) =>
      !wakes.store.get(wakeId) && wakes.deliveries.get(wakeId)?.deliveredAt === null,
    coordinatorOf: (sessionId) => {
      const row = getWidget(sessionId)
      return row?.launched ? (row.coordinatorId ?? null) : null
    },
    receiver: askReceiver,
    launcherOf: (sessionId) => {
      // Only lineage from a launch, as lane reports read it.
      const row = getWidget(sessionId)
      if (!row?.launched) return null
      return row.parentId ?? row.coordinatorId ?? null
    },
    nameOf: (id) => {
      const row = getWidget(id)
      return row ? displayTitle(row) : null
    },
    cancel: (wakeId, why) => wakes.cancelLine(wakeId, why),
    withdraw: (source) => {
      wakes.withdrawEvents(null, source)
    },
    noteMaxChars: () => wakes.policy().noteMaxChars,
    sessionChanged: (sessionId) => {
      if (getWidget(sessionId)) notifySessionChanged(sessionId, { force: true })
    },
  }
  // One Agent Hub client for the session kind and for the workflow runs.
  let hubApi: HubApi | null = null
  let hubConfig: AgentHubConfig | null = null
  const hub = (): HubApi => {
    hubConfig ??= resolveAgentHubConfig(env)
    hubApi ??= createHubApi(hubConfig)
    return hubApi
  }
  const runs = new RunTracker({
    api: () => hub().workflowRuns,
    // Agent Hub refuses every call without a client id (a host whose Tether
    // reaches the workstation's Agent Hub through a forward, for one).
    unusable: () => {
      hubConfig ??= resolveAgentHubConfig(env)
      return hubConfig.clientId ? null : 'Agent Hub client id is not set'
    },
    launchers: () => sessionLaunchers(listSessions(), (id) => getAgentHubSession(id)?.hubSessionId),
    config: resolveRunsConfig(env),
    dismissed: {
      read: () => readDismissedRuns(store.getSetting(DISMISSED_RUNS_KEY)),
      write: (dismissed) =>
        store.putSetting(DISMISSED_RUNS_KEY, JSON.stringify(dismissed), Date.now()),
    },
    over: {
      read: () => readOverRuns(store.getSetting(OVER_RUNS_KEY)),
      write: (over) => store.putSetting(OVER_RUNS_KEY, JSON.stringify(over), Date.now()),
    },
    watched: () =>
      (
        store.db
          .prepare("SELECT DISTINCT ref FROM waits WHERE kind = 'run' AND state = 'armed'")
          .all() as { ref: string }[]
      ).map((row) => row.ref),
    // A run that waits for the owner is told to the session that launched it
    // as a check-in that is due now, delivered when the agent is idle.
    pauses: {
      store: {
        read: () => readTold(store.getSetting(TOLD_PAUSES_KEY)),
        write: (told) => store.putSetting(TOLD_PAUSES_KEY, JSON.stringify(told), Date.now()),
      },
      maxChars: () => wakes.policy().noteMaxChars,
      tell: (launcherId, notice, runId) => {
        const row = getWidget(launcherId)
        if (!row || !wakes.supports(row)) return false
        const note = cleanNote(notice.text, wakes.policy().noteMaxChars)
        if (note === null) return false
        const now = Date.now()
        // An event line (not a check-in): a `run` wait on the same pause by
        // the same session fires without a second line (WaitOperations.told).
        const wake = wakes.store.addEvent({
          sessionId: row.id,
          source: `run:${runId}:needs-you`,
          note,
          now,
        })
        wakes.changed(row.id)
        return wake.id
      },
      withdraw: (_launcherId, noteId) => {
        const wake = wakes.store.get(noteId)
        if (wake && wakes.store.remove(noteId)) wakes.changed(wake.sessionId)
      },
    },
    notify: () => events.publish('runs.changed', {}),
  })
  context.runs = runs
  context.stepChats = {
    session: (id) => hub().sessions.get(id, { includeMessages: true }),
    attach: (id, afterSeq, signal) => hub().turns.attach(id, { afterSeq, signal }),
  }
  const hosts = hubEnabled(env)
    ? new Hub({
        env,
        uid: process.getuid?.(),
        publish: (type, data) => events.publish(type, data),
        settings: {
          get: (key) => store.getSetting(key),
          put: (key, value) => store.putSetting(key, value, Date.now()),
        },
        isLocalSession: (id) => getWidget(id) !== undefined,
        isLocalRoot: (requestId) => getRootRequest(requestId) !== undefined,
        isLocalRun: (runId) => runs.snapshot().items.some((item) => item.runId === runId),
        isLocalAsk: (id) => askStore.get(id) !== undefined,
        endedBy: (host, id, by) => context.lanes?.remoteEnd(host, id, by),
        leadName,
        claimLocal: (launcherId) => {
          const claimed = claimLauncher(launcherId)
          for (const id of claimed?.changed ?? []) notifySessionChanged(id, { force: true })
          return claimed?.lineage ?? null
        },
      })
    : null
  if (hosts) context.hub = hosts
  // `--host auto`: pick a host with room from live readings (src/hub/placement.ts).
  context.placement = new Placement({
    env,
    hostNames: () => hosts?.hostNames() ?? [],
    peer: (name) => hosts?.peerView(name) ?? null,
    retired: (name) => hosts?.retired(name) ?? false,
    localRoot: (requestId) => {
      const root = getRootRequest(requestId)
      const row = root ? getWidget(root.widgetId) : undefined
      return localRootFate(Boolean(root), Boolean(row), row ? agentExitOf(row)?.state : null)
    },
    existingHost: (requestId) => {
      if (getRootRequest(requestId)) return LOCAL_HOST
      return hosts?.rootOwner(requestId) ?? undefined
    },
    settings: {
      get: (key) => store.getSetting(key),
      put: (key, value) => store.putSetting(key, value, Date.now()),
    },
  })
  // The owner's waiting notice: only the Tether that knows where Aico is.
  const aicoUrl = aicoOrigin(env.TETHER_AICO_URL)
  const waiting =
    aicoUrl && reconcileEnabled(env)
      ? new WaitingNotices({
          origin: aicoUrl,
          tools: () => store.listTools(),
          send: (notice) =>
            nightshift(
              ['push', '--json'],
              `waiting_notice key=${notice.key}`,
              JSON.stringify(notice),
            ),
          resolve: (key) =>
            nightshift(
              ['resolve', key, '--text', 'The session no longer waits on you.'],
              `waiting_resolve key=${key}`,
            ),
          state: {
            read: () => readWaitingState(store.getSetting(WAITING_KEY)),
            write: (state) => store.putSetting(WAITING_KEY, JSON.stringify(state), Date.now()),
          },
        })
      : null
  if (waiting) {
    context.waiting = waiting
    events.subscribe((event) => {
      if (event.type === 'session.created' || event.type === 'session.updated') {
        const session = event.data.session as { id?: unknown } | undefined
        if (session && typeof session.id === 'string') waiting.session(session as { id: string })
      } else if (event.type === 'session.ended' && typeof event.data.id === 'string') {
        waiting.removed(event.data.id)
      } else if (event.type === 'runs.changed') {
        const local = runs.snapshot()
        waiting.runs(hosts ? hosts.mergeRuns(local) : local)
      }
    })
  }
  // A model switch in a window nobody launched: the owner's notice (src/model-notices.ts).
  const modelNotices =
    aicoUrl && reconcileEnabled(env)
      ? new ModelNotices({
          origin: aicoUrl,
          send: (notice) =>
            nightshift(
              ['push', '--json'],
              `model_notice key=${notice.key}`,
              JSON.stringify(notice),
            ),
          resolve: (key) =>
            nightshift(
              ['resolve', key, '--text', 'The session is back on its model or gone.'],
              `model_resolve key=${key}`,
            ),
          state: {
            read: () => readModelNoticeState(store.getSetting(MODEL_NOTICE_KEY)),
            write: (state) => store.putSetting(MODEL_NOTICE_KEY, JSON.stringify(state), Date.now()),
          },
        })
      : null
  if (modelNotices)
    events.subscribe((event) => {
      try {
        const host = typeof event.data.host === 'string' ? event.data.host : null
        if (event.type === 'session.created' || event.type === 'session.updated') {
          const session = event.data.session as { id?: unknown } | undefined
          if (session && typeof session.id === 'string')
            modelNotices.session(session as { id: string }, host)
        } else if (event.type === 'session.ended' && typeof event.data.id === 'string') {
          modelNotices.removed(event.data.id, host)
        }
      } catch (error) {
        console.error('[tether:models] notice failed:', error)
      }
    })
  // Lane reports: a launched lane tells its launcher it finished, is blocked
  // or ended (src/lane-reports.ts); only where Tether observes sessions, since
  // the lines are pasted.
  const lanes = reconcileEnabled(env)
    ? new LaneReporter(new LaneReportStore(store.db), {
        now: Date.now,
        policy: () => wakes.policy(),
        receiver: (id) => wakes.receiver(id),
        sessions: () =>
          listSessions().map((row) => ({
            id: row.id,
            coordinatorId: row.coordinatorId,
            parentId: row.parentId,
            launched: row.launched,
          })),
        deliver: (receiver, source, line, ride) => {
          const now = Date.now()
          wakes.store.addEvent({ sessionId: receiver, source, note: line, now, ride })
          wakes.changed(receiver)
        },
        told: (lane, receiver, since) => wakes.toldSince(lane, receiver, since),
        promoteReplies: (lane, receivers) => wakes.promoteReplies(lane, receivers),
        withdraw: (receiver, source) => wakes.withdrawEvents(receiver, source).withdrawn,
        acted: (lane, host, by, since) =>
          context.waits?.store.actedOn(lane, host ?? '', by, since) ?? false,
        elsewhere: (id) => {
          // Only an agent there that can take lines: else the root stands in.
          const remote = hosts?.remoteSession(id)
          if (!remote || remote.session.id !== id) return null
          const { tool, state } = remote.session
          const agent =
            typeof tool === 'string' && (tool === AGENT_HUB_TOOL || isDeliveryTool(tool))
          return agent && state !== 'unknown' ? remote.host : null
        },
        heardFrom: (lane, host, receivers, event) =>
          context.waits?.heardFrom(lane, host ?? '', receivers, event) ?? new Set(),
        agentGone: (id) => {
          const row = getWidget(id)
          if (!row || row.backend === 'agent-hub') return false
          const exit = agentExitOf(row)
          return (
            (exit?.state === 'exit' && exit.status === 0) || Boolean(context.recovery?.isHeld(id))
          )
        },
        unheard: (id) => {
          modelNotices?.unheard(id)
          if (getWidget(id)) notifySessionChanged(id, { force: true })
        },
        log: (message) => console.log(`[tether:lanes] ${message}`),
      })
    : null
  if (lanes) {
    context.lanes = lanes
    events.subscribe((event) => {
      try {
        const host = typeof event.data.host === 'string' ? event.data.host : null
        if (event.type === 'session.created' || event.type === 'session.updated') {
          const view = laneView(event.data.session, host)
          if (view) lanes.observe(view)
        } else if (event.type === 'session.ended' && typeof event.data.id === 'string') {
          if (host) lanes.ended(event.data.id, host)
          else lanes.drainOutbox()
        }
      } catch (error) {
        console.error('[tether:lanes] report failed:', error)
      }
    })
  }
  // General waits: an agent's wait on another session, a job, a request, a
  // run, an ask, a host or a tap fires once, as one line on its delivery
  // queue (src/waits.ts); pasted, so only where Tether observes sessions.
  const askStore = new AskStore(store.db)
  let pokeWaits: (kind: PullKind, ref?: string) => void = () => {}
  coordDocs.onWrite((name) => {
    if (name === '_coord') pokeWaits('reply')
  })
  const summitflowRoot =
    env.SUMMITFLOW_SERVICE_STATE_ROOT || join(env.HOME ?? homedir(), '.summitflow', 'services')
  const admissionPath = nightshiftAdmissionPath(env)
  const readers = new PullReaders({
    paths: {
      jobsDir: env.TETHER_WAIT_JOBS_DIR || join(summitflowRoot, 'jobs'),
      tapDirs: (
        env.TETHER_WAIT_TAP_DIRS ||
        '/var/lib/nightshift/bypass/out:/var/lib/nightshift/agent-responses'
      )
        .split(':')
        .filter((dir) => dir.startsWith('/')),
      cmdDir: join(paths.stateDir, 'wait-cmd'),
    },
    cmdUnits: systemdCmdUnits(env),
    ledgerDoc: () => coordDocs.get('_coord'),
    run: (runId) => runs.runState(runId),
    ask: (id) => askStore.get(id),
    agentTitle: (anchor) => {
      const widget = anchorWidget(nodeProcFs, anchor)
      const row = widget ? getWidget(widget) : null
      return row ? displayTitle(row) : null
    },
    host: (name) => hosts?.peerView(name)?.state ?? null,
    admissionRed: () => nightshiftAdmissionRed(admissionPath),
    probeJob: systemdProbe(env),
    poke: (kind, ref) => pokeWaits(kind, ref),
    now: Date.now,
    log: (message) => console.log(`[tether:waits] ${message}`),
  })
  const waits = reconcileEnabled(env)
    ? new WaitService(new WaitStore(store.db), {
        now: Date.now,
        policy: () => wakes.policy(),
        resolve: (ref) => {
          if (/^[0-9a-f]{8}$/.test(ref) && getWidget(ref)) return { id: ref, host: null }
          const root = getRootRequest(ref)
          if (root && getWidget(root.widgetId)) return { id: root.widgetId, host: null }
          const remote = hosts?.remoteSession(ref)
          return remote && typeof remote.session.id === 'string'
            ? { id: remote.session.id, host: remote.host }
            : null
        },
        endedSession: (ref) => {
          // A session id Tether retired, or a root request's tombstone.
          if (/^[0-9a-f]{8}$/.test(ref)) return isRetiredSessionId(ref) ? ref : null
          const root = getRootRequest(ref)
          return root?.widgetId && !getWidget(root.widgetId) ? root.widgetId : null
        },
        pullRef: (kind, ref) => readers.pullRef(kind, ref),
        read: (kind, ref) => readers.read(kind, ref),
        refresh: (kind, ref, force) => readers.refresh(kind, ref, force),
        createCmd: (ref, spec) => readers.createCmd(ref, spec),
        cmdArgv: (ref) => readers.cmdArgv(ref),
        settled: (wait) => {
          if (wait.kind === 'cmd') readers.endCmd(wait.ref)
        },
        sweepCmd: (armed) => readers.sweepCmd(armed),
        told: (wait) => {
          // The waiter has this line already from its owner: the ask's
          // answer queued to it, the run's pause told to it as launcher.
          if (wait.kind === 'ask') {
            const ask = askStore.get(wait.ref)
            return Boolean(ask && ask.delivery === 'wake' && ask.answerTo === wait.waiter)
          }
          if (wait.kind === 'run' && wait.until === 'needs-you') {
            // Only once the pause's note is queued to the waiter, not
            // between a look seeing the pause and the note going out.
            return Boolean(wait.waiter && runs.toldTo(wait.ref) === wait.waiter)
          }
          return false
        },
        view: (id, host) => {
          if (host === null) {
            const row = getWidget(id)
            return row ? laneView(sessionSnapshot(row), null) : null
          }
          const remote = hosts?.remoteSession(id)
          return remote && remote.host === host && remote.session.id === id
            ? laneView(remote.session, host)
            : null
        },
        agentGone: (id) => {
          const row = getWidget(id)
          if (!row || row.backend === 'agent-hub') return false
          const exit = agentExitOf(row)
          return (
            (exit?.state === 'exit' && exit.status === 0) || Boolean(context.recovery?.isHeld(id))
          )
        },
        receiver: (id) => wakes.receiver(id),
        notMainAgent: async (waiter, thread) => {
          // Codex sets CODEX_THREAD_ID per thread: a subagent's differs from the
          // session's own conversation. Claude subagents share the parent's ids.
          const row = getWidget(waiter)
          if (!row || !adapterOf(row.tool)?.capabilities.threadSubagents) return null
          const pane = await verifiedCurrentManagedPane(row).catch(() => null)
          const agent = pane ? observeAgent(nodeProcFs, env.HOME ?? homedir(), pane.pid) : null
          return agent?.resumeId && agent.resumeId !== thread
            ? "the caller's Codex thread is not this session's main agent (a subagent): use --block"
            : null
        },
        deliver: (waiter, source, line) => {
          wakes.store.addEvent({ sessionId: waiter, source, note: line, now: Date.now() })
        },
        relaunch: (ended, line) => {
          wakes.store.addKept({ ended, note: line, now: Date.now() })
        },
        changed: (waiter) => wakes.changed(waiter && getWidget(waiter) ? waiter : null),
        log: (message) => console.log(`[tether:waits] ${message}`),
      })
    : null
  if (waits) {
    context.waits = waits
    bindWaitingOn((id) => waits.waitingOn(id))
    pokeWaits = (kind, ref) => waits.pokeKind(kind, ref)
    readers.watch()
    events.subscribe((event) => {
      if (event.type.startsWith('session.') && typeof event.data.id === 'string')
        waits.poke(event.data.id)
      else if (event.type === 'runs.changed') waits.pokeKind('run')
      else if (event.type === 'peer.state') waits.pokeKind('host')
      else if (event.type === 'asks.changed') {
        const ask = event.data.ask as { id?: unknown } | undefined
        if (typeof ask?.id === 'string') waits.pokeKind('ask', ask.id)
      }
    })
  }
  // A session that ends with open asks hands them to its launcher (one
  // line); their answers go there (src/asks.ts handOffAsks).
  events.subscribe((event) => {
    if (event.type !== 'session.ended' || typeof event.data.id !== 'string') return
    if (typeof event.data.host === 'string' || !context.asks) return
    try {
      for (const ask of handOffAsks(askStore, context.asks, event.data.id, null))
        events.publish('asks.changed', { ask, created: false })
    } catch (error) {
      console.error('[tether:asks] hand-off failed:', error)
    }
  })
  const server = createTetherServer(context)
  try {
    await listenPrivateSocket(server, paths.socket)
  } catch (error) {
    store.close()
    throw error
  }
  const fleetSettings = readSettings(env, paths.socket)
  const fleet = fleetSettings ? new Fleet({ settings: fleetSettings }) : null
  if (fleet) await fleet.start()
  const ready = startLifecycle({ reconcile: reconcileEnabled(env) })
  hosts?.start()
  // Agent state: hook reports always; the poll only where Tether observes tmux.
  const agentStates = new AgentStateTracker((id) => {
    notifySessionChanged(id, { force: true })
    wakes.scheduler.nudge()
    runs.poke()
  })
  bindAgentStates(agentStates)
  // Model switches: each agent's own record, read on the agent poll; a switch
  // nobody asked for stops the turn (src/model-switch.ts).
  const models = reconcileEnabled(env)
    ? new ModelWatch({
        now: Date.now,
        read: () => readWatchEntries(store.getSetting(MODEL_WATCH_KEY)),
        write: (entries) => store.putSetting(MODEL_WATCH_KEY, JSON.stringify(entries), Date.now()),
        alternates: (tool) => {
          let text: string | null = null
          try {
            text = readFileSync(join(paths.configDir, 'model-alternates.json'), 'utf8')
          } catch {}
          return readAlternates(text)[tool]
        },
        agent: (id) => {
          const record = agentStates.get(id)
          return { state: record.state, detail: record.stateDetail }
        },
        interrupt: (id) => pressKeysInRunningSession(id, ['Escape']),
        worktree: (id, since) =>
          worktreeFacts(getWidget(id)?.projectRoot ?? null, since, runCommand, (path) =>
            nodeProcFs.mtimeMs ? nodeProcFs.mtimeMs(path) : null,
          ),
        changed: (id) => notifySessionChanged(id, { force: true }),
        log: (message) => console.log(`[tether:models] ${message}`),
      })
    : null
  bindModelWatch(models)
  if (models)
    events.subscribe((event) => {
      if (event.type === 'session.ended' && typeof event.data.host !== 'string')
        models.retain(listWidgets().map((row) => row.id))
    })
  // Agent Hub sessions have no pane: their own state tracker, runtime and
  // poll, none of which the tmux machinery above ever sees.
  const hubRuntime = new AgentHubRuntime({
    api: hub,
    states: new AgentStateTracker((id) => {
      notifySessionChanged(id, { force: true })
      wakes.scheduler.nudge()
      runs.poke()
    }),
    notify: (id) => notifySessionChanged(id, { force: true }),
    verifyStatus: verifySessionStatus,
    ...(resolveSettleMs(env) !== null ? { settleMs: resolveSettleMs(env) as number } : {}),
  })
  bindAgentHub(hubRuntime)
  setHubBackend({
    verify: (row) => hubRuntime.verify(row),
    end: (id, generation) => hubRuntime.end(id, generation),
  })
  const agentPoller = new AgentStatePoller(
    agentStates,
    {
      sessions: () =>
        listWidgets()
          .filter((row) => cachedSessionStatus(row) === 'running')
          .map((row) => ({
            id: row.id,
            generation: generationOf(row),
            panePid: async () => (await verifiedCurrentManagedPane(row))?.pid ?? null,
          })),
    },
    nodeProcFs,
    env.HOME ?? homedir(),
    models ? { models: (id, source) => models.see(id, source, nodeFileTail) } : {},
  )
  if (reconcileEnabled(env)) void ready.then(() => agentPoller.start()).catch(() => {})
  if (reconcileEnabled(env)) void ready.then(() => hubRuntime.start()).catch(() => {})
  if (reconcileEnabled(env)) void ready.then(() => runs.start()).catch(() => {})
  // Wakes paste into sessions, so only where Tether observes tmux.
  if (reconcileEnabled(env)) void ready.then(() => wakes.scheduler.start()).catch(() => {})
  if (waits) void ready.then(() => waits.start()).catch(() => {})
  if (lanes)
    void ready
      .then(() => {
        // Ended while Tether was down, then every lane as it is now.
        lanes.drainOutbox()
        for (const row of listSessions()) {
          const view = laneView(sessionSnapshot(row), null)
          if (view) lanes.observe(view)
        }
      })
      .catch(() => {})
  // Display titles name each session's project: learn names now and keep
  // up with renames in SummitFlow.
  setPersonalWorkspaceRoot(
    join(env.HOME ?? homedir(), '.local', 'share', 'aico', 'personal-workspace'),
  )
  const learn = () =>
    projects
      .list()
      .then((list) => learnProjects(context, list.projects))
      .catch(() => {})
  void learn()
  const projectNames = setInterval(learn, PROJECT_NAMES_MS)
  projectNames.unref()
  void context.continuity?.start()
  startHistoryScan(context.history)
  void ready.then(() => context.recovery?.start()).catch(() => {})
  if (waiting)
    void ready
      .then(() => {
        // Sessions already waiting when Tether started; then, once remote hosts
        // have had time to list theirs, resolve what no longer waits.
        for (const row of listSessions()) waiting.session(sessionSnapshot(row) as { id: string })
        setTimeout(() => waiting.sweep(), WAIT_NOTICE_MS).unref()
      })
      .catch(() => {})
  if (modelNotices)
    void ready
      .then(() => {
        // Switches standing when Tether started; then, once remote hosts have
        // listed theirs, resolve the notices of sessions that are gone.
        for (const row of listSessions())
          modelNotices.session(sessionSnapshot(row) as { id: string }, null)
        setTimeout(() => modelNotices.sweep(), WAIT_NOTICE_MS).unref()
      })
      .catch(() => {})
  console.log(`[tether] ${VERSION} instance=${paths.instance} listening on ${paths.socket}`)
  return {
    server,
    store,
    events,
    agentHub: hubRuntime,
    hosts,
    ready,
    close: async () => {
      await fleet?.close()
      hosts?.close()
      stopLifecycle()
      context.memoryPolicy.stop()
      clearInterval(projectNames)
      agentPoller.stop()
      hubRuntime.stop()
      runs.stop()
      bindAgentHub(null)
      setHubBackend(null)
      wakes.scheduler.stop()
      lanes?.stop()
      waits?.stop()
      bindWaitingOn(null)
      bindWakeStore(null)
      bindAgentStates(null)
      bindModelWatch(null)
      context.continuity?.stop()
      context.recovery?.stop()
      onAbandonedScope(null)
      setLaunchGuard(null)
      await closeServer(server)
      // Let in-flight reconciliation settle before the database closes.
      await ready.catch(() => {})
      await flushSessionEvents()
      store.close()
    },
  }
}
