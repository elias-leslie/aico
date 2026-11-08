// One collection pass: read each provider's usage where it exposes it, store the
// readings (and Codex's credit draws), and remember when and what could not be read.
// A provider that fails is reported by name; the others are still read.

import { delimiter, join } from 'node:path'
import config from '../data/usage.json' with { type: 'json' }
import { collectClaude, statuslinePaths } from './claude'
import { collectClaudeTranscripts } from './claude-transcripts'
import { collectCodex } from './codex'
import { type Database, getState, putState } from './db'
import { notePlanUse } from './facts'
import { nativeHomes, privateMatcher } from './homes'
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
function cutoverDay(db: Database, now: number): string {
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

  // Claude's and Codex's files of every native home. A home or file that cannot be read is
  // counted, never named (some homes are not to be named in anything the collector says).
  const homes = nativeHomes(io.env, io.home)
  let claudeRead = 0
  let claudeBroken = 0
  for (const path of statuslinePaths(io.env, io.home, homes)) {
    try {
      collectClaude(db, path, gap)
      claudeRead += 1
    } catch {
      claudeBroken += 1
    }
  }
  if (claudeBroken && !claudeRead)
    fail('claude', new Error("Claude Code's usage snapshot is not readable JSON"))
  else if (claudeBroken)
    problems.claude = `${claudeBroken} of ${claudeBroken + claudeRead} usage snapshots are not readable JSON`

  // Per-model and per-project token use comes from the transcripts, not the snapshot; a failure
  // here says so without making the snapshot's windows unreadable.
  try {
    const result = collectClaudeTranscripts(db, {
      roots: homes.map((h) => join(h, config.claude.transcripts)),
      homes: homes.map((h) => `${h}/`),
      isPrivate: privateMatcher(config.private_words),
      now: io.now,
      cutoverDay: cutoverDay(db, io.now),
    })
    if (result.unreadable)
      problems.claude = [
        problems.claude,
        `${result.unreadable} of ${result.roots} Claude Code transcript folders could not be read`,
      ]
        .filter(Boolean)
        .join('; ')
  } catch {
    problems.claude = [problems.claude, "Claude Code's transcripts could not be read"]
      .filter(Boolean)
      .join('; ')
  }

  try {
    const lotTimes = [
      ...io.plans.lots.map((lot) => micros(lot.granted_at) / 1000),
      ...(db.prepare('SELECT at FROM detected_lots').all() as unknown as { at: string }[]).map(
        (row) => Date.parse(row.at),
      ),
    ]
    const configured = (io.env.AICO_CODEX_SESSIONS ?? '').split(delimiter).filter(Boolean)
    const result = collectCodex(db, {
      roots: configured.length ? configured : homes.map((h) => join(h, config.codex.sessions)),
      homes: homes.map((h) => `${h}/`),
      isPrivate: privateMatcher(config.private_words),
      now: io.now,
      cutoverDay: cutoverDay(db, io.now),
      lotTimes,
    })
    if (result.unreadable && result.unreadable === result.roots)
      fail('codex', new Error("Codex's session logs could not be read"))
    else if (result.unreadable)
      problems.codex = `${result.unreadable} of ${result.roots} Codex session folders could not be read`
  } catch {
    // The message could carry a file path; say only what failed.
    fail('codex', new Error("Codex's session logs could not be read"))
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

  notePlanUse(db, io.plans, new Date(io.now).toISOString())
  // Readings past the lookback can no longer be the newest of anything.
  db.prepare('DELETE FROM readings WHERE observed_at < ?').run(
    new Date(io.now - config.lookback_days * 86400_000).toISOString(),
  )
  const at = new Date(io.now).toISOString()
  putState(db, 'collected', { at, problems, failed })
  return { at, problems, failed }
}
