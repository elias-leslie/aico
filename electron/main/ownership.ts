export const MANAGED_LIFECYCLE_VERSION = 1

const TMUX_SCOPE_RE =
  /^tmux-spawn-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.scope$/i
const SYSTEMD_INVOCATION_ID_RE = /^[0-9a-f]{32}$/i
const TMUX_SERVER_GENERATION_RE = /^[a-f0-9]{8,64}$/i
// `.scope` is the read-compatible identity of earlier caller-spawned generations.
// New servers use manager-spawned `.service` units so they cannot
// inherit Electron/Chromium file descriptors from the systemd-run caller.
const AICO_TMUX_SERVER_UNIT_RE = /^aico-tmux-server-[0-9a-f]{8,64}\.(?:scope|service)$/i

export interface SessionOwnership {
  widgetId: string
  sessionId: string
  projectId: string | null
  tool: string
}

/** Metadata inherited by the pane, agent, and every tool it launches. */
export function ownershipEnvironment(owner: SessionOwnership): Record<string, string> {
  return {
    AICO_WORKLOAD_CLASS: 'durable-session',
    AICO_OWNER: 'aico',
    AICO_WIDGET_ID: owner.widgetId,
    AICO_SESSION_ID: owner.sessionId,
    AICO_PROJECT_ID: owner.projectId ?? '',
    AICO_AGENT_SLUG: owner.tool,
    AICO_LIFECYCLE_VERSION: String(MANAGED_LIFECYCLE_VERSION),
  }
}

/** Exact transient service name for a newly-created durable tmux generation. */
export function durableTmuxServerUnit(serverId: string): string {
  if (!TMUX_SERVER_GENERATION_RE.test(serverId)) {
    throw new Error(`unsafe tmux server generation id: ${serverId}`)
  }
  return `aico-tmux-server-${serverId}.service`
}

/** Start the shared tmux server outside Electron's application cgroup. Only the
 * first session creation uses this wrapper; later clients connect to the live
 * durable server. A transient service (rather than a caller-owned scope) makes
 * the user manager spawn tmux with a clean descriptor table. ExitType=cgroup
 * keeps the unit active after tmux's short-lived client forks the durable
 * server. Pane workloads are moved again into their own tmux scopes. */
export function durableTmuxServerArgs(serverId: string, tmuxArgs: string[]): string[] {
  const unit = durableTmuxServerUnit(serverId)
  return [
    '--user',
    '--quiet',
    '--collect',
    `--unit=${unit}`,
    // Identity validation below requires this exact sibling of the desktop
    // runtime. Do not depend on a user-manager default slice that an operator
    // or distribution may override.
    '--slice=app.slice',
    `--description=Aico durable tmux server (${serverId})`,
    '--service-type=exec',
    // Service-mode systemd-run expands $ by default. Disable that so tmux sees
    // the exact argv Aico validated, including user-controlled project paths.
    '--expand-environment=no',
    '--property=ExitType=cgroup',
    // Never pass Electron's stdin/stdout/stderr into the durable generation.
    // In particular, do not add systemd-run --pipe/--pty here.
    '--property=StandardInput=null',
    '--property=StandardOutput=journal',
    '--property=StandardError=journal',
    '--property=CPUAccounting=yes',
    '--property=MemoryAccounting=yes',
    '--property=TasksAccounting=yes',
    '--setenv=AICO_OWNER=aico',
    '--setenv=AICO_WORKLOAD_CLASS=durable-tmux-server',
    `--setenv=AICO_TMUX_SERVER_ID=${serverId}`,
    '--',
    '/usr/bin/tmux',
    ...tmuxArgs,
  ]
}

/** Return only the narrow tmux pane scope, never an app/session/user scope. */
export function paneScopeFromCgroup(cgroup: string): string | null {
  for (const line of cgroup.split('\n')) {
    const path = line.slice(line.lastIndexOf(':') + 1)
    const unit = path.split('/').filter(Boolean).at(-1)
    if (unit && TMUX_SCOPE_RE.test(unit)) return unit
  }
  return null
}

export function isOwnedPaneScope(unit: string | null | undefined): unit is string {
  return Boolean(unit && TMUX_SCOPE_RE.test(unit))
}

export function isSystemdInvocationId(value: string | null | undefined): value is string {
  return Boolean(value && SYSTEMD_INVOCATION_ID_RE.test(value))
}

/** Exact cgroup path Ubuntu's tmux user scope owns. This is deliberately stricter
 * than suffix matching because cgroup.kill can terminate privileged descendants. */
export function isOwnedPaneControlGroup(unit: string, controlGroup: string, uid: number): boolean {
  return (
    isOwnedPaneScope(unit) &&
    Number.isInteger(uid) &&
    uid >= 0 &&
    controlGroup === `/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/${unit}`
  )
}

export function isOwnedTmuxServerControlGroup(
  unit: string,
  controlGroup: string,
  uid: number,
): boolean {
  return (
    AICO_TMUX_SERVER_UNIT_RE.test(unit) &&
    Number.isInteger(uid) &&
    uid >= 0 &&
    controlGroup === `/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/${unit}`
  )
}

export interface ScopeResources {
  activeState: string
  controlGroup: string
  cpuUsageNSec: number | null
  memoryCurrent: number | null
  memoryPeak: number | null
  swapCurrent: number | null
  swapPeak: number | null
  tasksCurrent: number | null
  ageSeconds: number | null
}

function finiteNumber(value: string | undefined): number | null {
  if (!value || value === '[not set]') return null
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** Parse `systemctl show` output without depending on display-oriented status text. */
export function parseScopeResources(output: string, uptimeSeconds: number): ScopeResources {
  const properties = new Map<string, string>()
  for (const line of output.split('\n')) {
    const separator = line.indexOf('=')
    if (separator > 0) properties.set(line.slice(0, separator), line.slice(separator + 1))
  }
  const activeAtUSec = finiteNumber(properties.get('ActiveEnterTimestampMonotonic'))
  return {
    activeState: properties.get('ActiveState') ?? 'unknown',
    controlGroup: properties.get('ControlGroup') ?? '',
    cpuUsageNSec: finiteNumber(properties.get('CPUUsageNSec')),
    memoryCurrent: finiteNumber(properties.get('MemoryCurrent')),
    memoryPeak: finiteNumber(properties.get('MemoryPeak')),
    swapCurrent: finiteNumber(properties.get('MemorySwapCurrent')),
    swapPeak: finiteNumber(properties.get('MemorySwapPeak')),
    tasksCurrent: finiteNumber(properties.get('TasksCurrent')),
    ageSeconds:
      activeAtUSec === null ? null : Math.max(0, uptimeSeconds - activeAtUSec / 1_000_000),
  }
}
