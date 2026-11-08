// Outbound canary delivery: canarytokens.org keeps each token's hits, and Aico reads them on a timer.
// Nothing reaches this host from the internet for it (the Access gate stays on every public path).
// A token's first look only records where its history ends; later hits alert once each, through the
// same trip record, repeat rule and phone notice as the LAN webhook.

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Notifier } from '@aico/notify'
import { alertTrip, type CanaryEvents, type CanaryTrip } from './canary'

const DEFAULT_API = 'https://canarytokens.org/d3aece8093b71007b5ccfedad91ebb11'
const DEFAULT_INTERVAL_S = 15 * 60

interface PolledEntry {
  token?: string
  auth?: string
  name?: string
  path?: string
  type?: string
  kind?: string
}

export interface PollHit {
  time_of_hit?: number
  src_ip?: string
}

export type HistoryFetcher = (url: string) => Promise<{ history?: { hits?: PollHit[] } }>

const fetchHistory: HistoryFetcher = async (url) => {
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'aico-canary/1' },
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return (await response.json()) as { history?: { hits?: PollHit[] } }
}

const clean = (v: unknown) =>
  String(v ?? '')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .slice(0, 160)

export class CanaryPoller {
  private timer: NodeJS.Timeout | null = null
  private running: Promise<PollResult> | null = null

  constructor(
    private readonly folder: string,
    private readonly notifier: Pick<Notifier, 'receive'>,
    private readonly events: CanaryEvents,
    private readonly api: string = DEFAULT_API,
    private readonly fetchJson: HistoryFetcher = fetchHistory,
  ) {}

  /** `elsewhere`: the workstation is polling, so the standby leaves it (a hit alerts once). */
  start(intervalS: number = DEFAULT_INTERVAL_S, elsewhere?: () => Promise<boolean>): void {
    if (this.timer) return
    const run = () =>
      void (async () => {
        if (!(await elsewhere?.())) await this.poll()
      })().catch((error) => console.error('[canary] poll failed:', (error as Error).message))
    this.timer = setInterval(run, intervalS * 1000)
    this.timer.unref()
    setTimeout(run, 5000).unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** One pass over every registered canarytokens.org token. */
  poll(): Promise<PollResult> {
    this.running ??= this.pass().finally(() => {
      this.running = null
    })
    return this.running
  }

  private async pass(): Promise<PollResult> {
    const out: PollResult = { checked: 0, baselined: 0, alerts: 0, errors: [] }
    let entries: PolledEntry[]
    try {
      const registry = JSON.parse(readFileSync(join(this.folder, 'registry.json'), 'utf8'))
      entries = Array.isArray(registry) ? registry : (registry?.tokens ?? [])
    } catch {
      out.errors.push('registry unreadable')
      return out
    }
    const seen = this.readSeen()
    for (const entry of entries) {
      if ((entry.kind ?? 'canarytokens') !== 'canarytokens' || !entry.token || !entry.auth) continue
      const label = clean(entry.name) || clean(entry.token).slice(0, 6)
      const query = new URLSearchParams({ token: entry.token, auth: entry.auth })
      let hits: PollHit[]
      try {
        const data = await this.fetchJson(`${this.api}/history?${query}`)
        hits = (data.history?.hits ?? []).filter((h) => Number.isFinite(h.time_of_hit))
      } catch (error) {
        out.errors.push(`${label}: ${(error as Error).message}`)
        continue
      }
      out.checked += 1
      hits.sort((a, b) => (a.time_of_hit as number) - (b.time_of_hit as number))
      const newest = hits.at(-1)?.time_of_hit ?? 0
      const known = seen[entry.token]
      if (known === undefined) {
        seen[entry.token] = newest
        out.baselined += 1
        continue
      }
      for (const hit of hits.filter((h) => (h.time_of_hit as number) > known)) {
        const trip: CanaryTrip = {
          title: `Canary tripped: ${label}`,
          body: `${clean(entry.type)} at ${clean(entry.path)}. Source ${clean(hit.src_ip) || 'unknown'}.`,
          name: label,
          src: clean(hit.src_ip),
          ...(entry.type === 'dns' ? { anySource: true } : {}),
        }
        await alertTrip(this.events, this.notifier, trip, 'canary')
        out.alerts += 1
        seen[entry.token] = hit.time_of_hit as number
        this.writeSeen(seen)
      }
    }
    this.writeSeen(seen)
    return out
  }

  private get file(): string {
    return join(this.folder, 'poll.json')
  }

  private readSeen(): Record<string, number> {
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, number>
    } catch {
      return {}
    }
  }

  private writeSeen(seen: Record<string, number>): void {
    const temp = `${this.file}.tmp`
    writeFileSync(temp, JSON.stringify(seen), { mode: 0o600 })
    renameSync(temp, this.file)
  }
}

export interface PollResult {
  checked: number
  baselined: number
  alerts: number
  errors: string[]
}
