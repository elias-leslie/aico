// One remote Tether ("peer") as the hub sees it through its link's forwarded
// socket: link health (connected, connecting, offline, identity_changed), the
// freshness of its last session list, a cache of its descriptors that outlives
// the link (a down peer's sessions are stale, never gone), its relayed events
// and its bridged GUI channel.

import { statSync } from 'node:fs'
import type { EventType } from '../events'
import type { GuiCommand, GuiOutcome } from '../gui-channel'
import type { HostEntry } from './hosts'
import { PeerUnavailable, peerRequest, peerStream } from './peer-http'
import type { WakeProgress } from './wake'

export type HostState = 'connected' | 'connecting' | 'offline' | 'powered_off' | 'identity_changed'

export type Descriptor = Record<string, unknown> & { id: string }

/** Who answered on the link: the remote Tether's host name and machine id hash. */
export interface PeerIdentity {
  hostname: string
  machineId: string | null
}

export interface PeerSnapshot {
  listedAt: number | null
  items: Descriptor[]
}

export interface RunsLike {
  status: 'ok' | 'stale' | 'unavailable'
  error: string | null
  updatedAt: number | null
  items: Record<string, unknown>[]
}

export interface PeerDeps {
  publish(type: EventType, data: Record<string, unknown>): void
  gui: { send(command: GuiCommand): Promise<GuiOutcome> }
  /** A session id this hub runs itself: the local copy wins over a peer's. */
  isLocal(id: string): boolean
  identity: { get(name: string): PeerIdentity | null; set(name: string, id: PeerIdentity): void }
  persist(name: string, snapshot: PeerSnapshot): void
  /** The descriptor as clients see it: `host`, `peer` and the lead's badge. */
  present(peer: Peer, descriptor: Descriptor): Descriptor
  log(message: string): void
  now(): number
  random(): number
  /** Whether the host is powered off, from its hosts.json `status` command;
   * null when there is none or it could not tell. */
  poweredOff?(entry: HostEntry): Promise<boolean | null>
  /** How long a silent event stream waits before asking the peer's health,
   * and how long that ask may take (tests shorten them). */
  stall?: { afterMs: number; probeMs: number }
}

export const HEALTH_TIMEOUT_MS = 3_000
export const SYNC_TIMEOUT_MS = 5_000
export const RETRY_MIN_MS = 1_000
export const RETRY_MAX_MS = 30_000
/** A connection up this long resets the retry backoff. */
export const STABLE_MS = 60_000
/** Consecutive failed list reads that open the circuit, and for how long. */
export const BREAKER_FAILURES = 3
export const BREAKER_OPEN_MS = 30_000
/** A down host's power status is asked again after this long. */
export const POWER_PROBE_MS = 15_000
/** The peer's event stream sends a heartbeat every 15 s: this much silence
 * asks its health once (a VM that stopped dead never closes the link, and ssh
 * notices only after its own keepalives fail). */
export const STALL_MS = 20_000
const STALL_CHECK_MS = 2_500
/** The health check after a silence: generous, so a busy host is not dropped. */
const STALL_PROBE_MS = 5_000

const RELAYED = new Set<string>([
  'session.created',
  'session.updated',
  'session.ended',
  'session.resized',
  'root.updated',
  'tools.changed',
  'projects.changed',
  'wakes.changed',
  'runs.changed',
])
const GUI_KINDS = new Set(['show', 'position', 'title', 'coordinator', 'layout'])

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function isDescriptor(value: unknown): value is Descriptor {
  const item = record(value)
  return typeof item?.id === 'string' && typeof item.generation === 'string'
}

/** Why a host cannot take a request now, in a few words. */
export function downReason(name: string, state: string): string {
  if (state === 'connecting') return `${name} is still connecting`
  if (state === 'powered_off') return `${name} is powered off`
  return `${name} is not reachable`
}

/** Jittered, capped exponential retry delay. */
export function retryDelay(attempt: number, random: () => number): number {
  const ceiling = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.max(0, attempt))
  return Math.round(ceiling / 2 + (random() * ceiling) / 2)
}

class IdentityChanged extends Error {}

export class Peer {
  state: HostState = 'connecting'
  since: number
  listedAt: number | null
  error: string | null = null
  /** The identity that answered last, kept while it differs from the trusted one. */
  pendingIdentity: PeerIdentity | null = null
  /** What a create is waiting for while it brings this host up, or why it failed. */
  wake: WakeProgress | null = null
  private readonly sessions = new Map<string, Descriptor>()
  private readonly roots = new Set<string>()
  /** The last root list per query, kept for while the link is down. */
  private readonly rootLists = new Map<string, Record<string, unknown>[]>()
  private runsAnswer: RunsLike | null = null
  private failures = 0
  private openUntil = 0
  private controller: AbortController | null = null
  private wakeRetry: (() => void) | null = null
  private readonly duplicates = new Set<string>()
  /** Set by a power off from the Hosts panel: the next drop is powered off. */
  private expectOff = false
  /** Why the last connection was dropped for silence, if it was. */
  private stalled: string | null = null
  private power: { at: number; off: boolean | null } | null = null

  constructor(
    readonly entry: HostEntry,
    /** The link's forwarded control socket. */
    readonly socket: string,
    /** The link's ssh ControlMaster socket (clients attach through it). */
    readonly control: string,
    private readonly deps: PeerDeps,
    cached: PeerSnapshot | null = null,
  ) {
    this.since = deps.now()
    this.listedAt = cached?.listedAt ?? null
    for (const item of cached?.items ?? []) if (isDescriptor(item)) this.sessions.set(item.id, item)
  }

  get name(): string {
    return this.entry.name
  }

  get live(): boolean {
    return this.state === 'connected'
  }

  start(): void {
    if (this.controller) return
    this.controller = new AbortController()
    void this.run(this.controller.signal)
  }

  stop(): void {
    this.controller?.abort()
    this.controller = null
    this.wakeRetry?.()
  }

  /** Try the link now instead of waiting out the backoff. */
  retryNow(): void {
    this.wakeRetry?.()
  }

  /** The descriptors as clients see them (marked while the link is not live). */
  descriptors(): Descriptor[] {
    return [...this.sessions.values()]
      .filter((item) => !this.deps.isLocal(item.id))
      .map((item) => this.deps.present(this, item))
  }

  /** Why the descriptors are not live, or null while they are. */
  mark(): { state: HostState; since: number; listedAt: number | null } | null {
    return this.live ? null : { state: this.state, since: this.since, listedAt: this.listedAt }
  }

  count(): number {
    return this.sessions.size
  }

  ownsSession(id: string): boolean {
    return this.sessions.has(id)
  }

  ownsRoot(requestId: string): boolean {
    if (this.roots.has(requestId)) return true
    for (const item of this.sessions.values()) if (item.rootRequestId === requestId) return true
    return false
  }

  ownsWake(wakeId: string): boolean {
    for (const item of this.sessions.values()) {
      const wakes = Array.isArray(item.wakes) ? item.wakes : []
      if (wakes.some((wake) => record(wake)?.id === wakeId)) return true
    }
    return false
  }

  ownsRun(runId: string): boolean {
    return (this.runsAnswer?.items ?? []).some((item) => item.runId === runId)
  }

  session(id: string): Descriptor | null {
    return this.sessions.get(id) ?? null
  }

  runs(): RunsLike | null {
    return this.runsAnswer
  }

  /** A descriptor the peer answered with (create, PATCH, GET). */
  upsert(descriptor: Descriptor): void {
    if (descriptor.host !== undefined && descriptor.host !== null) return
    this.sessions.set(descriptor.id, descriptor)
    this.persist()
  }

  rememberRoot(requestId: string): void {
    this.roots.add(requestId)
  }

  /** Report a create's progress bringing this host up (null when it is done). */
  setWake(progress: WakeProgress | null): void {
    this.wake = progress
    if (progress?.state === 'starting') {
      this.expectOff = false
      this.power = null
      if (!this.live && this.state !== 'identity_changed') this.setState('connecting', this.error)
    } else if (!this.live && this.state === 'connecting') void this.settleDown()
    this.deps.publish('peer.state', {
      host: this.name,
      state: this.state,
      since: this.since,
      wake: progress,
    })
  }

  /** The host was just powered off on purpose (the Hosts panel). */
  poweredOff(): void {
    this.expectOff = true
    if (!this.live && this.state !== 'identity_changed') this.setState('powered_off', this.error)
  }

  /** What a host whose link is down is: being brought up (connecting), powered
   * off (on purpose, or as its `status` command says), or offline. */
  private async downState(): Promise<HostState> {
    if (this.wake?.state === 'starting') return 'connecting'
    if (this.expectOff) return 'powered_off'
    const probe = this.deps.poweredOff
    if (!probe) return 'offline'
    if (!this.power || this.deps.now() - this.power.at >= POWER_PROBE_MS) {
      const off = await probe(this.entry).catch(() => null)
      this.power = { at: this.deps.now(), off }
    }
    if (this.wake?.state === 'starting') return 'connecting'
    return this.power.off ? 'powered_off' : 'offline'
  }

  private async settleDown(): Promise<void> {
    const state = await this.downState()
    if (!this.live && this.state !== 'identity_changed') this.setState(state, this.error)
  }

  /** The peer's `GET /v1/roots` items for this query, tagged; its last answer
   * (marked) while the link is down or the read failed. */
  async listRoots(search: string, timeoutMs: number): Promise<Record<string, unknown>[]> {
    if (this.live) {
      try {
        const path = `/v1/roots${search ? `?${search}` : ''}`
        const answer = await peerRequest(this.socket, 'GET', path, undefined, timeoutMs)
        const roots = record(answer.body)?.roots
        if (answer.status === 200 && Array.isArray(roots)) {
          const items = roots.filter((item): item is Record<string, unknown> => !!record(item))
          for (const item of items)
            if (typeof item.requestId === 'string') this.roots.add(item.requestId)
          this.rootLists.set(search, items)
        }
      } catch {
        // Its last list, marked below.
      }
    }
    const mark = this.mark()
    return (this.rootLists.get(search) ?? []).map((item) => ({
      ...item,
      host: this.name,
      ...(mark ? { peer: mark } : {}),
    }))
  }

  /** A fresh list, through the circuit breaker; the cache when the peer is
   * down, the circuit is open, or this read failed. */
  async list(timeoutMs: number): Promise<Descriptor[]> {
    if (!this.live || this.deps.now() < this.openUntil) return this.descriptors()
    try {
      const answer = await peerRequest(this.socket, 'GET', '/v1/sessions', undefined, timeoutMs)
      if (answer.status !== 200) throw new PeerUnavailable(`sessions answered ${answer.status}`)
      this.replace(answer.body)
      this.failures = 0
    } catch (error) {
      this.failures += 1
      if (this.failures >= BREAKER_FAILURES) {
        this.failures = 0
        this.openUntil = this.deps.now() + BREAKER_OPEN_MS
        this.deps.log(
          `${this.name}: session list failed ${BREAKER_FAILURES} times (${(error as Error).message}); using its last list for ${BREAKER_OPEN_MS / 1000}s`,
        )
      }
    }
    return this.descriptors()
  }

  private replace(body: unknown): void {
    const items = record(body)?.items
    if (!Array.isArray(items)) throw new PeerUnavailable('sessions answer has no items')
    this.sessions.clear()
    for (const item of items) {
      if (!isDescriptor(item)) continue
      // No transitive federation: a peer's own peers are not ours.
      if (item.host !== undefined && item.host !== null) continue
      if (this.deps.isLocal(item.id)) {
        if (!this.duplicates.has(item.id))
          this.deps.log(`${this.name}: session ${item.id} also exists here; the local one wins`)
        this.duplicates.add(item.id)
        continue
      }
      this.sessions.set(item.id, item)
    }
    this.listedAt = this.deps.now()
    this.persist()
  }

  private persist(): void {
    this.deps.persist(this.name, { listedAt: this.listedAt, items: [...this.sessions.values()] })
  }

  private setState(state: HostState, error: string | null = null): void {
    this.error = error
    if (state === this.state) return
    const wasLive = this.live
    this.state = state
    this.since = this.deps.now()
    this.deps.log(`${this.name}: ${state}${error ? ` (${error})` : ''}`)
    if (state === 'connected') {
      this.expectOff = false
      this.power = null
      // A failed start stays shown until the host is back.
      if (this.wake?.state === 'failed') this.wake = null
    }
    this.deps.publish('peer.state', { host: this.name, state, since: this.since, wake: this.wake })
    // Clients upsert these, so every window learns its host went away.
    if (wasLive) for (const item of this.descriptors()) this.publishSession(item)
  }

  private publishSession(item: Descriptor): void {
    this.deps.publish('session.updated', { id: item.id, host: this.name, session: item })
  }

  private async run(signal: AbortSignal): Promise<void> {
    let attempt = 0
    while (!signal.aborted) {
      const up = { at: null as number | null }
      let why: string | null = null
      try {
        await this.connect(signal, () => {
          up.at = this.deps.now()
        })
        why = this.stalled ?? 'the link closed'
      } catch (error) {
        if (!(error instanceof IdentityChanged)) why = (error as Error).message
      }
      this.stalled = null
      if (signal.aborted) return
      if (why !== null) {
        const down = await this.downState()
        if (signal.aborted) return
        this.setState(down, why)
      }
      if (signal.aborted) return
      const stable = up.at !== null && this.deps.now() - up.at >= STABLE_MS
      attempt = stable ? 0 : attempt + 1
      await this.waitRetry(retryDelay(attempt, this.deps.random), signal)
    }
  }

  /** Wait out a retry delay, or less when the link re-creates its socket. */
  private waitRetry(delayMs: number, signal: AbortSignal): Promise<void> {
    const stamp = () => {
      try {
        const stat = statSync(this.socket)
        return `${stat.ino}:${stat.mtimeMs}`
      } catch {
        return null
      }
    }
    const before = stamp()
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        clearInterval(poll)
        signal.removeEventListener('abort', done)
        this.wakeRetry = null
        resolve()
      }
      const timer = setTimeout(done, delayMs)
      const poll = setInterval(() => {
        const now = stamp()
        if (now !== null && now !== before) done()
      }, 1_000)
      signal.addEventListener('abort', done, { once: true })
      this.wakeRetry = done
    })
  }

  private async checkIdentity(): Promise<void> {
    const health = await peerRequest(this.socket, 'GET', '/v1/health', undefined, HEALTH_TIMEOUT_MS)
    if (health.status !== 200) throw new PeerUnavailable(`health answered ${health.status}`)
    const host = record(record(health.body)?.host)
    // An older Tether names no host: nothing to compare.
    if (typeof host?.name !== 'string') return
    const seen: PeerIdentity = {
      hostname: host.name,
      machineId: typeof host.machineId === 'string' ? host.machineId : null,
    }
    const trusted = this.deps.identity.get(this.name)
    if (!trusted) {
      this.deps.identity.set(this.name, seen)
      return
    }
    if (trusted.hostname === seen.hostname && trusted.machineId === seen.machineId) {
      this.pendingIdentity = null
      return
    }
    this.pendingIdentity = seen
    this.setState(
      'identity_changed',
      `${this.entry.ssh} now answers as ${seen.hostname}, not ${trusted.hostname}`,
    )
    throw new IdentityChanged()
  }

  /** Accept the identity that answered last as this host's. */
  trust(): boolean {
    if (!this.pendingIdentity) return false
    this.deps.identity.set(this.name, this.pendingIdentity)
    this.pendingIdentity = null
    this.setState('connecting')
    this.retryNow()
    return true
  }

  /** One link-up: identity, then the event stream; resolves when it drops. */
  private async connect(signal: AbortSignal, onUp: () => void): Promise<void> {
    await this.checkIdentity()
    const connection = new AbortController()
    const stop = () => connection.abort()
    signal.addEventListener('abort', stop, { once: true })
    let synced = false
    const early: Record<string, unknown>[] = []
    const stall = this.deps.stall ?? { afterMs: STALL_MS, probeMs: STALL_PROBE_MS }
    let heardAt = this.deps.now()
    let probing = false
    const watch = setInterval(
      () => {
        if (probing || this.deps.now() - heardAt < stall.afterMs) return
        probing = true
        void peerRequest(this.socket, 'GET', '/v1/health', undefined, stall.probeMs)
          .then(() => {
            heardAt = this.deps.now()
          })
          .catch((error: Error) => {
            this.stalled = `${this.name} stopped answering (${error.message})`
            connection.abort()
          })
          .finally(() => {
            probing = false
          })
      },
      Math.min(STALL_CHECK_MS, stall.afterMs / 4),
    )
    watch.unref?.()
    try {
      await peerStream(
        this.socket,
        '/v1/events',
        (line) => {
          heardAt = this.deps.now()
          const event = record(line)
          if (!event || typeof event.type !== 'string') return
          if (event.type === 'hello') {
            void this.sync(connection.signal)
              .then(() => {
                synced = true
                onUp()
                for (const queued of early.splice(0)) this.relay(queued)
                void this.holdGui(connection.signal)
              })
              .catch((error) => {
                this.deps.log(`${this.name}: sync failed: ${(error as Error).message}`)
                connection.abort()
              })
            return
          }
          if (!RELAYED.has(event.type)) return
          if (synced) this.relay(event)
          else early.push(event)
        },
        connection.signal,
      )
    } finally {
      clearInterval(watch)
      connection.abort()
      signal.removeEventListener('abort', stop)
    }
  }

  /** The whole list and the runs, then connected and a resync for clients. */
  private async sync(signal: AbortSignal): Promise<void> {
    const answer = await peerRequest(this.socket, 'GET', '/v1/sessions', undefined, SYNC_TIMEOUT_MS)
    if (answer.status !== 200) throw new PeerUnavailable(`sessions answered ${answer.status}`)
    if (signal.aborted) return
    const before = [...this.sessions.keys()]
    this.replace(answer.body)
    this.failures = 0
    this.openUntil = 0
    await this.refreshRuns()
    this.setState('connected')
    // Ended while the link was down (or the host was rolled back): the host's
    // own session.ended never reached us, so say it from its fresh list.
    for (const id of before)
      if (!this.sessions.has(id)) this.deps.publish('session.ended', { id, host: this.name })
    for (const item of this.descriptors()) this.publishSession(item)
    this.deps.publish('peer.resync', { host: this.name })
  }

  private async refreshRuns(): Promise<void> {
    try {
      const answer = await peerRequest(this.socket, 'GET', '/v1/runs', undefined, SYNC_TIMEOUT_MS)
      const body = record(answer.body)
      if (answer.status === 200 && body && Array.isArray(body.items))
        this.runsAnswer = body as unknown as RunsLike
      else if (answer.status === 404) this.runsAnswer = null
    } catch {
      // Keep the last runs; the merged answer reports them stale.
    }
  }

  private relay(event: Record<string, unknown>): void {
    const type = event.type as EventType
    const data = { ...(record(event.data) ?? {}) }
    const session = isDescriptor(data.session) ? (data.session as Descriptor) : null
    if (type === 'session.ended' && typeof data.id === 'string') {
      this.sessions.delete(data.id)
      this.persist()
    } else if (session && (type === 'session.created' || type === 'session.updated')) {
      if (this.deps.isLocal(session.id)) return
      this.upsert(session)
      data.session = this.deps.present(this, session)
    }
    if (typeof data.requestId === 'string') this.roots.add(data.requestId)
    if (type === 'runs.changed') {
      void this.refreshRuns().then(() => this.deps.publish(type, { ...data, host: this.name }))
      return
    }
    this.deps.publish(type, { ...data, host: this.name })
  }

  /** Hold the peer's GUI channel and apply its commands through ours, so an
   * agent on the host can show or place its window on this desktop. */
  private async holdGui(signal: AbortSignal): Promise<void> {
    let attempt = 0
    while (!signal.aborted) {
      let superseded = false
      try {
        await peerStream(
          this.socket,
          '/v1/gui/channel',
          (line) => {
            const message = record(line)
            if (message?.type === 'hello') attempt = 0
            else if (message?.type === 'superseded') superseded = true
            else if (message?.type === 'command') void this.bridge(message)
          },
          signal,
          { 'x-tether-client': 'aico-gui' },
        )
      } catch {
        // Reconnect below while the link is up.
      }
      if (signal.aborted || superseded) return
      await this.waitRetry(retryDelay(attempt++, this.deps.random), signal)
    }
  }

  private async bridge(message: Record<string, unknown>): Promise<void> {
    const { type: _type, commandId, ...command } = message
    if (typeof commandId !== 'string' || !GUI_KINDS.has(command.kind as string)) return
    const outcome = await this.deps.gui.send(command as unknown as GuiCommand)
    const verdict =
      outcome.status === 'applied'
        ? { applied: true, ...(outcome.layout ? { layout: outcome.layout } : {}) }
        : {
            applied: false,
            error:
              outcome.status === 'rejected'
                ? outcome.error
                : outcome.status === 'unavailable'
                  ? 'gui_unavailable'
                  : 'gui_timeout',
          }
    await peerRequest(
      this.socket,
      'POST',
      `/v1/gui/results/${encodeURIComponent(commandId)}`,
      verdict,
      HEALTH_TIMEOUT_MS,
    ).catch(() => {})
  }
}
