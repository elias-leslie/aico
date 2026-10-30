// The hosts registry (docs/plans/remote-hosts.md "Hosts registry"):
// `~/.config/tether/hosts.json` lists the remote Tethers this hub federates
// and how `tether-link@<host>` reaches them. It is data, validated here; a
// missing file means no peers, which is exactly a standalone Tether.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, normalize } from 'node:path'

export interface HostEntry {
  /** Registry name: the `host` field on descriptors and the link unit's instance. */
  name: string
  /** An ssh Host alias (never an address). */
  ssh: string
  /** The remote Tether's control socket. */
  socket: string
  /** Workstation ports exposed to the host through `-R` (loopback both ends). */
  forwards: number[]
  /** The command that powers the host on: run by a create, never by the link. */
  wake: string[] | null
  /** The command that powers the host off (the Hosts panel's power control). */
  sleep: string[] | null
  /** A read-only command that says whether the host is powered on, e.g.
   * `st vm status 200`; asked only while the link is down. */
  status: string[] | null
  /** What in `status`'s output means powered off (a regular expression). */
  statusOff: string
  /** URLs a create checks on the host before it is sent there (the forwarded
   * Agent Hub and SummitFlow health routes), e.g. `http://127.0.0.1:8003/health`. */
  health: string[]
  /** How long a create waits for the host to come up and answer. */
  wakeTimeoutSec: number
  /** The remote Tether's state directory, when it is not `~/.local/state/tether`. */
  stateDir: string | null
}

export interface HostsLoad {
  hosts: HostEntry[]
  /** One plain line per entry (or the file) that was not usable. */
  errors: string[]
  /** False when the file as a whole could not be read or parsed (often a
   * half-written save): the hub then keeps the hosts it already has. */
  readable: boolean
  /** Names of entries that are listed but not usable right now: the hub keeps
   * a running peer of that name instead of dropping it. */
  held: string[]
}

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/
const FIELDS = new Set([
  'name',
  'ssh',
  'socket',
  'forwards',
  'wake',
  'sleep',
  'status',
  'statusOff',
  'health',
  'wakeTimeoutSec',
  'stateDir',
])
/** A loopback URL on the host: safe to pass through the remote shell unquoted. */
const HEALTH_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}(\/[A-Za-z0-9._~/-]*)?$/
export const DEFAULT_WAKE_TIMEOUT_SEC = 240
/** How `st vm status` says a VM is off ("VM 200 (agent-work): stopped | …"). */
export const DEFAULT_STATUS_OFF = '\\bstopped\\b'
/** sockaddr_un's sun_path limit, less the terminating NUL. */
const MAX_SOCKET_BYTES = 107

/** `$TETHER_HOSTS_FILE`, else `$XDG_CONFIG_HOME/tether/hosts.json`. */
export function hostsFilePath(env: NodeJS.ProcessEnv): string {
  if (env.TETHER_HOSTS_FILE) return env.TETHER_HOSTS_FILE
  const configRoot = env.XDG_CONFIG_HOME || join(env.HOME ?? homedir(), '.config')
  return join(configRoot, 'tether', 'hosts.json')
}

/** `$XDG_RUNTIME_DIR/tether/peers/<name>`: the link's ssh.ctl and forwarded control.sock. */
export function peerDir(env: NodeJS.ProcessEnv, uid: number | undefined, name: string): string {
  const runtime = env.XDG_RUNTIME_DIR || `/run/user/${uid ?? process.getuid?.() ?? 0}`
  return join(runtime, 'tether', 'peers', name)
}

function absolutePath(value: unknown): string | null {
  if (typeof value !== 'string' || !isAbsolute(value) || normalize(value) !== value) return null
  return /[\s\0]/.test(value) ? null : value
}

function port(value: unknown): number | null {
  const n = typeof value === 'string' && /^\d{1,5}$/.test(value) ? Number(value) : value
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 1 && n <= 65_535 ? n : null
}

function compiles(pattern: string): boolean {
  try {
    new RegExp(pattern)
    return true
  } catch {
    return false
  }
}

/** An optional argv list: null when absent, false when malformed. */
function argv(value: unknown): string[] | null | false {
  if (value === undefined || value === null) return null
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((arg) => typeof arg !== 'string' || !arg || arg.includes('\0'))
  )
    return false
  return value as string[]
}

/** An entry's name when it is a valid one, so a bad entry can still hold its peer. */
function entryName(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const name = (value as Record<string, unknown>).name
  return typeof name === 'string' && NAME.test(name) && name !== 'local' ? name : null
}

/** One entry, or why it is not usable. Unknown fields are ignored (a newer
 * Tether's fields must not drop the host from an older one): see `unknownFields`. */
function parseEntry(value: unknown, index: number): HostEntry | string {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return `entry ${index} is not an object`
  const raw = value as Record<string, unknown>
  const { name, ssh } = raw
  if (typeof name !== 'string' || !NAME.test(name) || name === 'local')
    return `entry ${index}: name must be 1-32 of a-z, 0-9, '-'`
  if (typeof ssh !== 'string' || !ALIAS.test(ssh) || IPV4.test(ssh))
    return `${name}: ssh must be an ssh Host alias, not an address`
  const socket = absolutePath(raw.socket)
  if (!socket || Buffer.byteLength(socket) > MAX_SOCKET_BYTES)
    return `${name}: socket must be an absolute path`
  let forwards: number[] = []
  if (raw.forwards !== undefined) {
    if (!Array.isArray(raw.forwards)) return `${name}: forwards must be a list of ports`
    const ports = raw.forwards.map(port)
    if (ports.some((p) => p === null)) return `${name}: forwards must be ports 1-65535`
    forwards = [...new Set(ports as number[])]
  }
  const wake = argv(raw.wake)
  if (wake === false) return `${name}: wake must be a non-empty argv list`
  const sleep = argv(raw.sleep)
  if (sleep === false) return `${name}: sleep must be a non-empty argv list`
  const status = argv(raw.status)
  if (status === false) return `${name}: status must be a non-empty argv list`
  let statusOff = DEFAULT_STATUS_OFF
  if (raw.statusOff !== undefined) {
    if (typeof raw.statusOff !== 'string' || !raw.statusOff || !compiles(raw.statusOff))
      return `${name}: statusOff must be a regular expression`
    statusOff = raw.statusOff
  }
  let health: string[] = []
  if (raw.health !== undefined) {
    if (
      !Array.isArray(raw.health) ||
      raw.health.some((url) => typeof url !== 'string' || !HEALTH_URL.test(url))
    )
      return `${name}: health must be a list of http://127.0.0.1:<port>/<path> URLs`
    health = [...new Set(raw.health as string[])]
  }
  let wakeTimeoutSec = DEFAULT_WAKE_TIMEOUT_SEC
  if (raw.wakeTimeoutSec !== undefined) {
    const value = raw.wakeTimeoutSec
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 10 || value > 1_800)
      return `${name}: wakeTimeoutSec must be whole seconds, 10-1800`
    wakeTimeoutSec = value
  }
  let stateDir: string | null = null
  if (raw.stateDir !== undefined && raw.stateDir !== null) {
    stateDir = absolutePath(raw.stateDir)
    if (!stateDir) return `${name}: stateDir must be an absolute path`
  }
  return {
    name,
    ssh,
    socket,
    forwards,
    wake,
    sleep,
    status,
    statusOff,
    health,
    wakeTimeoutSec,
    stateDir,
  }
}

function unknownFields(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.keys(value).filter((key) => !FIELDS.has(key))
}

/** Validate the registry's JSON text. Bad entries are skipped with a reason
 * (their names are `held`); a duplicate name keeps the first entry. */
export function parseHosts(text: string): HostsLoad {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { hosts: [], errors: ['hosts.json is not valid JSON'], readable: false, held: [] }
  }
  if (!Array.isArray(value))
    return { hosts: [], errors: ['hosts.json must be a list'], readable: false, held: [] }
  const hosts: HostEntry[] = []
  const errors: string[] = []
  const held: string[] = []
  value.forEach((item, index) => {
    const entry = parseEntry(item, index)
    const extra = unknownFields(item)
    if (extra.length)
      errors.push(
        `${entryName(item) ?? `entry ${index}`}: ignoring unknown fields ${extra.join(', ')}`,
      )
    if (typeof entry === 'string') {
      errors.push(entry)
      const name = entryName(item)
      if (name && !held.includes(name)) held.push(name)
    } else if (hosts.some((host) => host.name === entry.name))
      errors.push(`${entry.name}: duplicate name; the first entry is used`)
    else hosts.push(entry)
  })
  return {
    hosts,
    errors,
    readable: true,
    held: held.filter((name) => !hosts.some((host) => host.name === name)),
  }
}

/** Read the registry. A missing file is no hosts and no error. */
export function loadHosts(path: string): HostsLoad {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { hosts: [], errors: [], readable: true, held: [] }
    return {
      hosts: [],
      errors: [`hosts.json could not be read: ${(error as Error).message}`],
      readable: false,
      held: [],
    }
  }
  return parseHosts(text)
}
