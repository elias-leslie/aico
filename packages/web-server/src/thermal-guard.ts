// Native enforcement does not depend on this delivery path. The policy names one Aico machine
// as delivery authority, so two doors ingesting the same row never both wake agents or notify
// the owner. All live deliverable agents are selected conservatively: a remote agent can work
// on this host over SSH, and its Tether host alias is not a physical-host identity.
import { createHash } from 'node:crypto'
import type { Notifier } from '@aico/notify'
import type { ShownRow, StatusRow, StatusStore, ThermalGuard } from '@aico/status'
import { type SessionDescriptor, type TetherClient, TetherError } from '@aico/tether-client'
import type { WebStore } from './db'

type Phase = ThermalGuard['phase']
interface Receipts {
  owner?: Phase | 'off'
  sessions: Record<string, Phase>
  /** Written before POST: a lost response does not prove that Tether failed to queue the line. */
  attempted?: Record<string, Phase>
  /** A deliberate stop ends the warning; a fresh native observation can resume it. */
  off_at?: string
}
type Withdrawals = Record<string, string[]>
interface Latest {
  at: string
  episode: string
  phase: Phase
}

export interface ThermalGuardDeps {
  machine: string
  status: Pick<StatusStore, 'read'>
  store: Pick<WebStore, 'syncHandle'>
  tether: Pick<TetherClient, 'listSessions' | 'tools'> & {
    request(method: string, path: string, body?: unknown): Promise<unknown>
  }
  notices: Pick<Notifier, 'receive' | 'resolve'>
  publicHost?: string | null
  log?: (line: string) => void
}

/** Stable across phase changes, short enough for Tether's source contract. */
export function thermalSource(machine: string, episode: string): string {
  return `thermal:${createHash('sha256')
    .update(JSON.stringify([machine, episode]))
    .digest('hex')}`
}

export const thermalNoticeKey = (machine: string) => `status:thermal:${machine}`

/** The owner sees the condition and the protection already in place, without an action request. */
function thermalSummary(row: StatusRow & { guard: ThermalGuard }): string {
  const { guard, machine } = row
  const temperature = guard.temperature_c === null ? '' : ` (${guard.temperature_c}°C)`
  if (guard.phase === 'recovered')
    return `${machine}'s backup guard recovered${temperature}. Backup CPU limit is ${guard.cpu_quota_percent}%. ${guard.admission_open ? 'Backup work may resume.' : 'Backup admission remains closed.'}`
  const condition =
    guard.phase === 'unavailable'
      ? `${machine}'s temperature reading is unavailable.`
      : `${machine} is ${guard.phase === 'critical' ? 'critically hot' : 'hot'}${temperature}.`
  return `${condition} Backup CPU limit is ${guard.cpu_quota_percent}%. ${guard.admission_open ? 'New backups may start.' : 'New backups are paused.'}`
}

/** Receipts are local metadata in the existing web.db, never policy or another database. */
export class ThermalGuardDelivery {
  private running: Promise<void> | null = null
  private again = false

  constructor(private readonly deps: ThermalGuardDeps) {}

  rowsWritten(rows: readonly StatusRow[]): void {
    if (rows.some((row) => row.guard))
      void this.tick().catch((error: unknown) => this.failed('pass', error))
  }

  /** Startup replay, new sessions and observed failures all use the same persisted receipts. */
  tick(): Promise<void> {
    this.again = true
    if (!this.running) {
      this.running = this.drain().finally(() => {
        this.running = null
      })
    }
    return this.running
  }

  private async drain(): Promise<void> {
    do {
      this.again = false
      await this.pass()
    } while (this.again)
  }

  private failed(where: string, error: unknown): void {
    const log = this.deps.log ?? console.warn
    log(
      `[aico-web] thermal delivery ${where} failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  private async recipients(): Promise<SessionDescriptor[]> {
    const sessions = (await this.deps.tether.listSessions()).filter(
      (session) => session.status === 'running' && session.available && !session.peer,
    )
    const hosts = [...new Set(sessions.map((session) => session.host ?? ''))]
    const tools = await Promise.allSettled(
      hosts.map((host) => this.deps.tether.tools(host || undefined)),
    )
    const capable = new Map<string, Set<string>>()
    tools.forEach((result, index) => {
      const host = hosts[index] as string
      if (result.status === 'fulfilled')
        capable.set(
          host,
          new Set(result.value.items.filter((tool) => tool.deliveries).map((tool) => tool.slug)),
        )
      else this.failed(`tools on ${host || 'this machine'}`, result.reason)
    })
    // Standalone sessions and coordinators use one path; lineage cannot add a duplicate.
    return [
      ...new Map(
        sessions
          .filter((session) => capable.get(session.host ?? '')?.has(session.tool))
          .map((session) => [session.id, session]),
      ).values(),
    ]
  }

  private async pass(): Promise<void> {
    // Cleanup is durable work in its own right, even after the row changes, the host returns,
    // or the previous episode no longer appears in Status.
    await this.retryWithdrawals()
    const rows = this.deps.status
      .read()
      .rows.filter((row): row is ShownRow & { guard: ThermalGuard } =>
        Boolean(row.guard && row.guard.delivery_machine === this.deps.machine && row.last_run),
      )
    if (!rows.length) return
    let sessions: SessionDescriptor[] = []
    try {
      if (rows.some((row) => row.shown !== 'off')) sessions = await this.recipients()
    } catch (error) {
      this.failed('session list', error)
    }
    for (const row of rows) {
      try {
        if (row.shown === 'off') await this.machineOff(row)
        else await this.deliver(row, sessions)
      } catch (error) {
        this.failed(row.machine, error)
      }
    }
  }

  private receiptKey(source: string): string {
    return `thermal.receipts:${source}`
  }

  private withdrawalKey(): string {
    return `thermal.withdrawals:${this.deps.machine}`
  }

  /** Persist cleanup before retiring recipients, in the same local transaction. */
  private retire(source: string, receipts?: Receipts, only?: readonly string[]): boolean {
    const meta = this.deps.store.syncHandle()
    const key = this.receiptKey(source)
    const stored = meta.meta(key)
    const prior: Receipts =
      receipts ?? (stored ? (JSON.parse(stored) as Receipts) : { sessions: {} })
    const known = [
      ...new Set([...Object.keys(prior.sessions), ...Object.keys(prior.attempted ?? {})]),
    ]
    const ids = only ? known.filter((id) => only.includes(id)) : known
    if (!ids.length) return false
    meta.transaction(() => {
      const pending = meta.meta(this.withdrawalKey())
      const withdrawals: Withdrawals = pending ? (JSON.parse(pending) as Withdrawals) : {}
      withdrawals[source] = [...new Set([...(withdrawals[source] ?? []), ...ids])]
      meta.setMeta(this.withdrawalKey(), JSON.stringify(withdrawals))
      for (const id of ids) {
        delete prior.sessions[id]
        if (prior.attempted) delete prior.attempted[id]
      }
      meta.setMeta(key, JSON.stringify(prior))
    })
    return true
  }

  private withdrawalDone(source: string, id: string): void {
    const meta = this.deps.store.syncHandle()
    const stored = meta.meta(this.withdrawalKey())
    if (!stored) return
    const pending = JSON.parse(stored) as Withdrawals
    if (!pending[source]?.includes(id)) return
    pending[source] = pending[source].filter((session) => session !== id)
    if (!pending[source].length) delete pending[source]
    meta.setMeta(this.withdrawalKey(), JSON.stringify(pending))
  }

  private async retryWithdrawals(): Promise<void> {
    const stored = this.deps.store.syncHandle().meta(this.withdrawalKey())
    if (!stored) return
    const pending = JSON.parse(stored) as Withdrawals
    for (const [source, ids] of Object.entries(pending)) {
      for (const id of ids) {
        try {
          await this.deps.tether.request(
            'DELETE',
            `/v1/sessions/${encodeURIComponent(id)}/deliveries?source=${encodeURIComponent(source)}`,
          )
          this.withdrawalDone(source, id)
        } catch (error) {
          if (error instanceof TetherError && error.status === 404) this.withdrawalDone(source, id)
          else this.failed(`withdraw session ${id}`, error)
        }
      }
    }
  }

  /** End only our warning and withdraw queued heat lines; being off is not a temperature reading. */
  private async machineOff(row: StatusRow & { guard: ThermalGuard }): Promise<void> {
    const meta = this.deps.store.syncHandle()
    const source = thermalSource(row.machine, row.guard.episode_id)
    const key = this.receiptKey(source)
    const stored = meta.meta(key)
    const receipts: Receipts = stored ? (JSON.parse(stored) as Receipts) : { sessions: {} }
    const save = () => meta.setMeta(key, JSON.stringify(receipts))
    receipts.off_at = row.last_run as string
    save()
    let retired = this.retire(source, receipts)
    const previous = meta.meta(`thermal.latest:${row.machine}`)
    const latest = previous ? (JSON.parse(previous) as Latest) : null
    if (latest && latest.episode !== row.guard.episode_id)
      retired = this.retire(thermalSource(row.machine, latest.episode)) || retired
    if (receipts.owner !== 'off') {
      try {
        await this.deps.notices.resolve(
          'aico',
          thermalNoticeKey(row.machine),
          `${row.machine} is off, so its heat warning has ended.`,
        )
        receipts.owner = 'off'
        save()
      } catch (error) {
        this.failed(`end owner notice for ${row.machine}`, error)
      }
    }
    if (retired) await this.retryWithdrawals()
  }

  private async deliver(
    row: StatusRow & { guard: ThermalGuard },
    sessions: SessionDescriptor[],
  ): Promise<void> {
    const { guard, machine } = row
    const meta = this.deps.store.syncHandle()
    const latestKey = `thermal.latest:${machine}`
    const previous = meta.meta(latestKey)
    const latest = previous ? (JSON.parse(previous) as Latest) : null
    const at = row.last_run as string
    if (latest && Date.parse(at) < Date.parse(latest.at)) return
    // A recovery already accepted cannot be undone by a differently stamped repeat from the
    // same episode. A new episode has its own id and receipts.
    if (
      latest?.episode === guard.episode_id &&
      latest.phase === 'recovered' &&
      guard.phase !== 'recovered'
    )
      return
    const retired =
      latest && latest.episode !== guard.episode_id
        ? this.retire(thermalSource(machine, latest.episode))
        : false
    meta.setMeta(
      latestKey,
      JSON.stringify({ at, episode: guard.episode_id, phase: guard.phase } satisfies Latest),
    )
    if (retired) await this.retryWithdrawals()
    const source = thermalSource(machine, guard.episode_id)
    const key = this.receiptKey(source)
    const stored = meta.meta(key)
    const receipts: Receipts = stored ? (JSON.parse(stored) as Receipts) : { sessions: {} }
    const save = () => meta.setMeta(key, JSON.stringify(receipts))
    if (receipts.off_at) {
      if (Date.parse(at) <= Date.parse(receipts.off_at)) return
      delete receipts.off_at
      if (receipts.owner === 'off') delete receipts.owner
    }
    if (guard.phase === 'recovered') {
      // A disconnected recipient still may have our hot line queued. It cannot receive a new
      // agent message now, but its old source must be withdrawn before it reconnects.
      const live = new Set(sessions.map((session) => session.id))
      const absent = [
        ...Object.keys(receipts.sessions),
        ...Object.keys(receipts.attempted ?? {}),
      ].filter((id) => !live.has(id) && receipts.sessions[id] !== 'recovered')
      if (this.retire(source, receipts, absent)) await this.retryWithdrawals()
    }
    const summary = thermalSummary(row)
    const line =
      guard.phase === 'recovered'
        ? summary
        : `${summary} Reduce heavy work on this host and leave the native guard in place.`
    if (receipts.owner !== guard.phase) {
      try {
        if (guard.phase === 'recovered')
          await this.deps.notices.resolve('aico', thermalNoticeKey(machine), summary)
        else
          this.deps.notices.receive(
            {
              v: 1,
              source: 'aico',
              key: thermalNoticeKey(machine),
              kind: 'alert',
              severity: 'warning',
              title:
                guard.phase === 'unavailable'
                  ? `${machine} temperature unavailable`
                  : `${machine} is ${guard.phase === 'critical' ? 'critically hot' : 'hot'}`,
              body: summary,
              machine,
              project: 'aico',
              push: 'tray',
              cooldown: 0,
              ...(this.deps.publicHost ? { open: `https://${this.deps.publicHost}/status` } : {}),
            },
            'local',
          )
        receipts.owner = guard.phase
        save()
      } catch (error) {
        this.failed(`owner notice for ${machine}`, error)
      }
    }
    for (const session of sessions) {
      if (receipts.sessions[session.id] === guard.phase && !receipts.attempted?.[session.id])
        continue
      // A fresh agent after recovery needs no stale event; agents warned earlier get the
      // replacement on the same source, clearing any still-queued hot instruction.
      if (
        guard.phase === 'recovered' &&
        !receipts.sessions[session.id] &&
        !receipts.attempted?.[session.id]
      )
        continue
      receipts.attempted ??= {}
      receipts.attempted[session.id] = guard.phase
      save()
      try {
        await this.deps.tether.request(
          'POST',
          `/v1/sessions/${encodeURIComponent(session.id)}/deliveries`,
          {
            source,
            line,
            ride: false,
          },
        )
        // A confirmed current-phase replacement also satisfies an older pending withdraw on
        // this same source. Commit both together: a restart must not discard the fresh line
        // while deduplicating its replacement. Keep the in-memory receipt unchanged on rollback.
        const attempted = { ...receipts.attempted }
        delete attempted[session.id]
        const accepted: Receipts = {
          ...receipts,
          sessions: { ...receipts.sessions, [session.id]: guard.phase },
          attempted,
        }
        meta.transaction(() => {
          meta.setMeta(key, JSON.stringify(accepted))
          this.withdrawalDone(source, session.id)
        })
        Object.assign(receipts, accepted)
      } catch (error) {
        this.failed(`session ${session.id}`, error)
      }
    }
  }
}
