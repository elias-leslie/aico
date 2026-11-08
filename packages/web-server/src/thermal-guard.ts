// Native enforcement does not depend on this delivery path. The policy names one Aico machine
// as delivery authority, so two doors ingesting the same row never both wake agents or notify
// the owner. All live deliverable agents are selected conservatively: a remote agent can work
// on this host over SSH, and its Tether host alias is not a physical-host identity.
import { createHash } from 'node:crypto'
import type { Notifier } from '@aico/notify'
import type { StatusRow, StatusStore, ThermalGuard } from '@aico/status'
import type { SessionDescriptor, TetherClient } from '@aico/tether-client'
import type { WebStore } from './db'

type Phase = ThermalGuard['phase']
interface Receipts {
  owner?: Phase
  sessions: Record<string, Phase>
}
interface Latest {
  at: string
  episode: string
  phase: Phase
}

export interface ThermalGuardDeps {
  machine: string
  status: Pick<StatusStore, 'rows'>
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
    const rows = this.deps.status
      .rows()
      .map(({ row }) => row)
      .filter((row): row is StatusRow & { guard: ThermalGuard } =>
        Boolean(row.guard && row.guard.delivery_machine === this.deps.machine && row.last_run),
      )
    if (!rows.length) return
    let sessions: SessionDescriptor[] = []
    try {
      sessions = await this.recipients()
    } catch (error) {
      this.failed('session list', error)
    }
    for (const row of rows) {
      try {
        await this.deliver(row, sessions)
      } catch (error) {
        this.failed(row.machine, error)
      }
    }
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
    meta.setMeta(
      latestKey,
      JSON.stringify({ at, episode: guard.episode_id, phase: guard.phase } satisfies Latest),
    )
    const key = `thermal.receipts:${thermalSource(machine, guard.episode_id)}`
    const stored = meta.meta(key)
    const receipts: Receipts = stored ? (JSON.parse(stored) as Receipts) : { sessions: {} }
    const save = () => meta.setMeta(key, JSON.stringify(receipts))
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
      if (receipts.sessions[session.id] === guard.phase) continue
      // A fresh agent after recovery needs no stale event; agents warned earlier get the
      // replacement on the same source, clearing any still-queued hot instruction.
      if (guard.phase === 'recovered' && !receipts.sessions[session.id]) continue
      try {
        await this.deps.tether.request(
          'POST',
          `/v1/sessions/${encodeURIComponent(session.id)}/deliveries`,
          {
            source: thermalSource(machine, guard.episode_id),
            line,
            ride: false,
          },
        )
        receipts.sessions[session.id] = guard.phase
        save()
      } catch (error) {
        this.failed(`session ${session.id}`, error)
      }
    }
  }
}
