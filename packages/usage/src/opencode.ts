// OpenCode Go: its usage endpoint reports the 5-hour, weekly and monthly windows for the
// account behind an API key. The endpoint is not in OpenCode's public docs, so any HTTP or
// parse failure is reported plainly and nothing is invented. The key is a file in Aico's
// secrets folder that the owner puts there; it is never logged, printed or sent anywhere
// but OpenCode.

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import config from '../data/usage.json' with { type: 'json' }
import type { Database } from './db'
import { storeReading } from './readings'

export const OPENCODE_SOURCE = 'opencode_go_usage'
export const OPENCODE_PROVIDER = 'opencode-go'

const FAILURES: Record<number, string> = {
  401: 'OpenCode rejected the key',
  403: 'The key has no OpenCode Go subscription',
}

export interface OpenCodeWindow {
  key: string
  percent: number
  resets_at: string | null
}

/** The three windows, or null when the payload is not the shape OpenCode has been sending. */
export function parseUsage(payload: unknown): OpenCodeWindow[] | null {
  const usage = (payload as { usage?: unknown } | null)?.usage
  if (!usage || typeof usage !== 'object') return null
  const out: OpenCodeWindow[] = []
  for (const key of Object.keys(config.opencode_go.windows)) {
    const raw = (usage as Record<string, unknown>)[key] as
      | { percent?: unknown; status?: unknown; resetsAt?: unknown }
      | undefined
    if (!raw || typeof raw !== 'object') return null
    if (typeof raw.percent !== 'number' || typeof raw.status !== 'string') return null
    let resets: string | null = null
    if (typeof raw.resetsAt === 'string') {
      const at = Date.parse(raw.resetsAt)
      if (Number.isNaN(at)) return null
      resets = new Date(at).toISOString()
    }
    out.push({
      key,
      percent: Math.max(0, Math.min(100, Math.round(raw.percent))),
      resets_at: resets,
    })
  }
  return out
}

/** A stable per-install id OpenCode asks for, made on first use. */
function installId(path: string): string {
  try {
    const existing = readFileSync(path, 'utf8').trim()
    if (/^[0-9a-f-]{36}$/i.test(existing)) return existing
  } catch {
    // none yet
  }
  const id = randomUUID()
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${id}\n`, { mode: 0o600 })
  } catch {
    // the id only has to be stable when it can be kept
  }
  return id
}

export interface OpenCodeOptions {
  keyFile: string
  idFile: string
  fetch: typeof fetch
  now: number
  minIntervalS: number
}

/** 'not-set-up' when there is no key file; the number of readings stored otherwise; throws a plain reason. */
export async function collectOpenCode(
  db: Database,
  options: OpenCodeOptions,
): Promise<'not-set-up' | number> {
  if (!existsSync(options.keyFile) || statSync(options.keyFile).size === 0) return 'not-set-up'
  const key = readFileSync(options.keyFile, 'utf8').trim()
  let response: Response
  try {
    response = await options.fetch(config.opencode_go.url, {
      headers: {
        authorization: `Bearer ${key}`,
        accept: 'application/json',
        'user-agent': 'aico-usage/1',
        'x-opencode-session': installId(options.idFile),
      },
      signal: AbortSignal.timeout(config.opencode_go.timeout_s * 1000),
    })
  } catch {
    throw new Error('Could not reach OpenCode')
  }
  if (response.status !== 200)
    throw new Error(FAILURES[response.status] ?? `OpenCode answered HTTP ${response.status}`)
  let windows: OpenCodeWindow[] | null = null
  try {
    windows = parseUsage(await response.json())
  } catch {
    windows = null
  }
  if (!windows) throw new Error("OpenCode's usage answer changed shape")
  const minutes = config.opencode_go.windows as Record<string, number>
  let stored = 0
  for (const window of windows)
    if (
      storeReading(
        db,
        {
          provider: OPENCODE_PROVIDER,
          window_minutes: minutes[window.key] as number,
          observedAt: options.now,
          used_percent: window.percent,
          resetsAt: window.resets_at ? Date.parse(window.resets_at) : null,
          source: OPENCODE_SOURCE,
          plan_type: null,
        },
        options.minIntervalS,
      )
    )
      stored += 1
  return stored
}
