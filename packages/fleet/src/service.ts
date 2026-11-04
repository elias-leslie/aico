// A broken fleet link must leave the local session service available.
import { hostname } from 'node:os'
import type { StatusRow } from '@aico/status'
import { Fleet } from './fleet'
import { machineName } from './identity'
import { type FleetSettings, readSettings } from './settings'

export class FleetService {
  private fleet: Fleet | null = null
  private settings: FleetSettings | null = null
  private retry: NodeJS.Timeout | null = null
  private working: Promise<void> | null = null
  private stopped = false
  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly controlSocket: string,
    private readonly log = (text: string) => console.error(`[fleet] ${text}`),
  ) {}

  start(): Promise<void> {
    this.working = this.attempt().finally(() => {
      this.working = null
    })
    return this.working
  }
  private async attempt(): Promise<void> {
    try {
      this.settings = readSettings(this.env, this.controlSocket)
      if (!this.settings || this.stopped) return
      this.fleet = new Fleet({ settings: this.settings, failed: (error) => this.fault(error) })
      await this.fleet.start()
    } catch (error) {
      await this.failed(error)
    }
  }
  /** Hub reloads use the same failure report and retry as fleet startup. */
  fault(error: unknown): void {
    if (this.stopped || this.working) return
    this.working = this.failed(error).finally(() => {
      this.working = null
    })
  }
  private async failed(error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error)
    this.log(`Link failed: ${message}`)
    try {
      await this.fleet?.close()
    } catch (error) {
      this.log(`Link cleanup failed: ${String(error)}`)
    }
    this.fleet = null
    if (this.stopped) return
    const settings = this.settings
    const machine = settings?.machine ?? machineName(hostname())
    const rows: StatusRow[] = settings?.peers.length
      ? settings.peers.map((peer) => ({
          id: `fleet/${machine}/${peer.name}`,
          what: `Link to ${peer.name}`,
          kind: 'machine',
          machine: peer.name,
          state: 'failed',
          meaning: `Link failed: ${message}`.slice(0, 300),
          next_run: new Date(Date.now() + settings.deadMs).toISOString(),
          actions: [{ kind: 'detail', ref: 'tether hosts' }],
        }))
      : [
          {
            id: `fleet/${machine}`,
            what: 'Fleet link',
            kind: 'service',
            machine,
            state: 'failed',
            meaning: `Link failed: ${message}`.slice(0, 300),
            actions: [{ kind: 'detail', ref: 'tether hosts' }],
          },
        ]
    try {
      const url = new URL(
        settings?.statusUrl ??
          `${this.env.AICO_WEB_URL || 'http://127.0.0.1:3002'}/api/status/rows`,
      )
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1')
        throw new Error('Fleet Status writer must use loopback HTTP')
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(rows),
        signal: AbortSignal.timeout(settings?.deadMs ?? 300000),
      })
      if (!response.ok) throw new Error(`Status answered ${response.status}`)
    } catch (error) {
      this.log(`Could not write link Status: ${String(error)}`)
    }
    if (this.stopped) return
    if (this.retry) clearTimeout(this.retry)
    this.retry = setTimeout(() => {
      this.retry = null
      void this.start()
    }, settings?.retryMinMs ?? 5000)
    this.retry.unref()
  }
  async close(): Promise<void> {
    this.stopped = true
    if (this.retry) clearTimeout(this.retry)
    await this.working
    await this.fleet?.close()
  }
}
