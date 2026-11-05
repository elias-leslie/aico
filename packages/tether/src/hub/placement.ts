// Host placement for agent launches (docs/plans/remote-hosts.md "Placement"):
// `POST /v1/roots` with `host: "auto"` and `needs` picks the first host, in the
// order of the chosen pool (`default` unless the create names one), whose live
// room fits the needs, or refuses with each host's reason. room = live free - owner reserve - open reservations. A host whose
// reading is missing, stale or failed is unknown and never placed on. There is
// no agent count anywhere: only memory, CPU and capabilities.
//
// Readings: this computer from Nightshift's admission file (green required);
// a remote VM from its own /proc (MemAvailable, PSI, CPUs, load) through the
// link's ssh master, plus its Proxmox node's free memory and storage (clones
// and ballooning draw on them). A powered-off VM counts only when Proxmox has
// room to start it; the create path then wakes it with hosts.json `wake`.
// A host with `room: "local"` (a container on this computer) is judged by this
// computer's reading and reserve, its reservations shared with `local`'s; with
// `capabilitiesOn: "local"` its capabilities are this computer's (the sandbox
// that owns its proxy and firewall runs here), read even while it sleeps.
//
// A create naming its host with `needs` is judged on that host alone and
// reserved there the same way (or refused at_capacity), never moved elsewhere.
//
// Reservations are held per placed root and released only on a definite end
// reported by the Tether that owns the root (no such root, ended, or its agent
// exited), never on a timer. They persist across a Tether restart. Decisions
// are serialized, so concurrent creates cannot both take the last room.

import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { availableParallelism, homedir, loadavg } from 'node:os'
import { isAbsolute, join, normalize } from 'node:path'
import type { HostEntry } from '@aico/fleet/hosts'
import { peerRequest } from '@aico/fleet/peer-http'
import {
  type AgentAdmissionLimits,
  admissionLimitsFromEnv,
  nightshiftAdmissionPath,
  parseMemAvailable,
  parseMemoryPressure,
} from '../lifecycle/agent-admission'
import { type Runner, type RunResult, remoteArgv, runCommand, shellQuote } from './host-admin'

const GIB = 1024 ** 3
/** The host name `--host auto` asks for; hosts.json cannot use it. */
export const AUTO_HOST = 'auto'
/** This computer in placement config and answers. */
export const LOCAL_HOST = 'local'
/** The pool a create without `pool` uses: `order`, plus hosts no pool lists. */
const DEFAULT_POOL = 'default'
const SETTINGS_KEY = 'placement_reservations'
const READ_MS = 10_000
const ROOT_QUERY_MS = 5_000
const MAX_CAPS = 8
const MAX_REASON = 240
const CAP = /^[a-z0-9][a-z0-9-]{0,31}$/
const NODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** What one launch needs: memory in bytes, CPUs, and capabilities by name. */
export interface Needs {
  memBytes: number
  cpu: number
  caps: string[]
}

/** `needs` on the wire: `{memBytes, cpu?, caps?}`. Null when malformed. */
export function parseNeeds(value: unknown): Needs | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).some((key) => !['memBytes', 'cpu', 'caps'].includes(key))) return null
  const { memBytes, cpu = 0, caps = [] } = raw
  if (typeof memBytes !== 'number' || !Number.isSafeInteger(memBytes) || memBytes < 0) return null
  if (memBytes > 4096 * GIB) return null
  if (typeof cpu !== 'number' || !Number.isFinite(cpu) || cpu < 0 || cpu > 1024) return null
  if (!Array.isArray(caps) || caps.length > MAX_CAPS) return null
  if (caps.some((cap) => typeof cap !== 'string' || !CAP.test(cap))) return null
  return { memBytes, cpu, caps: [...new Set(caps as string[])] }
}

// ---------------------------------------------------------------- config

export interface ProxmoxRef {
  /** ssh Host alias of the Proxmox node (root access, as `st vm` uses). */
  ssh: string
  node: string
  vmid: number
  /** The storage the VM's disks and clones live on; null skips the check. */
  storage: string | null
  /** Memory the Proxmox node keeps for itself and other guests. */
  reserveBytes: number
  /** Below this much free storage nothing is placed on the VM. */
  minFreeStorageBytes: number
}

/** The only shared room so far: this computer's. */
export type Room = typeof LOCAL_HOST

export interface HostPlacement {
  /** Memory the owner keeps free on this host. */
  reserveBytes: number
  /** CPUs the owner keeps free on this host. */
  reserveCpu: number
  proxmox: ProxmoxRef | null
  /** `local`: the host lives on this computer (a container), so this
   * computer's reading, reserve and reservations judge it; null otherwise. */
  room: Room | null
  /** `local`: this host's capabilities are probed on this computer, which owns
   * its sandbox (a container slot in a pod made here); null = on the host. */
  capabilitiesOn: Room | null
}

export interface CapabilityProbe {
  /** The marker file, absolute or relative to the host user's home. */
  marker: string
  /** Prints the host's current fingerprint; null = cannot compare (not ready). */
  fingerprint: string[] | null
}

export interface PlacementConfig {
  /** The default pool's hosts in the order they are tried; `local` is this computer. */
  order: string[]
  /** Every pool's hosts in order, `default` (= `order`) included. */
  pools: Record<string, string[]>
  hosts: Record<string, HostPlacement>
  capabilities: Record<string, CapabilityProbe>
  /** One plain line per thing in the file that was not usable. */
  errors: string[]
}

/** Overridable defaults; the owner's values live in placement.json. */
const DEFAULT_LOCAL: HostPlacement = {
  reserveBytes: 6 * GIB,
  reserveCpu: 2,
  proxmox: null,
  room: null,
  capabilitiesOn: null,
}
const DEFAULT_REMOTE: HostPlacement = {
  reserveBytes: 2 * GIB,
  reserveCpu: 1,
  proxmox: null,
  room: null,
  capabilitiesOn: null,
}
/** A `room: "local"` host's own reserve, taken on top of this computer's. */
const DEFAULT_ROOM_LOCAL = { reserveBytes: 0, reserveCpu: 0 }
const DEFAULT_PVE_RESERVE = 2 * GIB
const DEFAULT_MIN_STORAGE = 20 * GIB
/** Neri's live-ready marker (plan contract 4). */
const DEFAULT_CAPABILITIES: Record<string, CapabilityProbe> = {
  'live-ready': { marker: '.local/state/neri-proxy/live-ready.json', fingerprint: null },
}

/** `$TETHER_PLACEMENT_FILE`, else `$XDG_CONFIG_HOME/tether/placement.json`. */
function placementFilePath(env: NodeJS.ProcessEnv): string {
  if (env.TETHER_PLACEMENT_FILE) return env.TETHER_PLACEMENT_FILE
  const configRoot = env.XDG_CONFIG_HOME || join(env.HOME ?? homedir(), '.config')
  return join(configRoot, 'tether', 'placement.json')
}

function gib(value: unknown, fallback: number): number | null {
  if (value === undefined) return fallback
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 4096
    ? Math.round(value * GIB)
    : null
}

function count(value: unknown, fallback: number): number | null {
  if (value === undefined) return fallback
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1024
    ? value
    : null
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function parseProxmoxRef(value: unknown): ProxmoxRef | string | null {
  if (value === undefined || value === null) return null
  const raw = record(value)
  if (!raw) return 'proxmox must be an object'
  const { ssh, node, vmid, storage = null } = raw
  if (typeof ssh !== 'string' || !NODE.test(ssh)) return 'proxmox.ssh must be an ssh Host alias'
  if (typeof node !== 'string' || !NODE.test(node)) return 'proxmox.node must be a node name'
  if (typeof vmid !== 'number' || !Number.isSafeInteger(vmid) || vmid < 100 || vmid > 999_999_999)
    return 'proxmox.vmid must be a VM id'
  if (storage !== null && (typeof storage !== 'string' || !NODE.test(storage)))
    return 'proxmox.storage must be a storage name'
  const reserveBytes = gib(raw.reserveGiB, DEFAULT_PVE_RESERVE)
  const minFreeStorageBytes = gib(raw.minFreeStorageGiB, DEFAULT_MIN_STORAGE)
  if (reserveBytes === null) return 'proxmox.reserveGiB must be 0-4096'
  if (minFreeStorageBytes === null) return 'proxmox.minFreeStorageGiB must be 0-4096'
  return { ssh, node, vmid, storage, reserveBytes, minFreeStorageBytes }
}

/** Validate placement.json against the hosts.json names. A missing or broken
 * file gives the defaults: this computer first, then hosts.json's order. */
export function parsePlacement(text: string | null, hostNames: string[]): PlacementConfig {
  const errors: string[] = []
  const fallbackOrder = [LOCAL_HOST, ...hostNames]
  let raw: Record<string, unknown> | null = null
  if (text !== null) {
    try {
      raw = record(JSON.parse(text))
      if (!raw) errors.push('placement.json must be an object')
    } catch {
      errors.push('placement.json is not valid JSON')
    }
  }
  const names = (value: unknown, field: string): string[] | null => {
    if (value === undefined) return null
    if (
      Array.isArray(value) &&
      value.every((name) => typeof name === 'string' && name.length > 0 && name.length <= 32)
    )
      return [...new Set(value as string[])]
    errors.push(`${field} must be a list of host names`)
    return null
  }
  // Named pools hold exactly the hosts they list, in that order.
  const skip = new Set(names(raw?.skip, 'skip') ?? [])
  const rawPools = record(raw?.pools) ?? {}
  if (raw?.pools !== undefined && !record(raw.pools)) errors.push('pools must be an object')
  const pools: Record<string, string[]> = {}
  for (const [pool, value] of Object.entries(rawPools)) {
    if (pool === DEFAULT_POOL) continue
    if (!CAP.test(pool)) {
      errors.push(`pools.${clean(pool, 40)}: a pool name is lowercase letters, digits and dashes`)
      continue
    }
    const members = names(value, `pools.${pool}`)
    if (members) pools[pool] = members.filter((name) => !skip.has(name))
  }
  // The default pool: `pools.default` (else `order`) first; a host no list
  // names follows in hosts.json order, so a new host is tried rather than
  // silently ignored. `skip` leaves a host out on purpose.
  const pooled = new Set(Object.values(pools).flat())
  const listed =
    (rawPools[DEFAULT_POOL] !== undefined
      ? names(rawPools[DEFAULT_POOL], `pools.${DEFAULT_POOL}`)
      : names(raw?.order, 'order')) ?? []
  if (rawPools[DEFAULT_POOL] !== undefined && raw?.order !== undefined)
    errors.push(`order and pools.${DEFAULT_POOL} are both set; using pools.${DEFAULT_POOL}`)
  const order = [
    ...new Set([...listed, ...fallbackOrder.filter((name) => !pooled.has(name))]),
  ].filter((name) => !skip.has(name))
  pools[DEFAULT_POOL] = order
  const hosts: Record<string, HostPlacement> = {}
  const rawHosts = record(raw?.hosts) ?? {}
  if (raw?.hosts !== undefined && !record(raw.hosts)) errors.push('hosts must be an object')
  for (const name of new Set([...Object.values(pools).flat(), ...Object.keys(rawHosts)])) {
    const fallback = name === LOCAL_HOST ? DEFAULT_LOCAL : DEFAULT_REMOTE
    const entry = rawHosts[name]
    if (entry === undefined) {
      hosts[name] = { ...fallback }
      continue
    }
    const value = record(entry)
    const room = value?.room === undefined || value.room === null ? null : value.room
    const shared = room === LOCAL_HOST && name !== LOCAL_HOST
    const capsOn =
      value?.capabilitiesOn === undefined || value.capabilitiesOn === null
        ? null
        : value.capabilitiesOn
    const own = shared ? DEFAULT_ROOM_LOCAL : fallback
    const reserveBytes = gib(value?.reserveGiB, own.reserveBytes)
    const reserveCpu = count(value?.reserveCpu, own.reserveCpu)
    const proxmox = parseProxmoxRef(value?.proxmox)
    const problem = !value
      ? 'must be an object'
      : room !== null && !shared
        ? name === LOCAL_HOST
          ? 'room is for hosts that share this computer'
          : 'room must be "local"'
        : reserveBytes === null
          ? 'reserveGiB must be 0-4096'
          : reserveCpu === null
            ? 'reserveCpu must be 0-1024'
            : typeof proxmox === 'string'
              ? proxmox
              : name === LOCAL_HOST && proxmox
                ? 'proxmox is for remote hosts'
                : shared && proxmox
                  ? 'room and proxmox do not go together'
                  : capsOn !== null && capsOn !== LOCAL_HOST
                    ? 'capabilitiesOn must be "local"'
                    : capsOn !== null && !shared
                      ? 'capabilitiesOn "local" goes with room "local"'
                      : null
    if (problem) {
      // A broken entry keeps the defaults' reserve, so nothing is placed more
      // freely; a host that meant to share this computer stays unknown.
      errors.push(`hosts.${name}: ${problem}; using the defaults`)
      hosts[name] = { ...fallback }
    } else
      hosts[name] = {
        reserveBytes: reserveBytes as number,
        reserveCpu: reserveCpu as number,
        proxmox: proxmox as ProxmoxRef | null,
        room: shared ? LOCAL_HOST : null,
        capabilitiesOn: capsOn === LOCAL_HOST ? LOCAL_HOST : null,
      }
  }
  const capabilities: Record<string, CapabilityProbe> = { ...DEFAULT_CAPABILITIES }
  const rawCaps = record(raw?.capabilities) ?? {}
  for (const [name, entry] of Object.entries(rawCaps)) {
    const value = record(entry)
    const marker = value?.marker
    const fingerprint = value?.fingerprint ?? null
    const markerOk =
      typeof marker === 'string' &&
      marker.length > 0 &&
      normalize(marker) === marker &&
      !marker.startsWith('..') &&
      !/[\s\0'"\\$`]/.test(marker)
    const fingerprintOk =
      fingerprint === null ||
      (Array.isArray(fingerprint) &&
        fingerprint.length > 0 &&
        fingerprint.every((arg) => typeof arg === 'string' && arg && !arg.includes('\0')))
    if (!CAP.test(name) || !markerOk || !fingerprintOk) {
      errors.push(`capabilities.${name}: needs a marker path and a fingerprint argv or null`)
      continue
    }
    capabilities[name] = { marker: marker as string, fingerprint: fingerprint as string[] | null }
  }
  return { order, pools, hosts, capabilities, errors }
}

function loadPlacement(path: string, hostNames: string[]): PlacementConfig {
  let text: string | null = null
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      return {
        ...parsePlacement(null, hostNames),
        errors: [`placement.json could not be read: ${(error as Error).message}`],
      }
  }
  return parsePlacement(text, hostNames)
}

// ---------------------------------------------------------------- readings

/** Nightshift's admission file, read for placement: memory is unknown unless fresh. */
export interface LocalAdmission {
  state: 'green' | 'amber' | 'red'
  reason: string
  memAvailableBytes: number
}

export function parseLocalAdmission(text: string, nowMs: number): LocalAdmission | null {
  let value: Record<string, unknown> | null
  try {
    value = record(JSON.parse(text))
  } catch {
    return null
  }
  if (value?.v !== 1) return null
  const { state, expires_at: expiresAt, mem_available_gib: available, reason } = value
  if (typeof expiresAt !== 'number' || expiresAt * 1000 <= nowMs) return null
  if (state !== 'green' && state !== 'amber' && state !== 'red') return null
  if (typeof available !== 'number' || !Number.isFinite(available) || available < 0) return null
  return {
    state,
    reason: typeof reason === 'string' ? clean(reason, 160) : '',
    memAvailableBytes: Math.round(available * GIB),
  }
}

/** A VM's own readings. */
export interface GuestReading {
  memAvailableBytes: number
  psi: { someAvg60: number; fullAvg60: number; fullAvg10: number }
  cpus: number
  load5: number
}

const SEPARATOR = '@@tether-placement@@'
/** One shell line on the guest: meminfo, PSI, load average and CPUs. */
export const GUEST_LINE = [
  'cat /proc/meminfo',
  'cat /proc/pressure/memory',
  'cat /proc/loadavg',
  'nproc',
].join(`; echo ${SEPARATOR}; `)

export function parseGuest(stdout: string): GuestReading {
  const parts = stdout.split(`${SEPARATOR}\n`)
  if (parts.length !== 4) throw new Error('the reading is incomplete')
  const [meminfo, pressure, load, nproc] = parts as [string, string, string, string]
  const loads = /^([0-9]+\.[0-9]+) ([0-9]+\.[0-9]+) /.exec(load)
  const cpus = Number(nproc.trim())
  if (!loads || !Number.isSafeInteger(cpus) || cpus < 1) throw new Error('load or CPUs unreadable')
  return {
    memAvailableBytes: parseMemAvailable(meminfo),
    psi: parseMemoryPressure(pressure),
    cpus,
    load5: Number(loads[2]),
  }
}

/** The Proxmox node and VM, as `pvesh` reports them. */
export interface ProxmoxReading {
  nodeAvailableBytes: number
  vmStatus: string
  vmMaxMemBytes: number
  vmCpus: number
  storageAvailBytes: number | null
}

function proxmoxLine(ref: ProxmoxRef): string {
  const get = (path: string) => `pvesh get ${path} --output-format json`
  const parts = [
    get(`/nodes/${ref.node}/status`),
    get(`/nodes/${ref.node}/qemu/${ref.vmid}/status/current`),
  ]
  if (ref.storage) parts.push(get(`/nodes/${ref.node}/storage/${ref.storage}/status`))
  return parts.join(`; echo; echo ${SEPARATOR}; `)
}

function bytes(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function parseProxmox(stdout: string, ref: ProxmoxRef): ProxmoxReading {
  const parts = stdout.split(`${SEPARATOR}\n`)
  if (parts.length !== (ref.storage ? 3 : 2)) throw new Error('the reading is incomplete')
  const docs = parts.map((part) => record(JSON.parse(part)))
  const [node, vm, storage] = docs
  const memory = record(node?.memory)
  const available = bytes(memory?.available) ?? bytes(memory?.free)
  const maxmem = bytes(vm?.maxmem)
  const cpus = bytes(vm?.cpus)
  if (available === null || maxmem === null || cpus === null || typeof vm?.status !== 'string')
    throw new Error('node or VM fields missing')
  const avail = ref.storage ? bytes(storage?.avail) : null
  if (ref.storage && avail === null) throw new Error('storage fields missing')
  return {
    nodeAvailableBytes: available,
    vmStatus: vm.status,
    vmMaxMemBytes: maxmem,
    vmCpus: cpus,
    storageAvailBytes: avail,
  }
}

/** What a capability probe found on a host. */
export type CapabilityResult = { ok: true } | { ok: false; reason: string }

/** The marker and the current fingerprint, compared (plan contract 4). */
export function judgeCapability(
  name: string,
  probe: CapabilityProbe,
  marker: string | null,
  current: RunResult | null,
): CapabilityResult {
  if (marker === null) return { ok: false, reason: `not ${name}: no marker` }
  let fingerprint: unknown
  try {
    fingerprint = record(JSON.parse(marker))?.fingerprint
  } catch {
    return { ok: false, reason: `not ${name}: the marker does not parse` }
  }
  if (typeof fingerprint !== 'string' || !fingerprint)
    return { ok: false, reason: `not ${name}: the marker has no fingerprint` }
  if (!probe.fingerprint)
    return { ok: false, reason: `not ${name}: no fingerprint command is configured to compare` }
  if (current?.code !== 0)
    return {
      ok: false,
      reason: `not ${name}: the fingerprint command failed${current?.output ? ` (${clean(current.output, 80)})` : ''}`,
    }
  if (current.stdout.trim() !== fingerprint)
    return { ok: false, reason: `not ${name}: the fingerprint changed since the suite passed` }
  return { ok: true }
}

// ---------------------------------------------------------------- decision

export interface Reservation {
  requestId: string
  host: string
  memBytes: number
  cpu: number
  at: number
  /** `placing` while its create runs (never released then); `held` after. */
  state: 'placing' | 'held'
}

/** What the owning Tether says about a placed root. */
export type RootFate = 'live' | 'missing' | 'ended' | 'exited' | 'unknown'

/** A root on this computer, from the catalog: no request, no session, or its
 * agent's exit marker (`started` while it runs; `exit` or `signal` once it ended). */
export function localRootFate(
  hasRequest: boolean,
  hasSession: boolean,
  exitState: string | null | undefined,
): RootFate {
  if (!hasRequest) return 'missing'
  if (!hasSession) return 'ended'
  return exitState === 'exit' || exitState === 'signal' ? 'exited' : 'live'
}

/** A remote host as the hub knows it. */
export interface PeerView {
  entry: HostEntry
  live: boolean
  state: string
  socket: string
  control: string
}

export interface HostVerdict {
  host: string
  fits: boolean
  /** One plain line: the room, or why nothing goes there. */
  reason: string
  /** Room left before this launch; null when the host is unknown. */
  room: { memGiB: number; cpu: number } | null
  /** The create has to power the host on first. */
  wake?: boolean
}

export interface PlacementDeps {
  env: NodeJS.ProcessEnv
  hostNames(): string[]
  peer(name: string): PeerView | null
  /** A host taken out of hosts.json (src/hub/hub.ts `retired`): not one
   * only briefly missing, invalid or unread, nor any while the hub is off. */
  retired?(name: string): boolean
  /** Fate of a root this computer owns. */
  localRoot(requestId: string): RootFate
  /** The host already holding this root (null = this computer), else undefined. */
  existingHost(requestId: string): string | null | undefined
  settings: { get(key: string): string | null; put(key: string, value: string): void }
  run?: Runner
  readText?(path: string): Promise<string>
  cpu?(): { cpus: number; load5: number }
  limits?(): AgentAdmissionLimits
  remoteRoot?(peer: PeerView, requestId: string): Promise<RootFate>
  now?(): number
  log?(message: string): void
}

export type PlaceResult =
  | { kind: 'placed'; host: string | null; verdicts: HostVerdict[]; done(): void }
  | { kind: 'at_capacity'; verdicts: HostVerdict[] }
  | { kind: 'unknown_pool'; pools: string[]; verdicts: [] }
  /** The named host is neither `local` nor in hosts.json. */
  | { kind: 'unknown_host'; host: string; verdicts: [] }
  /** The request is already placed on (or held by) another host. */
  | { kind: 'placed_elsewhere'; host: string; verdicts: [] }

/** A pool placement.json does not define; `pools` names the ones it does. */
export class UnknownPool extends Error {
  constructor(
    readonly pool: string,
    readonly pools: string[],
  ) {
    super(`no placement pool ${pool}`)
  }
}

/** `pool` on the wire: a pool name, or null when malformed. Absent = default. */
export function parsePool(value: unknown): string | null {
  if (value === undefined) return DEFAULT_POOL
  return typeof value === 'string' && CAP.test(value) ? value : null
}

function clean(text: string, max = MAX_REASON): string {
  const line = text.replace(/[^\x20-\x7e]+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function g(value: number): string {
  return (Math.round((value / GIB) * 10) / 10).toFixed(1)
}

function c(value: number): string {
  return String(Math.round(value * 10) / 10)
}

async function remoteRootFate(peer: PeerView, requestId: string): Promise<RootFate> {
  if (!peer.live) return 'unknown'
  try {
    const answer = await peerRequest(
      peer.socket,
      'GET',
      `/v1/roots/${encodeURIComponent(requestId)}`,
      undefined,
      ROOT_QUERY_MS,
    )
    if (answer.status === 404) return 'missing'
    const body = record(answer.body)
    if (answer.status !== 200 || !body) return 'unknown'
    if (body.status === 'ended') return 'ended'
    return body.agentExit ? 'exited' : 'live'
  } catch {
    return 'unknown'
  }
}

export class Placement {
  private tail: Promise<void> = Promise.resolve()
  private readonly reservations: Reservation[]
  private readonly run: Runner
  private readonly readText: (path: string) => Promise<string>
  private readonly cpu: () => { cpus: number; load5: number }
  private readonly limits: () => AgentAdmissionLimits
  private readonly remoteRoot: (peer: PeerView, requestId: string) => Promise<RootFate>
  private readonly now: () => number
  private readonly log: (message: string) => void

  constructor(private readonly deps: PlacementDeps) {
    this.run = deps.run ?? runCommand
    this.readText = deps.readText ?? ((path) => readFile(path, 'utf8'))
    this.cpu = deps.cpu ?? (() => ({ cpus: availableParallelism(), load5: loadavg()[1] ?? 0 }))
    this.limits = deps.limits ?? (() => admissionLimitsFromEnv(deps.env))
    this.remoteRoot = deps.remoteRoot ?? remoteRootFate
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? ((message) => console.log(`[tether:placement] ${message}`))
    this.reservations = this.load()
  }

  private load(): Reservation[] {
    try {
      const value = JSON.parse(this.deps.settings.get(SETTINGS_KEY) ?? '[]')
      if (!Array.isArray(value)) return []
      // A create that was running when Tether stopped is judged by its root.
      return value
        .filter(
          (item) =>
            record(item) &&
            typeof item.requestId === 'string' &&
            typeof item.host === 'string' &&
            typeof item.memBytes === 'number' &&
            typeof item.cpu === 'number',
        )
        .map((item) => ({ ...item, state: 'held' as const }))
    } catch {
      return []
    }
  }

  private persist(): void {
    this.deps.settings.put(SETTINGS_KEY, JSON.stringify(this.reservations))
  }

  /** Open reservations, for the API and tests. */
  list(): Reservation[] {
    return this.reservations.map((item) => ({ ...item }))
  }

  private locked<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action)
    this.tail = result.then(
      () => {},
      () => {},
    )
    return result
  }

  private config(): PlacementConfig {
    const config = loadPlacement(placementFilePath(this.deps.env), this.deps.hostNames())
    for (const error of config.errors) this.log(error)
    return config
  }

  /** Release the reservations whose root has definitely ended, and those on
   * a host taken out of hosts.json (it can take no launch, so its room counts
   * for nothing). A host only briefly missing keeps them. */
  private async reconcile(): Promise<void> {
    const held = this.reservations.filter((item) => item.state === 'held')
    const fates = await Promise.all(
      held.map(async (item): Promise<RootFate | 'retired'> => {
        if (item.host === LOCAL_HOST) return this.deps.localRoot(item.requestId)
        const peer = this.deps.peer(item.host)
        if (peer) return this.remoteRoot(peer, item.requestId)
        return this.deps.retired?.(item.host) ? 'retired' : 'unknown'
      }),
    )
    let changed = false
    held.forEach((item, index) => {
      const fate = fates[index]
      if (fate === 'missing' || fate === 'ended' || fate === 'exited' || fate === 'retired') {
        this.reservations.splice(this.reservations.indexOf(item), 1)
        this.log(
          `released ${item.requestId} on ${item.host} (${fate === 'retired' ? 'host no longer in hosts.json' : fate})`,
        )
        changed = true
      }
    })
    if (changed) this.persist()
  }

  /** Drop a stopped host's held reservations; in-flight `placing` ones stay. */
  private releaseStopped(host: string): void {
    const gone = this.reservations.filter((item) => item.host === host && item.state === 'held')
    if (!gone.length) return
    for (const item of gone) {
      this.reservations.splice(this.reservations.indexOf(item), 1)
      this.log(`released ${item.requestId} on ${host} (host powered off)`)
    }
    this.persist()
  }

  private held(hosts: (name: string) => boolean): { mem: number; cpu: number } {
    let mem = 0
    let cpu = 0
    for (const item of this.reservations)
      if (hosts(item.host)) {
        mem += item.memBytes
        cpu += item.cpu
      }
    return { mem, cpu }
  }

  /** This computer and every `room: "local"` host: one room, counted once. */
  private inLocalRoom(config: PlacementConfig): (name: string) => boolean {
    return (name) => name === LOCAL_HOST || config.hosts[name]?.room === LOCAL_HOST
  }

  /** Hosts on the same Proxmox node, whose reservations all draw on it. */
  private onNode(config: PlacementConfig, ref: ProxmoxRef): (name: string) => boolean {
    return (name) => {
      const other = config.hosts[name]?.proxmox
      return Boolean(other && other.ssh === ref.ssh && other.node === ref.node)
    }
  }

  private verdict(
    host: string,
    needs: Needs,
    room: { mem: number; cpu: number },
    detail: string,
    wake = false,
  ): HostVerdict {
    const fits = room.mem >= needs.memBytes && room.cpu >= needs.cpu
    const short = !fits
      ? `${room.mem < needs.memBytes ? `needs ${g(needs.memBytes)} GiB, has ${g(Math.max(0, room.mem))} GiB room` : ''}${
          room.mem < needs.memBytes && room.cpu < needs.cpu ? '; ' : ''
        }${room.cpu < needs.cpu ? `needs ${c(needs.cpu)} CPUs, has ${c(Math.max(0, room.cpu))} free` : ''}`
      : `${g(room.mem)} GiB and ${c(Math.max(0, room.cpu))} CPUs room`
    return {
      host,
      fits,
      reason: clean(`${short} (${detail})`),
      room: { memGiB: Number(g(room.mem)), cpu: Math.round(room.cpu * 10) / 10 },
      ...(wake ? { wake: true } : {}),
    }
  }

  private unknown(host: string, reason: string): HostVerdict {
    return { host, fits: false, reason: clean(reason), room: null }
  }

  private async capabilities(
    config: PlacementConfig,
    needs: Needs,
    read: (probe: CapabilityProbe) => Promise<[string | null, RunResult | null]>,
  ): Promise<string | null> {
    for (const cap of needs.caps) {
      const probe = config.capabilities[cap]
      if (!probe) return `unknown capability ${cap}`
      const [marker, current] = await read(probe)
      const result = judgeCapability(cap, probe, marker, current)
      if (!result.ok) return result.reason
    }
    return null
  }

  /** This computer's room as Nightshift reads it, less its reserve and the
   * reservations on it and on every host that shares it; or why it is unknown. */
  private async localRoom(
    config: PlacementConfig,
  ): Promise<{ mem: number; cpu: number; detail: string } | string> {
    const path = nightshiftAdmissionPath(this.deps.env)
    let reading: LocalAdmission | null = null
    if (path) reading = parseLocalAdmission(await this.readText(path).catch(() => ''), this.now())
    if (!reading) return "Nightshift's memory reading is missing or stale"
    if (reading.state !== 'green') return `Nightshift says ${reading.state}: ${reading.reason}`
    const own = config.hosts[LOCAL_HOST] ?? DEFAULT_LOCAL
    const held = this.held(this.inLocalRoom(config))
    const cpu = this.cpu()
    return {
      mem: reading.memAvailableBytes - own.reserveBytes - held.mem,
      cpu: cpu.cpus - cpu.load5 - own.reserveCpu - held.cpu,
      detail: `${g(reading.memAvailableBytes)} free - ${g(own.reserveBytes)} reserve - ${g(held.mem)} held`,
    }
  }

  /** Capabilities read on this computer: its marker and its fingerprint command. */
  private localCapabilities(config: PlacementConfig, needs: Needs): Promise<string | null> {
    const home = this.deps.env.HOME ?? homedir()
    return this.capabilities(config, needs, async (probe) => {
      const markerPath = isAbsolute(probe.marker) ? probe.marker : join(home, probe.marker)
      const marker = await this.readText(markerPath).catch(() => null)
      const current =
        marker !== null && probe.fingerprint ? await this.run(probe.fingerprint, READ_MS) : null
      return [marker, current]
    })
  }

  private async judgeLocal(config: PlacementConfig, needs: Needs): Promise<HostVerdict> {
    const room = await this.localRoom(config)
    if (typeof room === 'string') return this.unknown(LOCAL_HOST, room)
    const missing = await this.localCapabilities(config, needs)
    if (missing) return this.unknown(LOCAL_HOST, missing)
    return this.verdict(LOCAL_HOST, needs, room, room.detail)
  }

  /** Capabilities read on a host over its link. */
  private remoteCapabilities(
    config: PlacementConfig,
    peer: PeerView,
    needs: Needs,
  ): Promise<string | null> {
    return this.capabilities(config, needs, async (probe) => {
      const markerPath = isAbsolute(probe.marker) ? probe.marker : `"$HOME"/${probe.marker}`
      const markerRun = await this.readGuest(peer, `cat ${markerPath}`)
      const marker = markerRun.code === 0 ? markerRun.stdout : null
      const current =
        marker !== null && probe.fingerprint
          ? await this.readGuest(peer, probe.fingerprint.map(shellQuote).join(' '))
          : null
      return [marker, current]
    })
  }

  /** A host in this computer's room (a container): its own /proc would show
   * this computer's memory again, so Nightshift's reading judges it, less the
   * local reserve, the room's reservations and the host's own reserve. A
   * powered-off one with `wake` fits by that room. Capabilities are read on
   * this computer with `capabilitiesOn: "local"` (asleep too), else over the
   * host's link once it runs. */
  private async judgeLocalRoom(
    config: PlacementConfig,
    name: string,
    needs: Needs,
  ): Promise<HostVerdict> {
    const peer = this.deps.peer(name)
    if (!peer) return this.unknown(name, 'not in hosts.json')
    const local = await this.localRoom(config)
    if (typeof local === 'string') return this.unknown(name, `shares this computer: ${local}`)
    const own = config.hosts[name] ?? { ...DEFAULT_REMOTE, ...DEFAULT_ROOM_LOCAL }
    const room = { mem: local.mem - own.reserveBytes, cpu: local.cpu - own.reserveCpu }
    const extra = own.reserveBytes > 0 ? ` - ${g(own.reserveBytes)} own reserve` : ''
    const detail = `this computer's room: ${local.detail}${extra}`
    const capsHere = own.capabilitiesOn === LOCAL_HOST
    if (capsHere && needs.caps.length) {
      const missing = await this.localCapabilities(config, needs)
      if (missing) return this.unknown(name, `checked on this computer: ${missing}`)
    }
    if (!peer.live) {
      if (peer.state !== 'powered_off')
        return this.unknown(name, `running but its link is ${peer.state.replace('_', ' ')}`)
      if (needs.caps.length && !capsHere)
        return this.unknown(name, `powered off, so ${needs.caps.join(', ')} cannot be checked`)
      if (!peer.entry.wake) return this.unknown(name, 'powered off and hosts.json has no wake')
      return this.verdict(name, needs, room, `powered off, starts in ${detail}`, true)
    }
    if (!capsHere) {
      const missing = await this.remoteCapabilities(config, peer, needs)
      if (missing) return this.unknown(name, missing)
    }
    return this.verdict(name, needs, room, detail)
  }

  private async readGuest(peer: PeerView, line: string): Promise<RunResult> {
    return this.run(remoteArgv(peer.entry, peer.control, line), READ_MS)
  }

  private async judgeRemote(
    config: PlacementConfig,
    name: string,
    needs: Needs,
  ): Promise<HostVerdict> {
    const peer = this.deps.peer(name)
    if (!peer) return this.unknown(name, 'not in hosts.json')
    const own = config.hosts[name] ?? DEFAULT_REMOTE
    let held = this.held((host) => host === name)
    const ref = own.proxmox
    let pve: ProxmoxReading | null = null
    let pveRoom = Number.POSITIVE_INFINITY
    let pveDetail = ''
    if (ref) {
      const authority = this.deps.peer(ref.ssh)
      if (!authority?.live) return this.unknown(name, `Proxmox authority ${ref.ssh} is not linked`)
      const result = await this.readGuest(authority, proxmoxLine(ref))
      if (result.code !== 0)
        return this.unknown(name, `the Proxmox reading failed (${clean(result.output, 80)})`)
      try {
        pve = parseProxmox(result.stdout, ref)
      } catch (error) {
        return this.unknown(name, `the Proxmox reading is unreadable: ${(error as Error).message}`)
      }
      if (pve.storageAvailBytes !== null && pve.storageAvailBytes < ref.minFreeStorageBytes)
        return this.unknown(
          name,
          `Proxmox storage ${ref.storage} has ${g(pve.storageAvailBytes)} GiB free, below ${g(ref.minFreeStorageBytes)} GiB`,
        )
      // A powered-off VM has no roots: what it still holds is from roots that ended
      // while it could not answer. Drop those, or they shrink its room until it is
      // never picked and so never woken. A create in flight (`placing`) stays.
      if (pve.vmStatus === 'stopped') {
        this.releaseStopped(name)
        held = this.held((host) => host === name)
      }
      const nodeHeld = this.held(this.onNode(config, ref))
      pveRoom = pve.nodeAvailableBytes - ref.reserveBytes - nodeHeld.mem
      pveDetail = `; Proxmox ${g(pve.nodeAvailableBytes)} free - ${g(ref.reserveBytes)} reserve - ${g(nodeHeld.mem)} held`
    }
    if (pve && pve.vmStatus === 'stopped') {
      if (needs.caps.length)
        return this.unknown(name, `powered off, so ${needs.caps.join(', ')} cannot be checked`)
      if (!peer.entry.wake) return this.unknown(name, 'powered off and hosts.json has no wake')
      if (pveRoom < pve.vmMaxMemBytes)
        return this.unknown(
          name,
          `powered off; starting it needs ${g(pve.vmMaxMemBytes)} GiB and Proxmox has ${g(Math.max(0, pveRoom))} GiB room${pveDetail}`,
        )
      return this.verdict(
        name,
        needs,
        {
          mem: pve.vmMaxMemBytes - own.reserveBytes - held.mem,
          cpu: pve.vmCpus - own.reserveCpu - held.cpu,
        },
        `powered off, starts with ${g(pve.vmMaxMemBytes)} - ${g(own.reserveBytes)} reserve - ${g(held.mem)} held${pveDetail}`,
        true,
      )
    }
    if (pve && pve.vmStatus !== 'running')
      return this.unknown(name, `Proxmox says the VM is ${clean(pve.vmStatus, 20)}`)
    if (!peer.live) {
      const state = peer.state === 'powered_off' && pve ? 'not connected' : peer.state
      return this.unknown(
        name,
        state === 'powered_off'
          ? 'powered off and no Proxmox reading is configured'
          : `running but its link is ${state.replace('_', ' ')}`,
      )
    }
    const result = await this.readGuest(peer, GUEST_LINE)
    if (result.code !== 0)
      return this.unknown(name, `its reading failed (${clean(result.output, 80)})`)
    let guest: GuestReading
    try {
      guest = parseGuest(result.stdout)
    } catch (error) {
      return this.unknown(name, `its reading is unreadable: ${(error as Error).message}`)
    }
    const limits = this.limits()
    const psi = guest.psi
    if (
      psi.fullAvg10 >= limits.maxFullAvg10 ||
      psi.fullAvg60 >= limits.maxFullAvg60 ||
      psi.someAvg60 >= limits.maxSomeAvg60
    )
      return this.unknown(
        name,
        `memory pressure (PSI some avg60 ${psi.someAvg60}, full avg10 ${psi.fullAvg10})`,
      )
    const missing = await this.remoteCapabilities(config, peer, needs)
    if (missing) return this.unknown(name, missing)
    const guestRoom = guest.memAvailableBytes - own.reserveBytes - held.mem
    return this.verdict(
      name,
      needs,
      {
        mem: Math.min(guestRoom, pveRoom),
        cpu: guest.cpus - guest.load5 - own.reserveCpu - held.cpu,
      },
      `${g(guest.memAvailableBytes)} free - ${g(own.reserveBytes)} reserve - ${g(held.mem)} held${pveDetail}`,
    )
  }

  private async judge(config: PlacementConfig, name: string, needs: Needs): Promise<HostVerdict> {
    try {
      if (name === LOCAL_HOST) return await this.judgeLocal(config, needs)
      if (config.hosts[name]?.room === LOCAL_HOST)
        return await this.judgeLocalRoom(config, name, needs)
      return await this.judgeRemote(config, name, needs)
    } catch (error) {
      return this.unknown(name, `its reading failed: ${(error as Error).message}`)
    }
  }

  private poolOrder(config: PlacementConfig, pool: string): string[] {
    const order = Object.hasOwn(config.pools, pool) ? config.pools[pool] : undefined
    if (!order) throw new UnknownPool(pool, Object.keys(config.pools).sort())
    return order
  }

  /** Every host's verdict in the pool's order, without reserving (the dry
   * run). Rejects with UnknownPool for a pool placement.json lacks. */
  check(needs: Needs, pool = DEFAULT_POOL): Promise<HostVerdict[]> {
    return this.locked(async () => {
      const config = this.config()
      const order = this.poolOrder(config, pool)
      await this.reconcile()
      const verdicts: HostVerdict[] = []
      for (const name of order) verdicts.push(await this.judge(config, name, needs))
      return verdicts
    })
  }

  /**
   * Pick a host from the pool and reserve the needs there, as one serialized
   * step. The first host in the pool's order that fits wins; the rest are not
   * read. With `host` (a create that names its host) only that host is judged,
   * and the pool is not used. Reservations are per host, whatever pool placed
   * them. A request already placed (a retry) goes to the same host without a
   * new reservation; one naming a different host than it holds is refused.
   * Call `done()` once the create has answered, whatever the answer.
   */
  place(requestId: string, needs: Needs, pool = DEFAULT_POOL, host?: string): Promise<PlaceResult> {
    return this.locked(async () => {
      const config = this.config()
      let order: string[]
      if (host !== undefined) {
        if (host !== LOCAL_HOST && !this.deps.peer(host))
          return { kind: 'unknown_host', host, verdicts: [] } as const
        order = [host]
      } else
        try {
          order = this.poolOrder(config, pool)
        } catch (error) {
          if (error instanceof UnknownPool)
            return { kind: 'unknown_pool', pools: error.pools, verdicts: [] } as const
          throw error
        }
      const existing = this.reservations.find((item) => item.requestId === requestId)
      const known = existing ? existing.host : this.deps.existingHost(requestId)
      if (known !== undefined) {
        const name = known ?? LOCAL_HOST
        if (host !== undefined && name !== host)
          return { kind: 'placed_elsewhere', host: name, verdicts: [] } as const
        return {
          kind: 'placed',
          host: name === LOCAL_HOST ? null : name,
          verdicts: [],
          done: () => {},
        } as const
      }
      const where =
        host !== undefined ? ' (named host)' : pool === DEFAULT_POOL ? '' : ` (pool ${pool})`
      await this.reconcile()
      const verdicts: HostVerdict[] = []
      for (const name of order) {
        const verdict = await this.judge(config, name, needs)
        verdicts.push(verdict)
        if (!verdict.fits) continue
        const reservation: Reservation = {
          requestId,
          host: name,
          memBytes: needs.memBytes,
          cpu: needs.cpu,
          at: this.now(),
          state: 'placing',
        }
        this.reservations.push(reservation)
        this.persist()
        this.log(
          `placed ${requestId} on ${name}${where}: ${g(needs.memBytes)} GiB, ${c(needs.cpu)} CPUs (${verdict.reason})`,
        )
        let finished = false
        return {
          kind: 'placed',
          host: name === LOCAL_HOST ? null : name,
          verdicts,
          done: () => {
            if (finished) return
            finished = true
            reservation.state = 'held'
            this.persist()
            // A create that was refused leaves no root: free its room now.
            void this.locked(() => this.reconcile()).catch(() => {})
          },
        } as const
      }
      this.log(
        `at capacity for ${requestId}${where}: ${verdicts.map((v) => `${v.host}: ${v.reason}`).join(' | ')}`,
      )
      return { kind: 'at_capacity', verdicts } as const
    })
  }
}
