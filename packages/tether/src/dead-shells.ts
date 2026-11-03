// A shell whose pane process is gone has nothing to resume, so Tether ends it
// itself instead of listing it as ended until someone does. Agents keep crash
// recovery and reboot restore; a shell that reboot restore brings back is left
// alone, and one it cannot bring back is ended once that is known.

import { getWidget, type WidgetRow } from './lifecycle/catalog'
import type { AbandonedScope, EndResult } from './lifecycle/engine'
import { getTui } from './lifecycle/tui/registry'

const END_ATTEMPTS = 10
const END_RETRY_MS = 2_000

export interface DeadShellDeps {
  /** Reboot restore will relaunch this session. */
  awaitingRestore(id: string): boolean
  /** Settles once startup knows what it restores, then once that is done. */
  restorePlanned: Promise<void>
  restoreFinished: Promise<void>
  list(): WidgetRow[]
  status(row: WidgetRow): Promise<string>
  end(id: string, generation: string): Promise<EndResult>
  generationOf(row: WidgetRow): string
  log?(message: string): void
  sleep?(ms: number): Promise<void>
}

/** No pane, none being started, nothing launched: what reconciliation leaves
 * once a session's pane is gone. */
function paneless(row: WidgetRow): boolean {
  return !row.scopeUnit && !row.pendingScopeUnit && row.launchState === 'none'
}

/** A plain shell: a terminal session with no agent command to resume. */
export function isShellSession(row: WidgetRow): boolean {
  return row.backend !== 'agent-hub' && (getTui(row.tool)?.command.length ?? 0) === 0
}

export class DeadShells {
  /** Shells startup found without their pane. */
  private readonly atStartup = new Set<string>()
  private readonly ending = new Set<string>()
  private readonly log: (message: string) => void
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly deps: DeadShellDeps) {
    this.log = deps.log ?? ((message) => console.log(`[tether:lifecycle] ${message}`))
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  /** Engine hook: a session's pane scope is gone. */
  onAbandoned(event: AbandonedScope): void {
    const row = getWidget(event.widgetId)
    if (!row || !isShellSession(row)) return
    if (event.startup) this.atStartup.add(row.id)
    else void this.endIfDead(row.id)
  }

  /** After startup: end the shells reboot restore leaves out at once, and the
   * ones it could not bring back once it is done. */
  async settleStartup(startedAt: number): Promise<void> {
    await this.deps.restorePlanned
    // A shell that lost its pane before this start (its scope already
    // cleared, so reconciliation reports nothing) and was never started again.
    for (const row of this.deps.list())
      if (row.createdAt < startedAt && isShellSession(row) && paneless(row))
        this.atStartup.add(row.id)
    await Promise.all([...this.atStartup].map((id) => this.endIfDead(id)))
    await this.deps.restoreFinished
    await Promise.all([...this.atStartup].map((id) => this.endIfDead(id)))
    this.atStartup.clear()
  }

  /** End the shell unless it runs again or is waiting for reboot restore.
   * The reconciliation that reported it clears the pane first and can hold
   * the session while it does: retry briefly. */
  async endIfDead(id: string): Promise<boolean> {
    if (this.ending.has(id)) return false
    this.ending.add(id)
    try {
      for (let attempt = 0; attempt < END_ATTEMPTS; attempt++) {
        const row = getWidget(id)
        if (!row || !isShellSession(row) || this.deps.awaitingRestore(id)) return false
        const status = await this.deps.status(row).catch(() => 'uncertain')
        if (status === 'running') return false
        const latest = getWidget(id)
        if (!latest) return false
        if (!paneless(latest)) {
          await this.sleep(END_RETRY_MS)
          continue
        }
        const result = await this.deps.end(id, this.deps.generationOf(latest))
        if (result.status === 'ended') {
          this.atStartup.delete(id)
          this.log(
            `ended shell ${id}${row.name ? ` (${row.name})` : ''}: its process stopped and a shell has nothing to resume`,
          )
          return true
        }
        if (result.status === 'absent') return false
        await this.sleep(END_RETRY_MS)
      }
      this.log(`shell ${id} lost its process but could not be ended; it stays listed`)
      return false
    } finally {
      this.ending.delete(id)
    }
  }
}
