// Claude's windows: the statusline snapshot Claude Code keeps in its state directory
// (rate-limits.json: observed_at and, per window, used_percentage and resets_at, all
// epoch seconds). Only a running Claude Code session refreshes it.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import config from '../data/usage.json' with { type: 'json' }
import type { Database } from './db'
import { storeReading } from './readings'

export const CLAUDE_SOURCE = 'claude_statusline'

const seconds = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value * 1000 : null

export function statuslinePath(env: NodeJS.ProcessEnv, home: string): string {
  const state = env.XDG_STATE_HOME || join(home, '.local', 'state')
  return join(state, config.claude.statusline)
}

/** The snapshot of every native home: this user's (XDG_STATE_HOME aware), then each other home's. */
export function statuslinePaths(env: NodeJS.ProcessEnv, home: string, homes: string[]): string[] {
  return homes.map((other) =>
    other === home
      ? statuslinePath(env, home)
      : join(other, '.local', 'state', config.claude.statusline),
  )
}

/** Reads the snapshot; the number of readings stored (0 when nothing is new or the file is absent). */
export function collectClaude(db: Database, path: string, minIntervalS: number): number {
  if (!existsSync(path)) return 0
  let data: { observed_at?: unknown; rate_limits?: Record<string, Record<string, unknown>> }
  try {
    data = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    // No path in the message: a snapshot may sit in a home whose name is not reported.
    throw new Error("Claude Code's usage snapshot is not readable JSON")
  }
  const observed = seconds(data.observed_at)
  if (observed === null || !data.rate_limits || typeof data.rate_limits !== 'object') return 0
  let stored = 0
  for (const [key, minutes] of Object.entries(config.claude.windows)) {
    const window = data.rate_limits[key]
    const used = window?.used_percentage
    if (typeof used !== 'number') continue
    if (
      storeReading(
        db,
        {
          provider: 'claude',
          window_minutes: minutes,
          observedAt: observed,
          used_percent: used,
          resetsAt: seconds(window?.resets_at),
          source: CLAUDE_SOURCE,
          plan_type: null,
        },
        minIntervalS,
      )
    )
      stored += 1
  }
  return stored
}
