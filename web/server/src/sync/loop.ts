// The pull loop: for each peer, one after another, `notes` then `web`, then the
// blobs the notes now name. It runs every interval, when a peer nudges, and
// after a local write (which nudges the peers first). A local write is a change
// in a file's `seq` that no pull accounts for, noticed by a cheap poll. Once a day it clears old
// tombstones and unreferenced blobs. Timers live only in `start()`; everything
// else is called directly, so tests drive it with a fake clock.

import type { SyncPeer } from 'tether/client'
import { copyMissingBlobs, removeUnreferenced } from './blobs'
import { type PullStatus, pullSet, purgeTombstones, type SyncHandle } from './engine'
import type { Peer } from './peer'

const DAY_MS = 86_400_000
const LAST_MAINTENANCE = 'maintenance_at'

export interface LoopDeps {
  notes: SyncHandle
  web: SyncHandle
  blobsDir: string
  /** The peers that have a sync socket, read fresh so a hosts.json edit applies. */
  peers(): SyncPeer[]
  connect(peer: SyncPeer): Peer
  now(): number
  tombstoneMs: number
  maxAheadMs: number
  blobGraceMs: number
  intervalMs: number
  /** How often to look for a local write (a change of the files' `seq`). */
  watchMs: number
  log(message: string): void
}

export interface PeerStatus {
  /** The hosts.json name. */
  name: string
  /** What the peer calls itself, once it has answered. */
  host: string | null
  state: 'ok' | 'down' | 'paused' | 'error' | 'waiting'
  /** When a pass last finished cleanly. */
  lastSyncAt: number | null
  /** The peer's clock minus ours, in ms. */
  skewMs: number | null
  /** Why sync is paused or failing, in words. */
  reason: string | null
}

const PAUSED: Partial<Record<PullStatus, string>> = {
  schema_mismatch: "The two Aico versions have different databases. Update the one that's behind.",
  clock_ahead: "The other computer's clock is more than a day ahead. Fix its clock.",
}

export class SyncLoop {
  private statuses = new Map<string, PeerStatus>()
  private running: Promise<void> | null = null
  private again = false
  private dirty = false
  private timers: NodeJS.Timeout[] = []
  /** The `seq` of each file as far as this host's own pulls explain it. */
  private known: { notes: number; web: number }

  constructor(private readonly deps: LoopDeps) {
    this.known = this.seqs()
  }

  private seqs(): { notes: number; web: number } {
    return {
      notes: Number(this.deps.notes.meta('seq') ?? 0),
      web: Number(this.deps.web.meta('seq') ?? 0),
    }
  }

  /** Notices writes that did not come from a pull, and tells the peers. */
  watch(): void {
    const now = this.seqs()
    if (now.notes === this.known.notes && now.web === this.known.web) return
    this.known = now
    this.localWrite()
  }

  start(): void {
    if (this.timers.length === 0) {
      this.timers = [
        setInterval(() => void this.run(), this.deps.intervalMs),
        setInterval(() => this.watch(), this.deps.watchMs),
      ]
      for (const timer of this.timers) timer.unref()
    }
    void this.run()
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer)
    this.timers = []
  }

  /** A peer says it wrote: pull soon. */
  nudged(): void {
    void this.run()
  }

  /** This host wrote: tell the peers, then pull. */
  localWrite(): void {
    this.dirty = true
    queueMicrotask(() => void this.run())
  }

  /** The state of every peer in hosts.json that syncs. */
  status(): PeerStatus[] {
    return this.deps.peers().map(
      (peer) =>
        this.statuses.get(peer.name) ?? {
          name: peer.name,
          host: null,
          state: 'waiting',
          lastSyncAt: null,
          skewMs: null,
          reason: null,
        },
    )
  }

  /** One pass over all peers; a request that comes while one runs makes it go round again. */
  run(): Promise<void> {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = (async () => {
      try {
        do {
          this.again = false
          await this.pass()
        } while (this.again)
      } catch (error) {
        this.deps.log(`sync pass failed: ${(error as Error).message}`)
      } finally {
        this.running = null
      }
    })()
    return this.running
  }

  private async pass(): Promise<void> {
    const peers = this.deps.peers()
    const tell = this.dirty
    this.dirty = false
    for (const peer of peers) {
      const link = this.deps.connect(peer)
      if (tell) await link.nudge().catch(() => {}) // down: it pulls on its own tick
      try {
        await this.pull(peer, link)
      } catch (error) {
        this.deps.log(`${peer.name}: ${(error as Error).message}`)
      }
    }
    await this.maintain(peers)
  }

  private async pull(peer: SyncPeer, link: Peer): Promise<void> {
    const { notes, web, maxAheadMs } = this.deps
    const results = [
      await pullSet(notes, link, { maxAheadMs }),
      await pullSet(web, link, { maxAheadMs }),
    ]
    // Each applied row took one change number: not a local write.
    this.known = {
      notes: this.known.notes + (results[0]?.applied ?? 0),
      web: this.known.web + (results[1]?.applied ?? 0),
    }
    const host = results.find((result) => result.host)?.host ?? null
    const paused = results.find((result) => PAUSED[result.status])
    const failed = results.find((result) => result.status === 'error')
    const down = results.every((result) => result.status === 'unreachable')
    let state: PeerStatus['state'] = 'ok'
    let reason: string | null = null
    if (paused) {
      state = 'paused'
      reason = PAUSED[paused.status] ?? null
    } else if (failed) {
      state = 'error'
      reason = failed.error ?? 'Sync failed'
    } else if (down) state = 'down'
    else if (results.some((result) => result.status === 'unreachable')) state = 'error'
    const skew = results.find((result) => result.skewMs !== null)?.skewMs ?? null
    const before = this.statuses.get(peer.name)
    this.statuses.set(peer.name, {
      name: peer.name,
      host: host ?? before?.host ?? null,
      state,
      lastSyncAt: state === 'ok' ? this.deps.now() : (before?.lastSyncAt ?? null),
      skewMs: skew ?? before?.skewMs ?? null,
      reason,
    })
    // A peer that is down is skipped quietly; say only when something changes.
    if (state !== 'down' && state !== before?.state)
      this.deps.log(`${peer.name}: sync ${state}${reason ? ` (${reason})` : ''}`)
    const applied = results.reduce((sum, result) => sum + result.applied, 0)
    if (applied > 0) this.deps.log(`${peer.name}: pulled ${applied} change(s)`)
    if (state === 'ok') {
      const copy = await copyMissingBlobs(notes, link, this.deps.blobsDir, this.deps.log).catch(
        (error) => {
          this.deps.log(`${peer.name}: blob copy stopped: ${(error as Error).message}`)
          return null
        },
      )
      if (copy?.fetched) this.deps.log(`${peer.name}: copied ${copy.fetched} file(s)`)
    }
  }

  /** Once a day: tombstones every peer has pulled past, and blobs nothing names. */
  private async maintain(peers: SyncPeer[]): Promise<void> {
    const { notes, web, now } = this.deps
    const last = Number(notes.meta(LAST_MAINTENANCE) ?? 0)
    if (now() - last < DAY_MS) return
    // The peers' names for themselves are what they ask with; fall back to the registry name.
    const names = peers.map((peer) => this.statuses.get(peer.name)?.host ?? peer.name)
    const removed = [notes, web].map((handle) =>
      purgeTombstones(handle, { retentionMs: this.deps.tombstoneMs, peers: names }),
    )
    const blobs = await removeUnreferenced(this.deps.blobsDir, [notes, web], {
      graceMs: this.deps.blobGraceMs,
      now: now(),
    }).catch((error) => {
      this.deps.log(`blob cleanup failed: ${(error as Error).message}`)
      return 0
    })
    notes.setMeta(LAST_MAINTENANCE, String(now()))
    this.deps.log(`cleanup: ${removed[0]} + ${removed[1]} tombstone(s), ${blobs} blob file(s)`)
  }
}
