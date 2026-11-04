// The hub (docs/plans/remote-hosts.md "Hub"): this Tether federates the remote
// Tethers in hosts.json, so every client keeps talking to its one local socket.
// Lists merge the peers' sessions (tagged `host`), per-session routes go
// verbatim to the owning peer, peer events are relayed with `host`, and create
// takes a `host`. A down peer's sessions stay listed as stale, never gone.

import { statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { type HostEntry, hostsFilePath, loadHosts, peerDir } from '@aico/fleet/hosts'
import { linkPaths } from '@aico/fleet/link'
import { forwardRequest, PeerUnavailable, peerRequest } from '@aico/fleet/peer-http'
import { fleetFile, readSettings } from '@aico/fleet/settings'
import { API_VERSION } from '../config'
import type { EventType } from '../events'
import { HttpError, sendJson } from '../http'
import { ADAPTERS, adapterOf } from '../lifecycle/tui/registry'
import {
  type Descriptor,
  downReason,
  isDescriptor,
  Peer,
  type PeerIdentity,
  type PeerSnapshot,
  type PeerUpdate,
  type RunsLike,
} from './peer'
import type { PeerView } from './placement'
import { installStarted, pushRelease, releaseId, runningRelease, type Updater } from './update'
import { defaultGateRuntime, type GateRuntime, readyHost } from './wake'

export const LIST_TIMEOUT_MS = 1_500
export const QUERY_TIMEOUT_MS = 10_000
/** Create waits for the peer's own launch (agent admission can be slow). */
export const CREATE_TIMEOUT_MS = 120_000
const RELOAD_MS = 5_000
const PERSIST_DEBOUNCE_MS = 2_000
const IDENTITIES_KEY = 'peer_identities'
/** How long an updated host's Tether has to come back on the link. */
export const UPDATE_RECONNECT_MS = 60_000
const UPDATE_POLL_MS = 500
/** Failed updates by host, with the hub release that tried them. */
const UPDATE_FAILURES_KEY = 'peer_update_failures'
const SNAPSHOTS_KEY = 'peer_sessions'

const SESSION_ID = /^[0-9a-f]{8}$/
const ROUTE = /^\/v1\/(sessions|widgets|roots|wakes|runs|asks)\/([^/?]+)(\/[^?]*)?$/
/** The session asking for a forwarded End (API 23; lowercase, as Node keeps it). */
export const ENDED_BY_HEADER = 'tether-ended-by'

export interface HubDeps {
  env: NodeJS.ProcessEnv
  /** Tests may provide their in-process peer endpoints. Production uses only configured fleet peers. */
  fleetPeers?: () => string[]
  fault?(error: unknown): void
  uid?: number
  publish(type: EventType, data: Record<string, unknown>): void
  settings: { get(key: string): string | null; put(key: string, value: string): void }
  isLocalSession(id: string): boolean
  /** With an identity, match only that exact root, not a same-named remote root. */
  isLocalRoot(requestId: string, logicalSessionId?: string): boolean
  isLocalRun(runId: string): boolean
  isLocalAsk?(id: string): boolean
  /** The badge name of a local coordinator (`↳ <name>` on a remote lane), or null. */
  leadName(id: string): string | null
  /** Make a local session a coordinator and return the lineage its lanes on
   * other machines carry; null when it is unknown. */
  claimLocal(launcherId: string): Lineage | null
  /** An End forwarded to a peer named the session asking for it (the
   * `Tether-Ended-By` header, API 23): `by`, or null once that End did not
   * end it. Lane reports spare that session the relayed `ended` line. */
  endedBy?(host: string, id: string, by: string | null): void
  log?(message: string): void
  now?(): number
  random?(): number
  /** How a create wakes a host and checks it is ready (tests replace it). */
  gate?: Partial<GateRuntime>
  /** How a host whose Tether is on an older API gets this release
   * (src/hub/update.ts; tests replace it), and how long it then has to come
   * back on the link. */
  update?: Updater
  updateReconnectMs?: number
  /** This hub's release (src/hub/update.ts releaseId; tests set it). */
  release?: string
}

/** A failed update as settings keep it: the same from/to is tried again only
 * by another hub release. */
type UpdateFailure = PeerUpdate & { release: string }

export interface Lineage {
  coordinatorId: string
  coordinatorColor: string | null
  /** The launcher itself; sent on only to a peer at API 9 or later. */
  parentId?: string | null
}

/** The first API version whose `POST /v1/roots` takes `lineage.parentId`. */
const PARENT_API_VERSION = 9
/** The first Tether API that runs a root through its host's entries.json. */
const ENTRY_API_VERSION = 15

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
  /** Host names (valid or held) in the last hosts.json that was there and
   * parsed; null until one was. */
  private listed: Set<string> | null = null
  private reloadTimer: NodeJS.Timeout | null = null
  private persistTimer: NodeJS.Timeout | null = null
  private readonly snapshots: Record<string, PeerSnapshot>
  private readonly log: (message: string) => void
  private readonly now: () => number
  private readonly gate: GateRuntime
  /** One wake and readiness check per host, shared by concurrent creates. */
  private readonly gates = new Map<string, Promise<void>>()
  /** The update running per host; a create there waits for it. */
  private readonly updates = new Map<string, Promise<void>>()
  private readonly updater: Updater
  private readonly release: string

  constructor(private readonly deps: HubDeps) {
    this.file = hostsFilePath(deps.env)
    this.log = deps.log ?? ((message) => console.log(`[tether:hub] ${message}`))
    this.now = deps.now ?? Date.now
    this.snapshots = readJson(deps.settings.get(SNAPSHOTS_KEY), {})
    this.gate = { ...defaultGateRuntime, ...deps.gate }
    const release = runningRelease()
    this.updater = deps.update ?? ((target) => pushRelease(release, target))
    this.release = deps.release ?? releaseId(release)
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
    try {
      this.reloadFiles()
    } catch (error) {
      this.fileStamp = null
      this.log(`Link reload failed: ${error instanceof Error ? error.message : String(error)}`)
      this.deps.fault?.(error)
    }
  }

  private reloadFiles(): void {
    let stamp: string | null = null
    try {
      const stat = statSync(this.file)
      stamp = `${stat.ino}:${stat.mtimeMs}:${stat.size}`
    } catch {
      stamp = null
    }
    if (!this.deps.fleetPeers) {
      try {
        const stat = statSync(fleetFile(this.deps.env))
        stamp = `${stamp}:fleet:${stat.ino}:${stat.mtimeMs}:${stat.size}`
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    if (stamp === this.fileStamp && this.reloadTimer) return
    this.fileStamp = stamp
    const loaded = loadHosts(this.file)
    const enabled = new Set(
      this.deps.fleetPeers?.() ??
        readSettings(this.deps.env, '')?.peers.map((peer) => peer.name) ??
        [],
    )
    const { errors, readable, held, missing } = loaded
    const hosts = loaded.hosts.filter((entry) => enabled.has(entry.name))
    for (const error of errors) this.log(`hosts.json: ${error}`)
    // A file that does not parse (often an editor's half-written save) changes
    // nothing: dropping its hosts would close every window on them.
    if (!readable) {
      if (this.peers.size) this.log('hosts.json: keeping the hosts already loaded')
      return
    }
    // A file briefly gone retires nothing (placement keeps its reservations).
    if (!missing) this.listed = new Set([...hosts.map((host) => host.name), ...held])
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
        this.forgetUpdateFailure(name)
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
          isLocal: this.deps.isLocalSession,
          ...(this.deps.isLocalAsk ? { isLocalAsk: this.deps.isLocalAsk } : {}),
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
          checked: (peer) => this.checkRelease(peer),
        },
        this.snapshots[entry.name] ?? null,
      )
      // A failed update stays visible across hub restarts.
      const failed = this.updateFailures()[entry.name]
      if (failed) {
        const { release: _release, ...update } = failed
        peer.setUpdate(update)
      }
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
      apiVersion: peer.apiVersion,
      update: peer.update,
      canSleep: peer.entry.sleep !== null,
    }))
  }

  /** On each link-up: a peer whose Tether is on an older API than this one
   * gets this release (src/hub/update.ts): one attempt per link-up, one
   * update per host at a time. One that failed after the host began installing
   * is remembered in settings and the same from/to is tried again only by
   * another hub release, so a host that cannot take it is not restarted on
   * every link-up or hub restart. One that failed before (no ssh, a dropped
   * link, a held lock) installed nothing and is tried on the next link-up. A
   * peer that names no API, or a newer one, is left alone. */
  private checkRelease(peer: Peer): void {
    // The production updater sends only verified, signed releases.
    const from = peer.apiVersion
    if (from !== null && from >= API_VERSION && peer.update?.state === 'failed') {
      // Brought up to this API some other way: the failure no longer holds.
      peer.setUpdate(null)
      this.forgetUpdateFailure(peer.name)
    }
    if (from === null || from >= API_VERSION || this.updates.has(peer.name)) return
    const failed = this.updateFailures()[peer.name]
    if (failed && failed.from === from && failed.to === API_VERSION) {
      if (failed.release === this.release) return
      this.log(`${peer.name}: the last Tether update failed on another hub release; trying again`)
    }
    const run = this.updatePeer(peer, from)
      .catch((error: Error) => this.log(`${peer.name}: Tether update failed: ${error.message}`))
      .finally(() => this.updates.delete(peer.name))
    this.updates.set(peer.name, run)
  }

  private updateFailures(): Record<string, UpdateFailure> {
    return readJson(this.deps.settings.get(UPDATE_FAILURES_KEY), {})
  }

  private forgetUpdateFailure(name: string): void {
    const failures = this.updateFailures()
    if (!(name in failures)) return
    delete failures[name]
    this.deps.settings.put(UPDATE_FAILURES_KEY, JSON.stringify(failures))
  }

  private async updatePeer(peer: Peer, from: number): Promise<void> {
    const to = API_VERSION
    peer.setUpdate({ state: 'updating', from, to, since: this.now(), error: null })
    this.log(`${peer.name}: its Tether is API ${from}, this one is ${to}; updating it`)
    /** `remember` false: nothing was installed (no ssh, a dropped link, a
     * held lock), so the next link-up tries again. */
    const fail = (why: string, remember = true) => {
      const error = remember
        ? why
        : `${why}; nothing was installed, tried again on the next link-up`
      this.log(`${peer.name}: Tether update failed: ${error}`)
      const update: PeerUpdate = { state: 'failed', from, to, since: this.now(), error }
      peer.setUpdate(update)
      if (!remember) return this.forgetUpdateFailure(peer.name)
      this.deps.settings.put(
        UPDATE_FAILURES_KEY,
        JSON.stringify({
          ...this.updateFailures(),
          [peer.name]: { ...update, release: this.release },
        }),
      )
    }
    let result: Awaited<ReturnType<Updater>>
    try {
      result = await this.updater({
        entry: peer.entry,
        control: peer.control,
        instance: peer.instance,
      })
    } catch (error) {
      return fail((error as Error).message, false)
    }
    if (result.code !== 0)
      return fail(result.output || `exit ${result.code ?? 'error'}`, installStarted(result))
    // The restart dropped the peer's stream; wait for the link-up on the new release.
    const waitMs = this.deps.updateReconnectMs ?? UPDATE_RECONNECT_MS
    const deadline = this.now() + waitMs
    while (!(peer.live && (peer.apiVersion ?? 0) >= to)) {
      if (this.now() >= deadline)
        return fail(
          peer.live
            ? `its Tether still answers API ${peer.apiVersion ?? 'unknown'} after the update`
            : `its Tether did not come back within ${Math.round(waitMs / 1000)} s after the update`,
        )
      peer.retryNow()
      await new Promise<void>((resolve) => setTimeout(resolve, UPDATE_POLL_MS).unref())
    }
    this.log(`${peer.name}: Tether updated from API ${from} to ${peer.apiVersion}`)
    peer.setUpdate({ state: 'updated', from, to, since: this.now(), error: null })
    this.forgetUpdateFailure(peer.name)
  }

  /** Why a host refused a request it may not know yet: its Tether is on an
   * older API than this one. Null when it is not. */
  private behind(peer: Peer): string | null {
    const api = peer.apiVersion
    if (api === null || api >= API_VERSION) return null
    const base = `remote Tether on ${peer.name} is API ${api}, needs ${API_VERSION}`
    const update = peer.update
    if (update?.state === 'failed') return `${base}; update failed: ${update.error}`
    return `${base}; updating`
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

  /** Local asks plus each peer's (tagged with `host`; `peer` says why they are not
   * live while the link is down), filtered as `GET /v1/asks` filters. */
  mergeAsks(
    local: Record<string, unknown>[],
    filter: { session?: string; requester?: string; states: string[] },
  ): Record<string, unknown>[] {
    const wanted = (ask: Record<string, unknown>) =>
      (!filter.session || ask.session === filter.session) &&
      (!filter.requester || ask.requester === filter.requester) &&
      (!filter.states.length || filter.states.includes(ask.state as string))
    const remote = [...this.peers.values()].flatMap((peer) => peer.asks().filter(wanted))
    return [...local, ...remote]
  }

  /** Local shares plus each peer's, oldest first so a client's cursor still works. */
  mergeShares(local: Record<string, unknown>[]): Record<string, unknown>[] {
    const remote = [...this.peers.values()].flatMap((peer) => peer.shares())
    if (!remote.length) return local
    const at = (item: Record<string, unknown>) => Date.parse(String(item.createdAt)) || 0
    return [...local, ...remote].sort((a, b) => at(a) - at(b))
  }

  /** Every peer's `GET /v1/roots` items for this query, tagged with `host`. */
  async roots(search: string): Promise<Record<string, unknown>[]> {
    const lists = await Promise.all(
      [...this.peers.values()].map((peer) => peer.listRoots(search, LIST_TIMEOUT_MS)),
    )
    const seen = new Set<string>()
    return lists.flat().filter((item) => {
      const id = item.requestId
      if (typeof id !== 'string') return true
      const logical = item.logicalSessionId
      if (typeof logical === 'string' && this.deps.isLocalRoot(id, logical)) return false
      const identity = JSON.stringify([id, logical, item.hostIdentity])
      if (seen.has(identity)) return false
      seen.add(identity)
      return true
    })
  }

  private knownPeer(name: unknown): Peer {
    if (typeof name !== 'string' || !name)
      throw new HttpError(400, 'invalid_body', { field: 'host' })
    let peer = this.peers.get(name)
    if (!peer) {
      // A host may have been provisioned since the last periodic catalog reload.
      this.reload()
      peer = this.peers.get(name)
    }
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

  /** The hosts this hub knows, in hosts.json order. */
  hostNames(): string[] {
    return [...this.peers.keys()]
  }

  /** A host taken out of hosts.json: the last file that was there and parsed
   * does not name it. Never one only briefly missing, invalid or unread. */
  retired(name: string): boolean {
    return this.listed !== null && !this.listed.has(name)
  }

  /** What placement reads about a host (src/hub/placement.ts), or null. */
  peerView(name: string): PeerView | null {
    const peer = this.peers.get(name)
    if (!peer) return null
    return {
      entry: peer.entry,
      live: peer.live,
      state: peer.state,
      socket: peer.socket,
      control: peer.control,
    }
  }

  /** The host that owns a root request, or null when none is known to. */
  rootOwner(requestId: string): string | null {
    for (const peer of this.peers.values()) if (peer.ownsRoot(requestId)) return peer.name
    return null
  }

  /** A relayed session by its id or root request id (waits on a host's
   * session): the host and its cached descriptor, or null. */
  remoteSession(ref: string): { host: string; session: Record<string, unknown> } | null {
    for (const peer of this.peers.values()) {
      for (const item of peer.descriptors()) {
        const session = item as unknown as Record<string, unknown>
        if (session.id === ref || session.rootRequestId === ref) return { host: peer.name, session }
      }
    }
    return null
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
    if (peer.live && peer.entry.health.length === 0 && !this.updates.has(peer.name))
      return Promise.resolve()
    const gate = readyHost(
      peer,
      this.gate,
      (progress) => {
        if (progress?.state === 'failed') this.log(`${peer.name}: start failed: ${progress.error}`)
        else if (progress) this.log(`${peer.name}: starting (${progress.step})`)
        peer.setWake(progress)
      },
      () => this.updates.get(peer.name) ?? null,
    ).finally(() => this.gates.delete(peer.name))
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
      } else if (kind === 'asks') {
        if (!this.deps.isLocalAsk?.(id) && peer.ownsAsk(id)) return peer
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
    // An older Tether refuses a field it does not know as a bare invalid_body.
    const behind = status === 400 && value.error === 'invalid_body' ? this.behind(peer) : null
    if (behind)
      out.reason = typeof value.reason === 'string' ? `${behind} (${value.reason})` : behind
    if (Array.isArray(value.items))
      out.items = value.items.map((item) =>
        typeof record(item)?.id === 'string' ? { ...(item as object), host: peer.name } : item,
      )
    if (typeof value.requestId === 'string') peer.rememberRoot(value.requestId)
    if (attach && status === 200)
      out.fleet = {
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
    // The header stays out of the forwarded body, so an older peer is fine.
    const header = req.headers[ENDED_BY_HEADER]
    const endedBy =
      kind === 'sessions' &&
      rest === '/end' &&
      req.method === 'POST' &&
      typeof header === 'string' &&
      SESSION_ID.test(header) &&
      header !== id
        ? header
        : null
    if (endedBy) this.deps.endedBy?.(peer.name, id, endedBy)
    void forwardRequest(peer.socket, req, res, (status, body) => {
      if (endedBy && (status !== 200 || record(body)?.status !== 'ended'))
        this.deps.endedBy?.(peer.name, id, null)
      return this.rewrite(peer, status, body, attach)
    }).then((reached) => {
      if (!reached && endedBy) this.deps.endedBy?.(peer.name, id, null)
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
    // Also waits out an update of the host's Tether, within the host's bound.
    await this.ready(peer)
    if (!peer.live) throw unavailable(peer)
    const { host: _host, ...forwarded } = body
    // An older Tether would refuse the key as a bare invalid_body.
    if (
      path === '/v1/roots' &&
      forwarded.entry !== undefined &&
      forwarded.entry !== null &&
      (peer.apiVersion ?? 0) < ENTRY_API_VERSION
    )
      throw new HttpError(400, 'entry_unsupported', {
        host: peer.name,
        reason: `${peer.name} runs a Tether without session entries (API ${peer.apiVersion ?? 'unknown'})`,
      })
    const needs = adapterOf(forwarded.tool)?.entryApiVersion
    if (
      path === '/v1/roots' &&
      forwarded.entry !== undefined &&
      forwarded.entry !== null &&
      needs &&
      (peer.apiVersion ?? 0) < needs
    ) {
      // The tools that peer's Tether runs through an entry, in words.
      const runs = ADAPTERS.filter(
        (adapter) => adapter.entryApiVersion && (peer.apiVersion ?? 0) >= adapter.entryApiVersion,
      ).map((adapter) => adapter.id)
      const list = runs.length > 1 ? `${runs.slice(0, -1).join(', ')} and ${runs.at(-1)}` : runs[0]
      throw new HttpError(400, 'entry_unsupported', {
        host: peer.name,
        reason: `${peer.name} runs a Tether whose entries run ${list} only (API ${peer.apiVersion ?? 'unknown'})`,
      })
    }
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
