// The server's background work (the Python backend's tether_events.py and
// maintenance.py). One Tether event stream feeds the open terminals, the
// tab links (an ended session's link goes; a session's tool keeps its link's
// mode) and agent shares; a gap, a daemon restart or a fresh connect
// reconciles links against Tether's list. Maintenance runs at startup and on
// an interval: reconcile, delete old uploads, prune settings of projects
// Tether no longer lists.

import {
  followEvents,
  type SessionDescriptor,
  type TetherClient,
  TetherError,
  type TetherEvent,
  TetherUnavailable,
} from 'tether/client'
import type { Asks } from './asks'
import type { MaintenanceConfig, UploadConfig } from './config'
import type { WebStore } from './db'
import type { Shows } from './shows'
import { findSession } from './tether'
import { cleanupOldUploads, type UploadCleanupStats } from './uploads'

export interface ReconcileStats {
  links: number
  links_dropped: number
  panes_pruned: number
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Drop links to sessions Tether no longer has, then tabs left empty for
 * `emptyPaneDays`. Throws when Tether is unreachable: an outage never counts
 * as "every session ended".
 */
export async function reconcileLinks(
  tether: TetherClient,
  store: WebStore,
  emptyPaneDays: number,
  now = Date.now(),
): Promise<ReconcileStats> {
  // Links from before the list read: one made meanwhile may be for a session it missed.
  const links = store.listLinks()
  const alive = new Set((await tether.listSessions()).map((session) => session.id))
  const stats: ReconcileStats = { links: 0, links_dropped: 0, panes_pruned: 0 }
  for (const link of links) {
    stats.links += 1
    if (alive.has(link.session_id)) continue
    if (store.unlink(link.session_id)) {
      stats.links_dropped += 1
      console.log(`[aico-web] view link dropped session=${link.session_id}`)
    }
  }
  stats.panes_pruned = store.deleteEmptyPanes(new Date(now - emptyPaneDays * DAY_MS))
  return stats
}

export interface BackgroundDeps {
  tether: TetherClient
  store: WebStore
  shows: Shows
  /** Absent: asks push nothing (tests, older wiring). */
  asks?: Asks
  /** Agent shares and asks are taken only from the owner's tether@default. */
  trustShows: boolean
  uploads: UploadConfig
  maintenance: MaintenanceConfig
  /** The open terminals, which follow the same stream. */
  forward?(event: TetherEvent): void
}

export interface MaintenanceResult {
  reason: string
  skipped: boolean
  reconciliation?: ReconcileStats | { skipped: string }
  upload_cleanup?: UploadCleanupStats
  project_count?: number
  orphaned_project_settings_deleted?: number
  project_settings_cleanup_skipped?: boolean
}

function tetherDown(error: unknown): boolean {
  return error instanceof TetherUnavailable || error instanceof TetherError
}

export class Background {
  private stopEvents: (() => void) | null = null
  private timer: NodeJS.Timeout | null = null
  private running: Promise<MaintenanceResult> | null = null

  constructor(private readonly deps: BackgroundDeps) {}

  start(): void {
    this.stopEvents ??= followEvents(this.deps.tether, {
      onResync: () => void this.reconcile('resync'),
      onEvent: (event) => {
        this.deps.forward?.(event)
        void this.event(event).catch((error) =>
          console.warn(`[aico-web] event ${event.type} failed:`, error),
        )
      },
    })
    void this.runMaintenance('startup')
    if (this.deps.maintenance.enabled && !this.timer) {
      this.timer = setInterval(
        () => void this.runMaintenance('interval'),
        this.deps.maintenance.intervalMs,
      )
      this.timer.unref()
    }
  }

  stop(): void {
    this.stopEvents?.()
    this.stopEvents = null
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Apply one event (public for tests). */
  async event(event: TetherEvent): Promise<void> {
    const { store } = this.deps
    const data = event.data && typeof event.data === 'object' ? event.data : {}
    const id = typeof data.id === 'string' ? data.id : null
    if (event.type === 'show.requested') {
      if (this.deps.trustShows) await this.deps.shows.receive(data)
    } else if (event.type === 'asks.changed') {
      if (this.deps.trustShows) await this.deps.asks?.receive(data)
    } else if (event.type === 'session.ended') {
      if (id && store.unlink(id))
        console.log(`[aico-web] view link dropped session=${id} reason=session.ended`)
    } else if (event.type === 'session.created' || event.type === 'session.updated') {
      if (id) await this.applySession(id, data.session, event.type)
    } else if (event.type === 'gap') {
      await this.reconcile('gap')
    }
  }

  /** Keep a linked tab's mode on the session's tool; read the session when the event has no snapshot. */
  private async applySession(id: string, snapshot: unknown, reason: string): Promise<void> {
    const { store, tether } = this.deps
    const link = store.getLink(id)
    if (!link) return
    let session = snapshot as SessionDescriptor | null
    if (!session || typeof session !== 'object' || session.id !== id) {
      try {
        session = await findSession(tether, id)
      } catch (error) {
        if (error instanceof TetherError && error.status === 410) session = null
        else if (tetherDown(error)) return
        else throw error
      }
      if (!session) {
        store.unlink(id)
        console.log(`[aico-web] view link dropped session=${id} reason=not_found`)
        return
      }
    }
    if ((session.status as string) === 'ended') {
      store.unlink(id)
      console.log(`[aico-web] view link dropped session=${id} reason=${reason}`)
      return
    }
    if (typeof session.tool === 'string' && session.tool && session.tool !== link.mode) {
      store.updateLink(id, { mode: session.tool })
      console.log(`[aico-web] view link mode updated session=${id} mode=${session.tool}`)
    }
  }

  async reconcile(reason: string): Promise<ReconcileStats | null> {
    const { tether, store, maintenance } = this.deps
    try {
      const stats = await reconcileLinks(tether, store, maintenance.emptyPaneDays)
      if (stats.links_dropped || stats.panes_pruned)
        console.log(
          `[aico-web] reconciled reason=${reason} links=${stats.links} dropped=${stats.links_dropped} panes_pruned=${stats.panes_pruned}`,
        )
      return stats
    } catch (error) {
      if (!tetherDown(error)) console.warn(`[aico-web] reconcile failed reason=${reason}:`, error)
      return null
    }
  }

  /** One maintenance pass; a pass already running is not doubled. */
  runMaintenance(reason: string): Promise<MaintenanceResult> {
    if (this.running) return Promise.resolve({ reason, skipped: true })
    this.running = this.maintain(reason).finally(() => {
      this.running = null
    })
    return this.running
  }

  private async maintain(reason: string): Promise<MaintenanceResult> {
    const { tether, store } = this.deps
    const result: MaintenanceResult = { reason, skipped: false }
    result.reconciliation = (await this.reconcile(reason)) ?? { skipped: 'tether_unavailable' }
    try {
      result.upload_cleanup = await cleanupOldUploads(this.deps.uploads)
    } catch (error) {
      console.warn('[aico-web] upload cleanup failed:', error)
    }
    try {
      const ids = new Set(
        (await tether.projects()).map((project) => project.id).filter((id) => !!id),
      )
      result.project_count = ids.size
      if (ids.size) result.orphaned_project_settings_deleted = store.pruneProjectSettings(ids)
      else {
        result.orphaned_project_settings_deleted = 0
        result.project_settings_cleanup_skipped = true
      }
    } catch (error) {
      if (!tetherDown(error)) console.warn('[aico-web] project settings pruning failed:', error)
      result.project_settings_cleanup_skipped = true
    }
    const cleanup = result.upload_cleanup
    console.log(
      `[aico-web] maintenance reason=${reason} uploads_deleted=${cleanup?.deleted_files ?? 0} settings_pruned=${result.orphaned_project_settings_deleted ?? 0}`,
    )
    return result
  }
}
