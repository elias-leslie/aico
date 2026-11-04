// One collection pass: read each provider's usage where it exposes it, store the
// readings (and Codex's credit draws), and remember when and what could not be read.
// A provider that fails is reported by name; the others are still read.

import { join } from 'node:path'
import config from '../data/usage.json' with { type: 'json' }
import { collectClaude, statuslinePath } from './claude'
import { collectCodex } from './codex'
import { type Database, getState, putState } from './db'
import { collectOpenCode } from './opencode'
import { localDay, type Plans } from './plans'
import { micros } from './windows'

export interface CollectIo {
  dataDir: string
  home: string
  env: NodeJS.ProcessEnv
  fetch: typeof fetch
  /** Epoch ms. */
  now: number
  plans: Plans
}

export interface Collected {
  /** When this pass ran (ISO). */
  at: string
  /** Why a provider could not be read, by provider id (plain words, no values). */
  problems: Record<string, string>
  /** Providers whose reading failed (not-set-up is a problem but not a failure). */
  failed: string[]
}

/** The first local day Aico counts daily rows itself, set once (by the import or the first pass). */
export function cutoverDay(db: Database, now: number): string {
  const saved = getState<string>(db, 'cutover_day')
  if (saved) return saved
  const today = localDay(now)
  putState(db, 'cutover_day', today)
  return today
}

export async function collect(db: Database, io: CollectIo): Promise<Collected> {
  const problems: Record<string, string> = {}
  const failed: string[] = []
  const fail = (provider: string, error: unknown) => {
    problems[provider] = `${(error as Error).message}`
    failed.push(provider)
  }
  const gap = config.reading_min_interval_s

  try {
    collectClaude(db, statuslinePath(io.env, io.home), gap)
  } catch (error) {
    fail('claude', error)
  }

  try {
    const lotTimes = [
      ...io.plans.lots.map((lot) => micros(lot.granted_at) / 1000),
      ...(db.prepare('SELECT at FROM detected_lots').all() as unknown as { at: string }[]).map(
        (row) => Date.parse(row.at),
      ),
    ]
    collectCodex(db, {
      root: io.env.AICO_CODEX_SESSIONS || join(io.home, config.codex.sessions),
      homes: [`${io.home}/`],
      now: io.now,
      cutoverDay: cutoverDay(db, io.now),
      lotTimes,
    })
  } catch (error) {
    fail('codex', new Error(`Codex's session logs could not be read: ${(error as Error).message}`))
  }

  try {
    const got = await collectOpenCode(db, {
      keyFile: io.env.AICO_OPENCODE_GO_KEY_FILE || join(io.dataDir, config.opencode_go.key_file),
      idFile: join(io.dataDir, 'opencode-session-id'),
      fetch: io.fetch,
      now: io.now,
      minIntervalS: gap,
    })
    if (got === 'not-set-up')
      problems['opencode-go'] =
        `No OpenCode Go key yet: put it in ${config.opencode_go.key_file} in Aico's data folder`
  } catch (error) {
    fail('opencode-go', error)
  }

  // Readings past the lookback can no longer be the newest of anything.
  db.prepare('DELETE FROM readings WHERE observed_at < ?').run(
    new Date(io.now - config.lookback_days * 86400_000).toISOString(),
  )
  const at = new Date(io.now).toISOString()
  putState(db, 'collected', { at, problems, failed })
  return { at, problems, failed }
}
