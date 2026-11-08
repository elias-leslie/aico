/**
 * Host-pressure admission for new agent TUI launches.
 *
 * Admission is pressure-based by default: a launch is deferred only while
 * MemAvailable or memory PSI shows an unhealthy host. A numeric ceiling on
 * concurrently active agents exists solely as an opt-in emergency brake and is
 * disabled unless configured. When host-steward's memory controller publishes a
 * fresh verdict (admission.json), green replaces Tether's own memory thresholds
 * and red defers. Amber ("defer heavy work", from 8 GiB available) is meant for
 * builds: an agent launch needs well under 1 GiB, so on amber it still passes
 * when Tether's own thresholds do. A missing, unparsable or expired file falls
 * back to them. Host
 * observations are injected so the policy is testable without Electron,
 * systemd or /proc.
 */

import type { HostAdmissionVerdict } from '@aico/shared/host-admission'
import {
  AgentAdmissionDenied,
  type AgentAdmissionLimits,
  admissionLimitsFromEnv,
  type MemoryPressure,
  malformedAdmission,
  parseMemAvailable,
  parseMemoryPressure,
} from '@aico/shared/host-pressure'
import { isNamedProcess } from './procfs'

/** Exact value that enables the operator override. Any other non-empty value is malformed. */
const ADMISSION_OVERRIDE_VALUE = '1'

/** How long a committed launch keeps its slot while the agent process appears in its scope. */
export const LAUNCH_SETTLE_MS = 30_000

export function admissionOverrideFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.AICO_AGENT_ADMISSION_OVERRIDE
  if (value === undefined || value === '') return false
  if (value === ADMISSION_OVERRIDE_VALUE) return true
  throw malformedAdmission('AICO_AGENT_ADMISSION_OVERRIDE')
}

export interface ScopeFs {
  /** Names of child directories only (cgroups); control files are excluded. */
  listDirectories(path: string): Promise<string[]>
  readFile(path: string): Promise<string>
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ESRCH'
}

/**
 * Return the owned tmux pane scopes that currently contain a recognised agent
 * process. Bare shells and inert launch gates contain no agent process and are
 * not counted; agent panes started outside this Aico instance are counted
 * because their processes are verified directly. A scope or process that ends
 * mid-walk is skipped; any other read failure propagates (fail closed).
 */
export async function observeAgentScopes(options: {
  fs: ScopeFs
  appSliceDir: string
  isPaneScope(unit: string): boolean
  agentProcessNames: ReadonlySet<string>
}): Promise<Set<string>> {
  const { fs, appSliceDir, isPaneScope, agentProcessNames } = options
  const scopes = new Set<string>()
  for (const unit of await fs.listDirectories(appSliceDir)) {
    if (!isPaneScope(unit)) continue
    try {
      if (await cgroupHasAgent(fs, `${appSliceDir}/${unit}`, agentProcessNames, 0)) scopes.add(unit)
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  }
  return scopes
}

const MAX_CGROUP_DEPTH = 8

async function cgroupHasAgent(
  fs: ScopeFs,
  dir: string,
  names: ReadonlySet<string>,
  depth: number,
): Promise<boolean> {
  if (depth > MAX_CGROUP_DEPTH) throw new Error(`cgroup nesting exceeds ${MAX_CGROUP_DEPTH}`)
  for (const pid of (await fs.readFile(`${dir}/cgroup.procs`)).split('\n')) {
    if (!pid) continue
    if (!/^[1-9][0-9]*$/.test(pid)) throw new Error('malformed cgroup.procs')
    try {
      const comm = (await fs.readFile(`/proc/${pid}/comm`)).trim()
      const cmdline = names.has(comm) ? '' : await fs.readFile(`/proc/${pid}/cmdline`)
      if (isNamedProcess(comm, () => cmdline, names)) return true
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  }
  for (const entry of await fs.listDirectories(dir)) {
    if (entry.includes('/')) throw new Error('malformed cgroup entry')
    if (await cgroupHasAgent(fs, `${dir}/${entry}`, names, depth + 1)) return true
  }
  return false
}

export interface AgentAdmissionObservations {
  meminfo(): Promise<string>
  memoryPressure(): Promise<string>
  activeAgentScopes(): Promise<Set<string>>
  /** host-steward's fresh host verdict, or null to use Tether's own thresholds. */
  hostVerdict?(): Promise<HostAdmissionVerdict | null>
}

export type AdmissionKind = 'launch' | 'recovery' | 'replacement'

export interface AdmissionRequest {
  widgetId: string
  kind: AdmissionKind
  /** Scope being replaced; never counted against its own replacement. */
  replacingScope?: string | null
}

/** Numbers-only record of one decision; never carries prompt or session content. */
export interface AdmissionObservation {
  event: 'agent_admission'
  decision: 'admitted' | 'deferred' | 'override'
  widget: string
  kind: AdmissionKind
  memAvailableGiB: number | null
  psiSomeAvg60: number | null
  psiFullAvg60: number | null
  psiFullAvg10: number | null
  activeAgents: number | null
  ceiling: number | null
  reason: string | null
}

export interface AdmissionTicket {
  /** Launch dispatched into `scopeUnit`: hold the slot until the agent is observed or settle expires. */
  commit(scopeUnit: string | null): void
  /** Launch did not happen: free the slot immediately. Idempotent. */
  release(): void
}

interface Reservation {
  state: 'pending' | 'committed' | 'released'
  scopeUnit: string | null
  committedAt: number
}

export interface AgentAdmissionOptions {
  limits?: () => AgentAdmissionLimits
  override?: () => boolean
  now?: () => number
  record?: (observation: AdmissionObservation) => void
}

export class AgentAdmission {
  private tail: Promise<void> = Promise.resolve()
  private readonly reservations = new Set<Reservation>()
  private readonly limits: () => AgentAdmissionLimits
  private readonly override: () => boolean
  private readonly now: () => number
  private readonly record: (observation: AdmissionObservation) => void

  constructor(
    private readonly observations: AgentAdmissionObservations,
    options: AgentAdmissionOptions = {},
  ) {
    this.limits = options.limits ?? admissionLimitsFromEnv
    this.override = options.override ?? admissionOverrideFromEnv
    this.now = options.now ?? Date.now
    this.record = options.record ?? (() => {})
  }

  /**
   * Observe, decide and reserve as one serialized step, so concurrent starts
   * cannot both take the final ceiling slot. Throws AgentAdmissionDenied
   * (retryable) when the launch must be deferred.
   */
  async reserve(request: AdmissionRequest): Promise<AdmissionTicket> {
    const predecessor = this.tail
    let unlock: () => void = () => {}
    this.tail = new Promise<void>((resolve) => {
      unlock = resolve
    })
    await predecessor
    try {
      return await this.decide(request)
    } finally {
      unlock()
    }
  }

  private async decide(request: AdmissionRequest): Promise<AdmissionTicket> {
    const observation: AdmissionObservation = {
      event: 'agent_admission',
      decision: 'deferred',
      widget: request.widgetId,
      kind: request.kind,
      memAvailableGiB: null,
      psiSomeAvg60: null,
      psiFullAvg60: null,
      psiFullAvg10: null,
      activeAgents: null,
      ceiling: null,
      reason: null,
    }
    const defer = (reason: string): never => {
      const denied = new AgentAdmissionDenied(reason)
      observation.reason = denied.reason
      this.record(observation)
      throw denied
    }
    let override: boolean
    let limits: AgentAdmissionLimits
    try {
      override = this.override()
      limits = this.limits()
    } catch (error) {
      return defer(
        error instanceof AgentAdmissionDenied
          ? error.reason
          : 'admission configuration is unreadable.',
      )
    }
    observation.ceiling = limits.maxActiveAgents
    this.pruneSettled()

    let available: number | null = null
    let psi: MemoryPressure | null = null
    let failure: string | null = null
    const verdict = (await this.observations.hostVerdict?.().catch(() => null)) ?? null
    // Amber leaves the launch to Tether's own thresholds below.
    const amber = verdict !== null && !verdict.admit && verdict.state === 'amber'
    if (verdict && !verdict.admit && !amber)
      failure = `The host has closed agent admission (${verdict.reason}).`
    try {
      available = parseMemAvailable(await this.observations.meminfo())
      observation.memAvailableGiB = round(available / 1024 ** 3)
      psi = parseMemoryPressure(await this.observations.memoryPressure())
      observation.psiSomeAvg60 = psi.someAvg60
      observation.psiFullAvg60 = psi.fullAvg60
      observation.psiFullAvg10 = psi.fullAvg10
    } catch (error) {
      failure ??=
        error instanceof AgentAdmissionDenied
          ? error.reason
          : 'host memory observations could not be read.'
    }

    // The agent count only gates when an emergency ceiling is configured;
    // otherwise it is best-effort telemetry and its failure never defers.
    let active: number | null = null
    try {
      active = this.activeCount(
        await this.observations.activeAgentScopes(),
        request.replacingScope ?? null,
      )
      observation.activeAgents = active
    } catch {
      if (limits.maxActiveAgents !== null && !failure)
        failure = 'active agent scopes could not be verified.'
    }

    if (override) {
      observation.decision = 'override'
      observation.reason = failure
      this.record(observation)
      return this.ticket()
    }
    if (failure) return defer(failure)
    // A fresh host admit replaces Tether's own memory thresholds.
    const ownThresholds = !verdict || amber
    if (ownThresholds && available !== null && available < limits.minAvailableBytes)
      return defer(
        `available memory ${round(available / 1024 ** 3)} GiB is below ${round(limits.minAvailableBytes / 1024 ** 3)} GiB.`,
      )
    if (ownThresholds && psi && psi.fullAvg10 >= limits.maxFullAvg10)
      return defer(
        `memory pressure full avg10 ${psi.fullAvg10} is at or above ${limits.maxFullAvg10}.`,
      )
    if (ownThresholds && psi && psi.fullAvg60 >= limits.maxFullAvg60)
      return defer(
        `memory pressure full avg60 ${psi.fullAvg60} is at or above ${limits.maxFullAvg60}.`,
      )
    if (ownThresholds && psi && psi.someAvg60 >= limits.maxSomeAvg60)
      return defer(
        `memory pressure some avg60 ${psi.someAvg60} is at or above ${limits.maxSomeAvg60}.`,
      )
    if (limits.maxActiveAgents !== null && active !== null && active >= limits.maxActiveAgents)
      return defer(`the emergency ceiling of ${limits.maxActiveAgents} active agents is reached.`)

    observation.decision = 'admitted'
    this.record(observation)
    return this.ticket()
  }

  private pruneSettled(): void {
    const now = this.now()
    for (const reservation of this.reservations) {
      if (reservation.state === 'committed' && now - reservation.committedAt >= LAUNCH_SETTLE_MS)
        this.reservations.delete(reservation)
    }
  }

  /** Observed agent scopes plus in-flight reservations not yet visible as agents. */
  private activeCount(observed: Set<string>, replacingScope: string | null): number {
    const counted = new Set(observed)
    if (replacingScope) counted.delete(replacingScope)
    let inFlight = 0
    for (const reservation of this.reservations) {
      if (reservation.state === 'committed') {
        if (reservation.scopeUnit && observed.has(reservation.scopeUnit)) {
          this.reservations.delete(reservation)
          continue
        }
        if (reservation.scopeUnit && reservation.scopeUnit === replacingScope) continue
      }
      inFlight += 1
    }
    return counted.size + inFlight
  }

  private ticket(): AdmissionTicket {
    const reservation: Reservation = { state: 'pending', scopeUnit: null, committedAt: 0 }
    this.reservations.add(reservation)
    return {
      commit: (scopeUnit) => {
        if (reservation.state !== 'pending') return
        reservation.state = 'committed'
        reservation.scopeUnit = scopeUnit
        reservation.committedAt = this.now()
      },
      release: () => {
        if (reservation.state !== 'pending') return
        reservation.state = 'released'
        this.reservations.delete(reservation)
      },
    }
  }

  /** In-flight reservations; exposed for tests and diagnostics. */
  get inFlight(): number {
    return [...this.reservations].filter((reservation) => reservation.state !== 'released').length
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
