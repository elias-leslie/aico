import { execFile, execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import type { RetirementOperations, SessionState } from './owner-retirement'
import { scopeIdentity } from './owner-scope'
import {
  isOwnedPaneControlGroup,
  MANAGED_LIFECYCLE_VERSION,
  paneScopeFromCgroup,
} from './ownership'
import { getTmuxServer, getWidget, type TmuxServerRow, type WidgetRow } from './store'
import { terminalClientEnv } from './terminal-env'
import {
  killTargetArgs,
  listSessionPanesTargetArgs,
  matchesServerIdentityEnvironment,
  serverIdentityEnvironmentTargetArgs,
  serverRosterArgs,
  sessionIdTargetArgs,
  sessionName,
} from './tmux'
import {
  classifyTmuxServerState,
  type TmuxServerProcessEvidence,
  type TmuxServerRosterEvidence,
  type TmuxServerUnitEvidence,
} from './tmux-server-state'

const execFileAsync = promisify(execFile)
const TMUX_BIN = '/usr/bin/tmux'
const QUERY_TIMEOUT_MS = 2_000

function procStartTime(stat: string): string | null {
  return (
    stat
      .slice(stat.lastIndexOf(') ') + 2)
      .trim()
      .split(/\s+/)[19] ?? null
  )
}

function processControlGroup(pid: number): string | null {
  try {
    for (const line of readFileSync(`/proc/${pid}/cgroup`, 'utf8').split('\n')) {
      const marker = line.indexOf('::')
      if (marker >= 0) return line.slice(marker + 2)
    }
  } catch {
    // Missing or unreadable process identity is never cleanup authority.
  }
  return null
}

function processEvidence(server: TmuxServerRow): TmuxServerProcessEvidence {
  const pid = server.serverPid ?? -1
  if (pid <= 0) return { status: 'unavailable', pid }
  try {
    const start = procStartTime(readFileSync(`/proc/${pid}/stat`, 'utf8'))
    const group = processControlGroup(pid)
    return start && group
      ? { status: 'present', pid, procStartTime: start, controlGroup: group }
      : { status: 'unavailable', pid }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { status: 'missing', pid }
      : { status: 'unavailable', pid }
  }
}

async function unitEvidence(server: TmuxServerRow): Promise<TmuxServerUnitEvidence> {
  const unit = await scopeIdentity(server.scopeUnit)
  if (!unit) return { status: 'unavailable', scopeUnit: server.scopeUnit }
  if (unit.loadState === 'not-found') return { status: 'missing', scopeUnit: server.scopeUnit }
  if (unit.activeState !== 'active') return { status: 'inactive', scopeUnit: server.scopeUnit }
  return {
    status: 'active',
    scopeUnit: server.scopeUnit,
    controlGroup: unit.controlGroup,
    invocationId: unit.invocationId,
  }
}

interface Roster {
  evidence: TmuxServerRosterEvidence
  sessions: { sessionId: string; sessionName: string }[]
}

function serverRoster(server: TmuxServerRow): Roster {
  try {
    const output = execFileSync(TMUX_BIN, serverRosterArgs(server.socketPath), {
      encoding: 'utf8',
      env: terminalClientEnv(),
      timeout: QUERY_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const lines = output.split('\n').filter(Boolean)
    if (lines.length === 0) {
      const identity = execFileSync(
        TMUX_BIN,
        serverIdentityEnvironmentTargetArgs(server.socketPath),
        {
          encoding: 'utf8',
          env: terminalClientEnv(),
          timeout: QUERY_TIMEOUT_MS,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      return matchesServerIdentityEnvironment(identity, server.id) && server.serverPid
        ? { evidence: { status: 'reachable', serverPid: server.serverPid }, sessions: [] }
        : { evidence: { status: 'unavailable' }, sessions: [] }
    }
    const pids = new Set<number>()
    const sessions: Roster['sessions'] = []
    for (const line of lines) {
      const [pidText, sessionId, sessionName, createdText] = line.split('\t')
      const pid = Number(pidText)
      if (
        !Number.isInteger(pid) ||
        pid <= 0 ||
        !/^\$\d+$/.test(sessionId) ||
        !sessionName ||
        !Number.isFinite(Number(createdText)) ||
        Number(createdText) < 0
      )
        return { evidence: { status: 'unavailable' }, sessions: [] }
      pids.add(pid)
      sessions.push({ sessionId, sessionName })
    }
    if (pids.size !== 1) return { evidence: { status: 'unavailable' }, sessions: [] }
    return { evidence: { status: 'reachable', serverPid: [...pids][0] }, sessions }
  } catch (error) {
    const stderr = (error as { stderr?: string | Buffer }).stderr
    const detail = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : (stderr ?? '')
    const unavailable =
      /error connecting to .+\(No such file or directory\)|no server running on /i.test(detail)
    return {
      evidence: { status: unavailable ? 'transport-failure' : 'unavailable' },
      sessions: [],
    }
  }
}

export async function headlessSessionState(widgetId: string): Promise<SessionState> {
  const row = getWidget(widgetId)
  if (!row) return 'unknown'
  if (!row.tmuxServerId) {
    return row.tmuxAllocationState === 'unallocated' ? 'absent' : 'unknown'
  }
  const server = getTmuxServer(row.tmuxServerId)
  if (!server) return 'unknown'
  if (server.phase === 'dead') return 'absent'
  if (server.phase !== 'active') return 'unknown'
  const roster = serverRoster(server)
  const state = classifyTmuxServerState(server, {
    process: processEvidence(server),
    unit: await unitEvidence(server),
    roster: roster.evidence,
  })
  if (state === 'dead') return 'absent'
  if (state !== 'reachable') return 'unknown'
  const present = row.tmuxSessionId
    ? roster.sessions.some((entry) => entry.sessionId === row.tmuxSessionId)
    : roster.sessions.some((entry) => entry.sessionName === sessionName(row.id))
  return present ? 'present' : 'absent'
}

function paneEnvironmentMatches(row: WidgetRow, pid: number): boolean {
  try {
    const environment = new Map(
      readFileSync(`/proc/${pid}/environ`, 'utf8')
        .split('\0')
        .filter(Boolean)
        .map((part) => {
          const separator = part.indexOf('=')
          return [part.slice(0, separator), part.slice(separator + 1)] as const
        }),
    )
    return (
      environment.get('AICO_OWNER') === 'aico' &&
      environment.get('AICO_WORKLOAD_CLASS') === 'durable-session' &&
      environment.get('AICO_WIDGET_ID') === row.id &&
      environment.get('AICO_SESSION_ID') === row.sessionId &&
      environment.get('AICO_TMUX_SERVER_ID') === row.tmuxServerId &&
      environment.get('AICO_LIFECYCLE_VERSION') === String(MANAGED_LIFECYCLE_VERSION)
    )
  } catch {
    return false
  }
}

export async function headlessVerifiedPane(row: WidgetRow): Promise<boolean> {
  if (
    row.lifecycleVersion < MANAGED_LIFECYCLE_VERSION ||
    !row.scopeUnit ||
    !row.scopeInvocationId ||
    !row.tmuxSessionId ||
    !row.paneId ||
    !row.tmuxServerId
  )
    return false
  const server = getTmuxServer(row.tmuxServerId)
  if (!server || (await headlessSessionState(row.id)) !== 'present') return false
  const target = { socket: server.socketPath, session: row.tmuxSessionId }
  try {
    const panes = execFileSync(TMUX_BIN, listSessionPanesTargetArgs(target), {
      encoding: 'utf8',
      env: terminalClientEnv(),
      timeout: QUERY_TIMEOUT_MS,
    })
      .split('\n')
      .filter(Boolean)
    if (panes.length !== 1) return false
    const [paneId, pidText] = panes[0].split('\t')
    const pid = Number(pidText)
    if (paneId !== row.paneId || !Number.isInteger(pid) || pid <= 0) return false
    const sessionId = execFileSync(TMUX_BIN, sessionIdTargetArgs(target), {
      encoding: 'utf8',
      env: terminalClientEnv(),
      timeout: QUERY_TIMEOUT_MS,
    }).trim()
    if (sessionId !== row.tmuxSessionId || !paneEnvironmentMatches(row, pid)) return false
    const group = processControlGroup(pid)
    const scope = group ? paneScopeFromCgroup(`0::${group}`) : null
    const identity = await scopeIdentity(row.scopeUnit)
    const uid = process.getuid?.() ?? -1
    return Boolean(
      group &&
        scope === row.scopeUnit &&
        identity?.activeState === 'active' &&
        identity.invocationId === row.scopeInvocationId &&
        isOwnedPaneControlGroup(row.scopeUnit, identity.controlGroup, uid) &&
        group === identity.controlGroup,
    )
  } catch {
    return false
  }
}

export const headlessRetirementOperations: RetirementOperations = {
  sessionState: headlessSessionState,
  verifiedCurrentPane: headlessVerifiedPane,
  async stopTmuxSession(row) {
    if (!(await headlessVerifiedPane(row)) || !row.tmuxServerId || !row.tmuxSessionId) {
      throw new Error('managed pane identity changed before stop')
    }
    const server = getTmuxServer(row.tmuxServerId)
    if (!server) throw new Error('managed tmux server is unavailable')
    await execFileAsync(
      TMUX_BIN,
      killTargetArgs({ socket: server.socketPath, session: row.tmuxSessionId }),
      { env: terminalClientEnv(), timeout: QUERY_TIMEOUT_MS },
    )
  },
  async settleServer(row) {
    const deadline = Date.now() + QUERY_TIMEOUT_MS
    do {
      const state = await headlessSessionState(row.id)
      if (state !== 'unknown') return
      await new Promise((resolve) => setTimeout(resolve, 25))
    } while (Date.now() < deadline)
  },
}
