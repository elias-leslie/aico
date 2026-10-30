// The hub (docs/plans/remote-hosts.md "Hub"): this Tether federates the remote
// Tethers in hosts.json, so every client keeps talking to its one local socket.
// Lists merge the peers' sessions (tagged `host`), per-session routes go
// verbatim to the owning peer, peer events are relayed with `host`, and create
// takes a `host`. A down peer's sessions stay listed as stale, never gone.

import { statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { EventType } from '../events'
import type { GuiCommand, GuiOutcome } from '../gui-channel'
import { HttpError, sendJson } from '../http'
import { type HostEntry, hostsFilePath, loadHosts, peerDir } from './hosts'
import { linkPaths } from './link'
import {
  type Descriptor,
  downReason,
  isDescriptor,
  Peer,
  type PeerDeps,
  type PeerIdentity,
  type PeerSnapshot,
  type RunsLike,
} from './peer'
import { forwardRequest, PeerUnavailable, peerRequest } from './peer-http'
import { defaultGateRuntime, type GateRuntime, readyHost } from './wake'

export const LIST_TIMEOUT_MS = 1_500
export const QUERY_TIMEOUT_MS = 10_000
/** Create waits for the peer's own launch (agent admission can be slow). */
export const CREATE_TIMEOUT_MS = 120_000
const RELOAD_MS = 5_000
const PERSIST_DEBOUNCE_MS = 2_000
const IDENTITIES_KEY = 'peer_identities'
const SNAPSHOTS_KEY = 'peer_sessions'

const SESSION_ID = /^[0-9a-f]{8}$/
const ROUTE = /^\/v1\/(sessions|widgets|roots|wakes|runs)\/([^/?]+)(\/[^?]*)?$/

export interface HubDeps {
  env: NodeJS.ProcessEnv
  uid?: number
  publish(type: EventType, data: Record<string, unknown>): void
  gui: { send(command: GuiCommand): Promise<GuiOutcome> }
  settings: { get(key: string): string | null; put(key: string, value: string): void }
  isLocalSession(id: string): boolean
  isLocalRoot(requestId: string): boolean
  isLocalRun(runId: string): boolean
  /** The badge name of a local coordinator (`↳ <name>` on a remote lane), or null. */
  leadName(id: string): string | null
  /** Make a local session a coordinator and return the lineage its lanes on
   * other machines carry; null when it is unknown. */
  claimLocal(launcherId: string): Lineage | null
  log?(message: string): void
  now?(): number
  random?(): number
  /** How a create wakes a host and checks it is ready (tests replace it). */
  gate?: Partial<GateRuntime>
  /** A silent peer stream's health check timing (tests shorten it). */
  stall?: PeerDeps['stall']
}

export interface Lineage {
  coordinatorId: string
  coordinatorColor: string | null
  /** The launcher itself; sent on only to a peer at API 9 or later. */
  parentId?: string | null
}

/** The first API version whose `POST /v1/roots` takes `lineage.parentId`. */
const PARENT_API_VERSION = 9

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function readJson<T>(raw: string | null, fallback: T): T {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function sameEntry(a: HostEntry, b: HostEntry): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** How long a host's `status` command may take. */
const STATUS_RUN_MS = 8_000

function unavailable(peer: Peer): HttpError {
  const reason =
    peer.state === 'identity_changed'
      ? (peer.error ?? `${peer.name} answers as a different machine`)
      : downReason(peer.name, peer.state)
  return new HttpError(409, 'host_unavailable', { host: peer.name, state: peer.state, reason })
}

export class Hub {
  private readonly peers = new Map<string, Peer>()
  private readonly file: string
  private fileStamp: string | null = null
  private reloadTimer: NodeJS.Timeout | null = null
  private persistTimer: NodeJS.Timeout | null = null
  private readonly snapshots: Record<string, PeerSnapshot>
  private readonly log: (message: string) => void
  private readonly now: () => number
  private readonly gate: GateRuntime
  /** One wake and readiness check per host, shared by concurrent creates. */
  private readonly gates = new Map<string, Promise<void>>()

  constructor(private readonly deps: HubDeps) {
    this.file = hostsFilePath(deps.env)
    this.log = deps.log ?? ((message) => console.log(`[tether:hub] ${message}`))
    this.now = deps.now ?? Date.now
    this.snapshots = readJson(deps.settings.get(SNAPSHOTS_KEY), {})
    this.gate = { ...defaultGateRuntime, ...deps.gate }
  }

  start(): void {
    this.reload()
    this.reloadTimer = setInterval(() => this.reload(), RELOAD_MS)
    this.reloadTimer.unref()
  }

  close(): void {
    if (this.reloadTimer) clearInterval(this.reloadTimer)
    this.reloadTimer = null
    for (const peer of this.peers.values()) peer.stop()
    this.peers.clear()
    this.flush()
  }

  /** Re-read hosts.json when it changed: start, restart or drop peers. */
  reload(): void {
    let stamp: string | null = null
    try {
      const stat = statSync(this.file)
      stamp = `${stat.ino}:${stat.mtimeMs}:${stat.size}`
    } catch {
      stamp = null
    }
    if (stamp === this.fileStamp && this.reloadTimer) return
    this.fileStamp = stamp
    const { hosts, errors, readable, held } = loadHosts(this.file)
    for (const error of errors) this.log(`hosts.json: ${error}`)
    // A file that does not parse (often an editor's half-written save) changes
    // nothing: dropping its hosts would close every window on them.
    if (!readable) {
      if (this.peers.size) this.log('hosts.json: keeping the hosts already loaded')
      return
    }
    const wanted = new Map(hosts.map((host) => [host.name, host]))
    for (const [name, peer] of this.peers) {
      const entry = wanted.get(name)
      if (entry && sameEntry(entry, peer.entry)) continue
      if (!entry && held.includes(name)) {
        this.log(`hosts.json: ${name}: keeping the running link until its entry is valid again`)
        continue
      }
      peer.stop()
      this.peers.delete(name)
      if (!entry) {
        delete this.snapshots[name]
        this.schedulePersist()
        this.deps.publish('peer.resync', { host: name })
      }
    }
    for (const entry of hosts) {
      if (this.peers.has(entry.name)) continue
      const paths = linkPaths(peerDir(this.deps.env, this.deps.uid, entry.name))
      const peer = new Peer(
        entry,
        paths.forwarded,
        paths.control,
        {
          publish: this.deps.publish,
          gui: this.deps.gui,
          isLocal: this.deps.isLocalSession,
          identity: {
            get: (name) => this.identities()[name] ?? null,
            set: (name, id) =>
              this.deps.settings.put(
                IDENTITIES_KEY,
                JSON.stringify({ ...this.identities(), [name]: id }),
              ),
          },
          persist: (name, snapshot) => {
            this.snapshots[name] = snapshot
            this.schedulePersist()
          },
          present: (owner, item) => this.present(owner, item),
          log: this.log,
          now: this.now,
          random: this.deps.random ?? Math.random,
          poweredOff: (host) => this.poweredOff(host),
          kick: (host) => this.gate.kick(host),
          ...(this.deps.stall ? { stall: this.deps.stall } : {}),
        },
        this.snapshots[entry.name] ?? null,
      )
      this.peers.set(entry.name, peer)
      peer.start()
    }
  }

  /** The host's `status` command, read: powered off when its output matches
   * `statusOff`; null when there is no command or it failed. */
  private async poweredOff(entry: HostEntry): Promise<boolean | null> {
    if (!entry.status) return null
    const result = await this.gate.run(entry.status, STATUS_RUN_MS)
    if (result.code !== 0) return null
    return new RegExp(entry.statusOff).test(result.output)
  }

  /** A host was powered off on purpose (the Hosts panel). */
  markPoweredOff(name: string): void {
    this.peers.get(name)?.poweredOff()
  }

  private identities(): Record<string, PeerIdentity> {
    return readJson(this.deps.settings.get(IDENTITIES_KEY), {})
  }

  private schedulePersist(): void {
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => this.flush(), PERSIST_DEBOUNCE_MS)
    this.persistTimer.unref()
  }

  private flush(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = null
    this.deps.settings.put(SNAPSHOTS_KEY, JSON.stringify(this.snapshots))
  }

  /** A peer's descriptor as clients see it. */
  private present(peer: Peer, item: Descriptor): Descriptor {
    const out: Descriptor = { ...item, host: peer.name }
    const mark = peer.mark()
    if (mark) out.peer = mark
    else delete out.peer
    // A lane launched by a coordinator on this computer names it.
    const badge = record(item.badge)
    if (badge?.kind === 'child' && typeof item.coordinatorId === 'string') {
      const name = this.deps.leadName(item.coordinatorId)
      if (name) out.badge = { ...badge, text: `↳ ${name}` }
    }
    return out
  }

  /** `GET /v1/hosts`. */
  hosts(): Record<string, unknown>[] {
    return [...this.peers.values()].map((peer) => ({
      name: peer.name,
      ssh: peer.entry.ssh,
      control: peer.control,
      ...(peer.entry.stateDir ? { stateDir: peer.entry.stateDir } : {}),
      state: peer.state,
      since: peer.since,
      listedAt: peer.listedAt,
      sessions: peer.count(),
      error: peer.error,
      wake: peer.wake,
    }))
  }

  /** Accept the machine that now answers for `name` (after identity_changed). */
  trust(name: string): void {
    const peer = this.peers.get(name)
    if (!peer) throw new HttpError(404, 'unknown_host', { host: name })
    if (!peer.trust()) throw new HttpError(409, 'identity_unchanged', { host: name })
  }

  /** Every peer's sessions, queried in parallel (bounded by a short timeout
   * and each peer's circuit breaker); a peer that cannot answer contributes
   * its last-known descriptors, marked. */
  async sessions(): Promise<Descriptor[]> {
    const lists = await Promise.all(
      [...this.peers.values()].map((peer) => peer.list(LIST_TIMEOUT_MS)),
    )
    return lists.flat()
  }

  /** Local runs plus each peer's, tagged; a peer that is down makes the answer stale. */
  mergeRuns<T extends { status: RunsLike['status']; error: string | null; items: object[] }>(
    local: T,
  ): T {
    const merged: T = { ...local, items: [...local.items] }
    for (const peer of this.peers.values()) {
      const runs = peer.runs()
      if (!runs) continue
      merged.items.push(...runs.items.map((item) => ({ ...item, host: peer.name })))
      // Only rows can be out of date: a host that lists none (one with no
      // Agent Hub client id never asks) leaves this computer's runs alone.
      const stale = runs.items.length > 0 && (!peer.live || runs.status !== 'ok')
      if (stale && merged.status === 'ok') {
        merged.status = 'stale'
        merged.error ??= peer.live ? runs.error : downReason(peer.name, peer.state)
      }
    }
    return merged
  }

  /** Every peer's `GET /v1/roots` items for this query, tagged with `host`. */
  async roots(search: string): Promise<Record<string, unknown>[]> {
    const lists = await Promise.all(
      [...this.peers.values()].map((peer) => peer.listRoots(search, LIST_TIMEOUT_MS)),
    )
    return lists.flat()
  }

  private knownPeer(name: unknown): Peer {
    if (typeof name !== 'string' || !name)
      throw new HttpError(400, 'invalid_body', { field: 'host' })
    const peer = this.peers.get(name)
    if (!peer) throw new HttpError(400, 'unknown_host', { host: name })
    return peer
  }

  private requirePeer(name: unknown): Peer {
    const peer = this.knownPeer(name)
    if (!peer.live) throw unavailable(peer)
    return peer
  }

  /** Power a host on and wait until it is ready, as a create would (the
   * Hosts panel's power control). Rejects with `409 host_unavailable`. */
  async wakeHost(name: string): Promise<void> {
    const peer = this.knownPeer(name)
    await this.ready(peer)
    if (!peer.live) throw unavailable(peer)
  }

  /** The registry entry of a host this hub knows, or null. */
  hostEntry(name: string): HostEntry | null {
    return this.peers.get(name)?.entry ?? null
  }

  /** Wake `peer` if it is down and wait until a create can go there; one
   * gate per host, shared by every create that arrives meanwhile. */
  private ready(peer: Peer): Promise<void> {
    const running = this.gates.get(peer.name)
    if (running) return running
    if (peer.live && peer.entry.health.length === 0) return Promise.resolve()
    const gate = readyHost(peer, this.gate, (progress) => {
      if (progress?.state === 'failed') this.log(`${peer.name}: start failed: ${progress.error}`)
      else if (progress) this.log(`${peer.name}: starting (${progress.step})`)
      peer.setWake(progress)
    }).finally(() => this.gates.delete(peer.name))
    this.gates.set(peer.name, gate)
    return gate
  }

  private ownerOf(kind: string, id: string): Peer | null {
    for (const peer of this.peers.values()) {
      if (kind === 'sessions' || kind === 'widgets') {
        if (SESSION_ID.test(id) && !this.deps.isLocalSession(id) && peer.ownsSession(id))
          return peer
      } else if (kind === 'roots') {
        if (!this.deps.isLocalRoot(id) && peer.ownsRoot(id)) return peer
      } else if (kind === 'wakes') {
        if (peer.ownsWake(id)) return peer
      } else if (kind === 'runs') {
        if (!this.deps.isLocalRun(id) && peer.ownsRun(id)) return peer
      }
    }
    return null
  }

  /** The JSON a peer answered, as clients see it: `host` on the answer and on
   * each listed item; a descriptor refreshes the cache. */
  private rewrite(peer: Peer, status: number, body: unknown, attach = false): unknown {
    const value = record(body)
    if (!value) return body
    if (status < 300 && isDescriptor(value)) {
      peer.upsert(value)
      return this.present(peer, value)
    }
    const out: Record<string, unknown> = { ...value, host: peer.name }
    if (Array.isArray(value.items))
      out.items = value.items.map((item) =>
        typeof record(item)?.id === 'string' ? { ...(item as object), host: peer.name } : item,
      )
    if (typeof value.requestId === 'string') peer.rememberRoot(value.requestId)
    if (attach && status === 200)
      out.ssh = {
        alias: peer.entry.ssh,
        control: peer.control,
        ...(peer.entry.stateDir ? { stateDir: peer.entry.stateDir } : {}),
      }
    return out
  }

  /**
   * Take a per-session request owned by a peer: forwarded verbatim; a peer
   * that is down answers `409 host_unavailable`, never 404. False when the
   * route is not a peer's (the local router handles it).
   */
  forward(req: IncomingMessage, res: ServerResponse): boolean {
    if (this.peers.size === 0) return false
    const path = (req.url ?? '/').split('?')[0] ?? '/'
    const match = ROUTE.exec(path)
    if (!match) return false
    const [, kind, rawId, rest = ''] = match
    let id: string
    try {
      id = decodeURIComponent(rawId ?? '')
    } catch {
      return false
    }
    const peer = this.ownerOf(kind ?? '', id)
    if (!peer) return false
    if (!peer.live) {
      req.resume()
      const error = unavailable(peer)
      sendJson(res, error.status, { error: error.code, ...error.extra })
      return true
    }
    const attach = kind === 'sessions' && rest === '/attach'
    void forwardRequest(peer.socket, req, res, (status, body) =>
      this.rewrite(peer, status, body, attach),
    ).then((reached) => {
      if (reached || res.headersSent) return
      const error = unavailable(peer)
      sendJson(res, error.status, { error: error.code, ...error.extra })
    })
    return true
  }

  /** `POST /v1/sessions` or `POST /v1/roots` with `host`: the host is woken
   * and checked ready if needed, then the create is forwarded to it without
   * `host` (and with lineage from a local launcher). */
  async create(
    res: ServerResponse,
    path: '/v1/sessions' | '/v1/roots',
    body: Record<string, unknown>,
  ): Promise<void> {
    const peer = this.knownPeer(body.host)
    await this.ready(peer)
    if (!peer.live) throw unavailable(peer)
    const { host: _host, ...forwarded } = body
    if (path === '/v1/roots' && typeof forwarded.launchedBy === 'string') {
      const launcher = forwarded.launchedBy
      if (!peer.ownsSession(launcher)) {
        const lineage = this.lineageFor(launcher)
        delete forwarded.launchedBy
        if (lineage) {
          // An older Tether refuses lineage keys it does not know.
          const { parentId, ...root } = lineage
          const knowsParent = (peer.apiVersion ?? 0) >= PARENT_API_VERSION
          forwarded.lineage = knowsParent && parentId ? { ...root, parentId } : root
        }
      }
    }
    let answer: Awaited<ReturnType<typeof peerRequest>>
    try {
      answer = await peerRequest(peer.socket, 'POST', path, forwarded, CREATE_TIMEOUT_MS)
    } catch (error) {
      const message = (error as Error).message
      // Refused before anything was sent: nothing was created.
      if (/ECONNREFUSED|ENOENT/.test(message)) throw unavailable(peer)
      throw new HttpError(409, 'outcome_uncertain', { host: peer.name, reason: message })
    }
    if (path === '/v1/roots' && typeof forwarded.requestId === 'string' && answer.status < 300)
      peer.rememberRoot(forwarded.requestId)
    sendJson(res, answer.status, this.rewrite(peer, answer.status, answer.body))
  }

  /** `GET /v1/tools?host=` and `/v1/projects?host=`: the peer's answer. */
  async query(res: ServerResponse, host: string, path: string): Promise<void> {
    const peer = this.requirePeer(host)
    let answer: Awaited<ReturnType<typeof peerRequest>>
    try {
      answer = await peerRequest(peer.socket, 'GET', path, undefined, QUERY_TIMEOUT_MS)
    } catch (error) {
      if (error instanceof PeerUnavailable) throw unavailable(peer)
      throw error
    }
    const value = record(answer.body)
    sendJson(res, answer.status, value ? { ...value, host: peer.name } : answer.body)
  }

  /**
   * The coordinator lineage a session on another machine inherits from
   * `launcherId`: a local launcher's (which becomes a coordinator), or a
   * remote launcher's from its descriptor, with the launcher as parent.
   * Null when no one knows it.
   */
  lineageFor(launcherId: string): Lineage | null {
    if (this.deps.isLocalSession(launcherId)) return this.deps.claimLocal(launcherId)
    for (const peer of this.peers.values()) {
      const launcher = peer.session(launcherId)
      if (!launcher) continue
      const coordinatorId =
        typeof launcher.coordinatorId === 'string' ? launcher.coordinatorId : launcher.id
      const color = typeof launcher.coordinatorColor === 'string' ? launcher.coordinatorColor : null
      return { coordinatorId, coordinatorColor: color, parentId: launcherId }
    }
    return null
  }
}
