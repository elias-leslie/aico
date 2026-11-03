// The capture router. After a capture is read (`ready`), the type table says
// who takes it. Receipts wait for one tap, then go to portfolio-ai and Aico's
// copy is purged. Owners Aico has no adapter for yet (notes, vehicles) leave
// the capture `ready` with a suggestion that says so. Every change goes
// through NotesStore, so it syncs like any other edit.
//
// Retrying a `waiting` hand-off needs no timer of its own: `tick()` runs on
// the server's maintenance pass (startup and its interval), and "Send now"
// is the same action as the first tap.

import { readBlob, removeBlobs } from '@aico/notes/blobs'
import { needsPreview } from '@aico/notes/capture-files'
import type { CaptureTypeRow, CaptureTypeTable } from '@aico/notes/capture-types'
import type { CaptureRow, NotesStore, RoutePlan, RouteState } from './notes-db'
import { type Notice, type RunNotice, resolveNotice, runCommand, sendNotice } from './notice'
import type { GroupMember, HandOff, OwnerAdapter } from './owners/types'
import { HttpError } from './tether'

export type RouteAction = 'send' | 'keep' | 'not_this'
export const ROUTE_ACTIONS: readonly string[] = ['send', 'keep', 'not_this']

/** The route as the page and `tether capture` see it. */
export interface RouteJson {
  state: RouteState
  owner: string | null
  ownerLabel: string | null
  ownerRef: string | null
  /** Why it waits or failed, or what is not built yet. */
  note: string | null
  /** The suggestion, as a question (while it waits for a tap). */
  question: string | null
  /** The button for "this is not that". */
  notLabel: string | null
  /** The owner is set up, so Send works. */
  canSend: boolean
  /** The owner's page, once filed (when configured). */
  url: string | null
}

export interface RouterDeps {
  store: NotesStore
  blobsDir: string
  table: CaptureTypeTable
  /** Owner id to adapter; an owner without one is "not built yet". */
  adapters: Map<string, OwnerAdapter>
  /** Owner id to the owner's own page for a filed capture. */
  ownerUrls?: Record<string, string | null>
  /** Aico's public host, for the notice's link; without it the notice has none. */
  publicHost?: string | null
  run?: RunNotice
  log?: (message: string) => void
}

const REROUTABLE: readonly (RouteState | null)[] = ['suggested', 'waiting', 'failed']
const ROUTABLE: readonly RouteState[] = ['suggested', 'confirmed', 'waiting', 'failed']

export const routeKey = (id: string) => `capture:${id}`

export class CaptureRouter {
  private readonly inFlight = new Set<string>()
  private readonly log: (message: string) => void

  constructor(private readonly deps: RouterDeps) {
    this.log = deps.log ?? ((message) => console.error(`[aico-web] ${message}`))
  }

  private get run(): RunNotice {
    return this.deps.run ?? runCommand
  }

  /** What to do with a capture of this type, or null: nobody takes it. */
  plan(type: string | null): RoutePlan | null {
    const entry = this.deps.table.type(type)
    if (!entry?.owner) return null
    const live = this.deps.adapters.has(entry.owner)
    return {
      owner: entry.owner,
      state: 'suggested',
      note: live ? null : (this.deps.table.owner(entry.owner).later ?? 'Not available yet.'),
    }
  }

  describe(row: CaptureRow): RouteJson | null {
    if (!row.route_state) return null
    const { table, adapters } = this.deps
    const entry = table.type(row.type)
    const owner = row.owner
    const ownerLabel = owner ? table.owner(owner).label : null
    const live = owner !== null && adapters.has(owner)
    return {
      state: row.route_state,
      owner,
      ownerLabel,
      ownerRef: row.owner_ref,
      note: row.route_note,
      question:
        row.route_state === 'suggested'
          ? (entry?.question ?? `Send to ${ownerLabel ?? 'the owner'}?`)
          : null,
      notLabel: entry?.not_label ?? 'Not this',
      canSend: live && REROUTABLE.includes(row.route_state),
      url: row.route_state === 'filed' && owner ? (this.deps.ownerUrls?.[owner] ?? null) : null,
    }
  }

  /** Called once a capture is `ready` with a plan: files it itself, or asks for the tap. */
  async afterReady(row: CaptureRow): Promise<void> {
    if (row.route_state !== 'suggested' || !row.owner || !this.deps.adapters.has(row.owner)) return
    if (!this.needsTap(row)) {
      if (this.deps.store.transitionRoute(row.id, ['suggested'], { route_state: 'confirmed' }))
        await this.deliver(row.id)
      return
    }
    await sendNotice(this.run, this.notice(row, this.deps.table.type(row.type)))
  }

  /** A suggestion for an owner that is set up and wants a tap raises a tray todo; the rest don't. */
  private needsTap(row: CaptureRow): boolean {
    const entry = this.deps.table.type(row.type)
    return !!row.owner && this.deps.adapters.has(row.owner) && !(entry?.auto && !entry.confirm)
  }

  private notice(row: CaptureRow, entry: CaptureTypeRow | null): Notice {
    const kind = (entry?.label ?? 'capture').toLowerCase()
    const owner = this.deps.table.owner(row.owner as string).label
    const notice: Notice = {
      v: 1,
      source: 'aico',
      kind: 'todo',
      severity: 'info',
      title: `A ${kind} is waiting for your tap`,
      body: `Aico read a capture as a ${kind}. Open it to send it to ${owner}, or keep it in Aico.`,
      key: routeKey(row.id),
      push: 'tray',
    }
    if (this.deps.publicHost) {
      notice.open = `https://${this.deps.publicHost}/captures?id=${row.id}`
      notice.actions = ['open']
      notice.primary = 'open'
    }
    return notice
  }

  /** The tray todo for this capture is over (sent, kept, deleted). */
  async clearNotice(row: CaptureRow, text: string): Promise<void> {
    if (row.route_state !== 'suggested' || !this.needsTap(row)) return
    await resolveNotice(this.run, routeKey(row.id), text)
  }

  /** The owner's tap: send it, keep it here, or say it is not that kind of thing. */
  async act(id: string, action: RouteAction): Promise<CaptureRow> {
    const { store, adapters } = this.deps
    const row = store.getCapture(id)
    if (!row) throw new HttpError(404, 'That capture is gone')
    if (action === 'send') {
      if (!row.owner || !adapters.has(row.owner))
        throw new HttpError(409, "That owner isn't set up yet, so there's nothing to send")
      if (row.route_state === 'confirmed') return row // already on its way
      const moved = store.transitionRoute(id, REROUTABLE, {
        route_state: 'confirmed',
        route_note: null,
      })
      if (!moved) throw new HttpError(409, 'There is nothing to send')
      await this.clearNotice(row, 'Sent from Aico.')
      return (await this.deliver(id)) ?? moved
    }
    const retype = action === 'not_this'
    const entry = this.deps.table.type(row.type)
    const moved = this.deps.store.transitionRoute(id, REROUTABLE, {
      route_state: 'kept',
      route_note: null,
      ...(retype ? { type: entry?.dismiss_type ?? 'other' } : {}),
    })
    if (!moved) throw new HttpError(409, 'There is nothing to decide')
    await this.clearNotice(row, 'Kept in Aico.')
    return moved
  }

  /** Sends a `confirmed` or `waiting` capture to its owner and records what happened. */
  async deliver(id: string): Promise<CaptureRow | null> {
    const { store } = this.deps
    if (this.inFlight.has(id)) return store.getCapture(id)
    this.inFlight.add(id)
    try {
      const row = store.getCapture(id)
      if (!row || (row.route_state !== 'confirmed' && row.route_state !== 'waiting')) return row
      const adapter = row.owner ? this.deps.adapters.get(row.owner) : undefined
      if (!adapter) return row
      const entry = this.deps.table.type(row.type)
      let result: Awaited<ReturnType<OwnerAdapter['send']>>
      try {
        const job = await this.job(row, entry, adapter)
        if ('failed' in job) result = { state: 'failed', reason: job.failed }
        else if ('wait' in job) result = { state: 'waiting', note: job.wait }
        else {
          result = await adapter.send(job)
          if (result.state === 'filed') await this.fileGroupMates(row, job, result.ref)
        }
      } catch (error) {
        this.log(`capture ${id}: hand-off crashed: ${(error as Error).stack ?? error}`)
        result = { state: 'failed', reason: 'Something went wrong while sending it' }
      }
      if (result.state === 'filed') {
        const purge = !(entry?.keep_copy ?? true)
        const filed = store.fileCapture(id, result.ref, purge)
        if (filed && purge && row.hash) await this.purge(row.hash)
        this.log(`capture ${id} filed with ${row.owner} as ${result.ref}`)
        return filed ?? store.getCapture(id)
      }
      const note = result.state === 'waiting' ? result.note : result.reason
      if (row.route_state === 'waiting' && result.state === 'waiting' && row.route_note === note)
        return row // still waiting, nothing new to record
      return (
        store.transitionRoute(id, ['confirmed', 'waiting'], {
          route_state: result.state,
          route_note: note,
        }) ?? store.getCapture(id)
      )
    } finally {
      this.inFlight.delete(id)
    }
  }

  private async job(
    row: CaptureRow,
    entry: CaptureTypeRow | null,
    adapter: OwnerAdapter,
  ): Promise<HandOff | { failed: string } | { wait: string }> {
    const group = adapter.grouped ? await this.groupOf(row) : null
    if (group && 'wait' in group) return group
    if (!row.hash && !group) return { failed: 'The file is no longer on this computer' }
    const preview = needsPreview(row.mime)
    const bytes =
      adapter.local || !row.hash
        ? new Uint8Array(0)
        : await readBlob(this.deps.blobsDir, row.hash, preview ? 'preview' : 'original')
    if (!bytes && !group)
      return { failed: 'The picture is not ready to send yet. Try again in a moment' }
    return {
      capture: row,
      captureId: row.id,
      bytes: bytes ?? new Uint8Array(0),
      mime: preview ? 'image/jpeg' : row.mime,
      kind: entry?.owner_kind ?? entry?.id ?? 'capture',
      storeName: storeOf(row),
      note: row.caption,
      group: group ?? [],
    }
  }

  /**
   * The upload batch a grouped owner takes as one event. Waits while another
   * file of the batch is still being read; leaves out files the owner already
   * said no to. Members routed to the same owner go with the event.
   */
  private async groupOf(row: CaptureRow): Promise<GroupMember[] | { wait: string }> {
    const batch = row.group_id ? this.deps.store.capturesInGroup(row.group_id) : [row]
    if (batch.some((m) => m.status === 'new' || m.status === 'extracting'))
      return { wait: 'Still reading the other files in this group' }
    const members: GroupMember[] = []
    for (const m of batch) {
      if (m.id !== row.id && m.route_state === 'kept') continue
      const own =
        m.id === row.id ||
        (m.owner === row.owner && !!m.route_state && ROUTABLE.includes(m.route_state))
      const preview = needsPreview(m.mime)
      const sendable = own && m.hash && (m.kind === 'image' || m.kind === 'pdf')
      members.push({
        capture: m,
        own,
        mime: preview ? 'image/jpeg' : m.mime,
        bytes: sendable
          ? await readBlob(this.deps.blobsDir, m.hash as string, preview ? 'preview' : 'original')
          : null,
      })
    }
    return members
  }

  /** The event covered the whole batch: its other car captures are filed with the same id and purged like this one. */
  private async fileGroupMates(row: CaptureRow, job: HandOff, ref: string): Promise<void> {
    const { store } = this.deps
    for (const { capture, own } of job.group) {
      if (!own || capture.id === row.id) continue
      const entry = this.deps.table.type(capture.type)
      const purge = !(entry?.keep_copy ?? true)
      const moved = store.transitionRoute(capture.id, ROUTABLE, {
        route_state: 'confirmed',
        route_note: null,
      })
      if (!moved) continue
      await this.clearNotice(capture, 'Sent from Aico.')
      store.fileCapture(capture.id, ref, purge)
      if (purge && capture.hash) await this.purge(capture.hash)
      this.log(`capture ${capture.id} filed with ${capture.owner} as ${ref} (with ${row.id})`)
    }
  }

  /** Removes the blob files unless another capture holds the same bytes. */
  private async purge(hash: string): Promise<void> {
    if (this.deps.store.countHashRefs(hash) > 0) return
    try {
      await removeBlobs(this.deps.blobsDir, hash)
    } catch (error) {
      this.log(
        `could not remove the handed-off file ${hash.slice(0, 8)}: ${(error as Error).message}`,
      )
    }
  }

  /** Retries hand-offs that are `waiting` (or were cut short). One look at the owner first. */
  async tick(): Promise<void> {
    const rows = this.deps.store.pendingRoutes()
    const reachable = new Map<string, boolean>()
    for (const row of rows) {
      const adapter = row.owner ? this.deps.adapters.get(row.owner) : undefined
      if (!row.owner || !adapter) continue
      if (!reachable.has(row.owner)) reachable.set(row.owner, await adapter.reachable())
      if (reachable.get(row.owner)) await this.deliver(row.id)
    }
  }
}

function storeOf(row: CaptureRow): string {
  try {
    const store = (
      JSON.parse(row.extract_json ?? 'null') as { receipt?: { store?: unknown } } | null
    )?.receipt?.store
    return typeof store === 'string' ? store : ''
  } catch {
    return ''
  }
}
