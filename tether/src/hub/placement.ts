// Host placement for agent launches (docs/plans/remote-hosts.md "Placement"):
// `POST /v1/roots` with `host: "auto"` and `needs` picks the first host, in the
// configured order, whose live room fits the needs, or refuses with each host's
// reason. room = live free - owner reserve - open reservations. A host whose
// reading is missing, stale or failed is unknown and never placed on. There is
// no agent count anywhere: only memory, CPU and capabilities.
//
// Readings: this computer from Nightshift's admission file (green required);
// a remote VM from its own /proc (MemAvailable, PSI, CPUs, load) through the
// link's ssh master, plus its Proxmox node's free memory and storage (clones
// and ballooning draw on them). A powered-off VM counts only when Proxmox has
// room to start it; the create path then wakes it with hosts.json `wake`.
//
// Reservations are held per placed root and released only on a definite end
// reported by the Tether that owns the root (no such root, ended, or its agent
// exited), never on a timer. They persist across a Tether restart. Decisions
// are serialized, so concurrent creates cannot both take the last room.

import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { availableParallelism, homedir, loadavg } from 'node:os'
import { isAbsolute, join, normalize } from 'node:path'
import {
  type AgentAdmissionLimits,
  admissionLimitsFromEnv,
  nightshiftAdmissionPath,
  parseMemAvailable,
  parseMemoryPressure,
} from '../lifecycle/agent-admission'
import { type Runner, type RunResult, remoteArgv, runCommand, shellQuote } from './host-admin'
import type { HostEntry } from './hosts'
import { SSH_BIN } from './link'
import { peerRequest } from './peer-http'

const GIB = 1024 ** 3
/** The host name `--host auto` asks for; hosts.json cannot use it. */
export const AUTO_HOST = 'auto'
/** This computer in placement config and answers. */
export const LOCAL_HOST = 'local'
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

export interface HostPlacement {
  /** Memory the owner keeps free on this host. */
  reserveBytes: number
  /** CPUs the owner keeps free on this host. */
  reserveCpu: number
  proxmox: ProxmoxRef | null
}

export interface CapabilityProbe {
  /** The marker file, absolute or relative to the host user's home. */
  marker: string
  /** Prints the host's current fingerprint; null = cannot compare (not ready). */
  fingerprint: string[] | null
}

export interface PlacementConfig {
  /** Hosts in the order they are tried; `local` is this computer. */
  order: string[]
  hosts: Record<string, HostPlacement>
  capabilities: Record<string, CapabilityProbe>
  /** One plain line per thing in the file that was not usable. */
  errors: string[]
}

/** Overridable defaults; the owner's values live in placement.json. */
export const DEFAULT_LOCAL: HostPlacement = { reserveBytes: 6 * GIB, reserveCpu: 2, proxmox: null }
export const DEFAULT_REMOTE: HostPlacement = { reserveBytes: 2 * GIB, reserveCpu: 1, proxmox: null }
const DEFAULT_PVE_RESERVE = 2 * GIB
const DEFAULT_MIN_STORAGE = 20 * GIB
/** Neri's live-ready marker (plan contract 4). */
export const DEFAULT_CAPABILITIES: Record<string, CapabilityProbe> = {
  'live-ready': { marker: '.local/state/neri-proxy/live-ready.json', fingerprint: null },
}

/** `$TETHER_PLACEMENT_FILE`, else `$XDG_CONFIG_HOME/tether/placement.json`. */
export function placementFilePath(env: NodeJS.ProcessEnv): string {
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
  // Listed hosts first; a host the list leaves out follows in hosts.json
  // order, so a new host is tried rather than silently ignored. `skip` leaves
  // a host out on purpose.
  const listed = names(raw?.order, 'order') ?? []
  const skip = new Set(names(raw?.skip, 'skip') ?? [])
  const order = [...new Set([...listed, ...fallbackOrder])].filter((name) => !skip.has(name))
  const hosts: Record<string, HostPlacement> = {}
  const rawHosts = record(raw?.hosts) ?? {}
  if (raw?.hosts !== undefined && !record(raw.hosts)) errors.push('hosts must be an object')
  for (const name of new Set([...order, ...Object.keys(rawHosts)])) {
    const fallback = name === LOCAL_HOST ? DEFAULT_LOCAL : DEFAULT_REMOTE
    const entry = rawHosts[name]
    if (entry === undefined) {
      hosts[name] = { ...fallback }
      continue
    }
    const value = record(entry)
    const reserveBytes = gib(value?.reserveGiB, fallback.reserveBytes)
    const reserveCpu = count(value?.reserveCpu, fallback.reserveCpu)
    const proxmox = parseProxmoxRef(value?.proxmox)
    const problem = !value
      ? 'must be an object'
      : reserveBytes === null
        ? 'reserveGiB must be 0-4096'
        : reserveCpu === null
          ? 'reserveCpu must be 0-1024'
          : typeof proxmox === 'string'
            ? proxmox
            : name === LOCAL_HOST && proxmox
              ? 'proxmox is for remote hosts'
              : null
    if (problem) {
      // A broken entry keeps the defaults' reserve, so nothing is placed more freely.
      errors.push(`hosts.${name}: ${problem}; using the defaults`)
      hosts[name] = { ...fallback }
    } else
      hosts[name] = {
        reserveBytes: reserveBytes as number,
        reserveCpu: reserveCpu as number,
        proxmox: proxmox as ProxmoxRef | null,
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
  return { order, hosts, capabilities, errors }
}

export function loadPlacement(path: string, hostNames: string[]): PlacementConfig {
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

export function proxmoxLine(ref: ProxmoxRef): string {
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

export function parseProxmox(stdout: string, ref: ProxmoxRef): ProxmoxReading {
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

  /** Release the reservations whose root has definitely ended. */
  private async reconcile(): Promise<void> {
    const held = this.reservations.filter((item) => item.state === 'held')
    const fates = await Promise.all(
      held.map(async (item): Promise<RootFate> => {
        if (item.host === LOCAL_HOST) return this.deps.localRoot(item.requestId)
        const peer = this.deps.peer(item.host)
        // A host that left hosts.json keeps its reservations until it answers again.
        return peer ? this.remoteRoot(peer, item.requestId) : 'unknown'
      }),
    )
    let changed = false
    held.forEach((item, index) => {
      const fate = fates[index]
      if (fate === 'missing' || fate === 'ended' || fate === 'exited') {
        this.reservations.splice(this.reservations.indexOf(item), 1)
        this.log(`released ${item.requestId} on ${item.host} (${fate})`)
        changed = true
      }
    })
    if (changed) this.persist()
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

  private async judgeLocal(config: PlacementConfig, needs: Needs): Promise<HostVerdict> {
    const path = nightshiftAdmissionPath(this.deps.env)
    let reading: LocalAdmission | null = null
    if (path) reading = parseLocalAdmission(await this.readText(path).catch(() => ''), this.now())
    if (!reading) return this.unknown(LOCAL_HOST, "Nightshift's memory reading is missing or stale")
    if (reading.state !== 'green')
      return this.unknown(LOCAL_HOST, `Nightshift says ${reading.state}: ${reading.reason}`)
    const home = this.deps.env.HOME ?? homedir()
    const missing = await this.capabilities(config, needs, async (probe) => {
      const markerPath = isAbsolute(probe.marker) ? probe.marker : join(home, probe.marker)
      const marker = await this.readText(markerPath).catch(() => null)
      const current =
        marker !== null && probe.fingerprint ? await this.run(probe.fingerprint, READ_MS) : null
      return [marker, current]
    })
    if (missing) return this.unknown(LOCAL_HOST, missing)
    const own = config.hosts[LOCAL_HOST] ?? DEFAULT_LOCAL
    const held = this.held((name) => name === LOCAL_HOST)
    const cpu = this.cpu()
    return this.verdict(
      LOCAL_HOST,
      needs,
      {
        mem: reading.memAvailableBytes - own.reserveBytes - held.mem,
        cpu: cpu.cpus - cpu.load5 - own.reserveCpu - held.cpu,
      },
      `${g(reading.memAvailableBytes)} free - ${g(own.reserveBytes)} reserve - ${g(held.mem)} held`,
    )
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
    const held = this.held((host) => host === name)
    const ref = own.proxmox
    let pve: ProxmoxReading | null = null
    let pveRoom = Number.POSITIVE_INFINITY
    let pveDetail = ''
    if (ref) {
      const result = await this.run(
        [SSH_BIN, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', ref.ssh, '--', proxmoxLine(ref)],
        READ_MS,
      )
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
    const missing = await this.capabilities(config, needs, async (probe) => {
      const markerPath = isAbsolute(probe.marker) ? probe.marker : `"$HOME"/${probe.marker}`
      const markerRun = await this.readGuest(peer, `cat ${markerPath}`)
      const marker = markerRun.code === 0 ? markerRun.stdout : null
      const current =
        marker !== null && probe.fingerprint
          ? await this.readGuest(peer, probe.fingerprint.map(shellQuote).join(' '))
          : null
      return [marker, current]
    })
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
      return name === LOCAL_HOST
        ? await this.judgeLocal(config, needs)
        : await this.judgeRemote(config, name, needs)
    } catch (error) {
      return this.unknown(name, `its reading failed: ${(error as Error).message}`)
    }
  }

  /** Every host's verdict in order, without reserving (the dry run). */
  check(needs: Needs): Promise<HostVerdict[]> {
    return this.locked(async () => {
      await this.reconcile()
      const config = this.config()
      const verdicts: HostVerdict[] = []
      for (const name of config.order) verdicts.push(await this.judge(config, name, needs))
      return verdicts
    })
  }

  /**
   * Pick a host and reserve the needs there, as one serialized step. The
   * first host in order that fits wins; the rest are not read. A request
   * already placed (a retry) goes to the same host without a new reservation.
   * Call `done()` once the create has answered, whatever the answer.
   */
  place(requestId: string, needs: Needs): Promise<PlaceResult> {
    return this.locked(async () => {
      const existing = this.reservations.find((item) => item.requestId === requestId)
      const known = existing ? existing.host : this.deps.existingHost(requestId)
      if (known !== undefined) {
        const host = known === LOCAL_HOST ? null : known
        return { kind: 'placed', host, verdicts: [], done: () => {} } as const
      }
      await this.reconcile()
      const config = this.config()
      const verdicts: HostVerdict[] = []
      for (const name of config.order) {
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
          `placed ${requestId} on ${name}: ${g(needs.memBytes)} GiB, ${c(needs.cpu)} CPUs (${verdict.reason})`,
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
        `at capacity for ${requestId}: ${verdicts.map((v) => `${v.host}: ${v.reason}`).join(' | ')}`,
      )
      return { kind: 'at_capacity', verdicts } as const
    })
  }
}
