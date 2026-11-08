/**
 * What bounds the lifetime of Tether's durable sessions.
 *
 * `logind` (the default, `TETHER_LIFETIME_BOUNDARY` unset): the host user's
 * manager must outlive logout, so `Linger=yes` is required.
 *
 * `container` (`TETHER_LIFETIME_BOUNDARY=container`): Tether runs inside a
 * long-lived container that its supervisor owns, with the container's own
 * user manager. The container is the boundary, so there is no host logind to
 * ask. Durability is accepted only when all of these hold:
 * - the process is in a container (`/run/.containerenv`, or systemd's
 *   `container=` record: `/run/systemd/container` or the `container` variable);
 * - `systemctl --user is-system-running` answers a real state other than
 *   `offline` (or `unknown`);
 * - Tether's own cgroup is under `/user.slice/user-UID.slice/user@UID.service/`
 *   for its own UID, the hierarchy every managed pane scope is checked against.
 * Every other value refuses daemon startup.
 */

export type LifetimeBoundary = 'logind' | 'container'

export const LIFETIME_BOUNDARY_ENV = 'TETHER_LIFETIME_BOUNDARY'

/** `systemctl is-system-running` states that mean the manager is up. */
const MANAGER_UP_STATES = new Set([
  'initializing',
  'starting',
  'running',
  'degraded',
  'maintenance',
  'stopping',
])

/** Unset or empty keeps logind; `container` is the only other value. */
export function parseLifetimeBoundary(value: string | undefined): LifetimeBoundary {
  if (value === undefined || value === '') return 'logind'
  if (value === 'container') return 'container'
  throw new Error(
    `${LIFETIME_BOUNDARY_ENV}=${JSON.stringify(value)} is not supported: set it to "container" or leave it unset.`,
  )
}

export interface ContainerBoundaryProbe {
  uid: number
  /** `/run/.containerenv` exists. */
  containerEnvFile: () => boolean
  /** systemd's container record (`/run/systemd/container` or `$container`), or null. */
  systemdContainer: () => string | null
  /** `systemctl --user is-system-running` stdout, or null when it could not run. */
  userManagerState: () => string | null
  /** `/proc/self/cgroup` text, or null when unreadable. */
  ownCgroup: () => string | null
}

export type BoundaryVerdict = { durable: true } | { durable: false; reason: string }

/** The cgroup v2 path (`0::/...`) from `/proc/<pid>/cgroup` text. */
export function unifiedCgroupPath(text: string): string | null {
  for (const line of text.split('\n')) {
    if (line.startsWith('0::')) return line.slice(3).trim() || null
  }
  return null
}

function userManagerPrefix(uid: number): string {
  return `/user.slice/user-${uid}.slice/user@${uid}.service/`
}

function verifyContainerBoundary(probe: ContainerBoundaryProbe): BoundaryVerdict {
  const systemdContainer = probe.systemdContainer()?.trim()
  if (!probe.containerEnvFile() && !systemdContainer) {
    return { durable: false, reason: 'not running in a container' }
  }
  const state = probe.userManagerState()?.trim() ?? ''
  if (!MANAGER_UP_STATES.has(state)) {
    return {
      durable: false,
      reason: `the container's user manager is not running (state: ${state || 'no answer'})`,
    }
  }
  const text = probe.ownCgroup()
  const path = text === null ? null : unifiedCgroupPath(text)
  const prefix = userManagerPrefix(probe.uid)
  if (!path?.startsWith(prefix)) {
    return {
      durable: false,
      reason: `Tether's cgroup ${path ?? '(unreadable)'} is not under ${prefix}`,
    }
  }
  return { durable: true }
}

export interface DurabilityProbes {
  /** `loginctl show-user UID --property=Linger --value`, or null on failure. */
  linger: () => string | null
  container: ContainerBoundaryProbe
}

/** Logind asks only for Linger; container never asks logind. */
export function verifyDurableUserManager(
  boundary: LifetimeBoundary,
  probes: DurabilityProbes,
): BoundaryVerdict {
  if (boundary === 'container') return verifyContainerBoundary(probes.container)
  return probes.linger()?.trim() === 'yes'
    ? { durable: true }
    : { durable: false, reason: 'user linger is not enabled' }
}
