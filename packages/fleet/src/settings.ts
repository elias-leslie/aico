import { readFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { homedir, hostname, networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { machineName } from './identity'

export interface Endpoint {
  address: string
  port: number
}
export interface FleetSettings {
  machine: string
  stateDir: string
  allowlist: string
  listen: Endpoint
  peers: { name: string; endpoint: Endpoint; tools?: string[]; hardware?: string }[]
  /** Optional label for the physical computer this machine runs on. Peers with the same label
   * share a computer (a VM beside this one, say); containers need none, they share this kernel. */
  hardware?: string
  /** SSH host alias of the Proxmox authority; guest names match fleet names. */
  proxmoxSsh?: string
  mode?: 'full' | 'worker'
  updatePins?: string
  controlSocket: string
  jobsSocket?: string
  syncSocket: string
  peerRoot: string
  stableMs?: number
  maxChannels?: number
  bufferBytes?: number
  retryMinMs: number
  retryMaxMs: number
  deadMs: number
  statusMs: number
  /** How long a Proxmox guest power reading is reused (default 60 s). */
  powerCacheMs?: number
  /** SSH timeout for one guest power reading (default 10 s). */
  powerTimeoutMs?: number
  statusUrl: string
}

/** Literal LAN addresses only: no DNS rebinding, wildcard, public IPv4 or IPv6. */
export function lanAddress(address: string): boolean {
  if (isIP(address) !== 4) return false
  const [a, b] = address.split('.').map(Number)
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}
export function localAddress(address: string): boolean {
  return (
    lanAddress(address) &&
    Object.values(networkInterfaces())
      .flat()
      .some((entry) => entry?.address === address)
  )
}

export function fleetFile(env: NodeJS.ProcessEnv): string {
  return (
    env.AICO_FLEET_CONFIG ||
    join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config'), 'aico', 'fleet.json')
  )
}

/** Configuration is deployment data. Absence leaves a standalone machine. */
export function readSettings(env: NodeJS.ProcessEnv, controlSocket: string): FleetSettings | null {
  let raw: string
  try {
    raw = readFileSync(fleetFile(env), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const value = JSON.parse(raw) as FleetSettings
  const endpoint = (e: Endpoint) =>
    e && lanAddress(e.address) && Number.isInteger(e.port) && e.port > 0 && e.port <= 65535
  if (
    !endpoint(value.listen) ||
    !Array.isArray(value.peers) ||
    value.peers.some((peer) => !endpoint(peer.endpoint))
  )
    throw new Error('Fleet endpoints must be literal LAN addresses')
  // At boot the network can come up after the service: a retry fixes this one, unlike the error above.
  if (!localAddress(value.listen.address))
    throw new Error(
      `Waiting for this machine's LAN address ${value.listen.address}: it isn't assigned yet`,
    )
  if (value.proxmoxSsh !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value.proxmoxSsh))
    throw new Error('Proxmox SSH host must be a host alias')
  const peerRoot = join(
    env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 0}`,
    'aico',
    'fleet',
  )
  if (value.peerRoot !== peerRoot)
    throw new Error('Fleet proxies must use the Aico fleet runtime directory')
  const machine = machineName(hostname())
  if (value.machine !== machine)
    throw new Error('Fleet machine must be this machine’s lower-cased short hostname')
  if (!value.stateDir || !value.allowlist || !value.syncSocket || !value.peerRoot)
    throw new Error('Fleet paths are required')
  if (value.mode !== undefined && value.mode !== 'full' && value.mode !== 'worker')
    throw new Error('Fleet mode must be full or worker')
  const label = /^[a-z0-9][a-z0-9._-]{0,62}$/
  if (
    [value.hardware, ...value.peers.map((peer) => peer.hardware)].some(
      (name) => name !== undefined && (typeof name !== 'string' || !label.test(name)),
    )
  )
    throw new Error('Fleet hardware labels must be short lower-case names')
  if (
    value.peers.some(
      (peer) =>
        peer.tools !== undefined &&
        (!Array.isArray(peer.tools) ||
          peer.tools.some(
            (tool) => typeof tool !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(tool),
          )),
    )
  )
    throw new Error('Invalid fleet tool grants')
  if (
    [value.retryMinMs, value.retryMaxMs, value.deadMs, value.statusMs].some(
      (n) => !Number.isSafeInteger(n) || n <= 0,
    ) ||
    value.retryMaxMs < value.retryMinMs
  )
    throw new Error('Fleet retry, silence and Status intervals must be positive')
  for (const key of [
    'stableMs',
    'maxChannels',
    'bufferBytes',
    'powerCacheMs',
    'powerTimeoutMs',
  ] as const) {
    const n = value[key]
    if (n !== undefined && (!Number.isSafeInteger(n) || n <= 0))
      throw new Error(`Invalid fleet ${key}`)
  }
  const status = new URL(value.statusUrl)
  if (status.protocol !== 'http:' || status.hostname !== '127.0.0.1')
    throw new Error('Fleet Status writer must use loopback HTTP')
  return { ...value, controlSocket }
}
