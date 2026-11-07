// `aico usage collect | show`: usage.db from the command line.
// `collect` is what the scheduler runs every few minutes; its last line is the plain
// summary the job's Status row shows. `show` prints the spend card as the Status page has it.

import { existsSync, statSync } from 'node:fs'
import { localTime } from '@aico/shared/time'
import { outboxDir, postOrKeep, type StatusRow } from '@aico/status'
import config from '../data/usage.json' with { type: 'json' }
import { collect } from './collect'
import { getState, openUsage, plansPath, usageDbPath } from './db'
import { loadFacts } from './facts'
import { loadPlans } from './plans'
import { usageReport } from './report'
import { brief, type SpendInput, spendRows } from './spend'
import type { ProjectRef } from './split'
import { type Facts, micros } from './windows'

export const USAGE_COMMANDS = ['usage'] as const

export interface UsageCliIo {
  out(text: string): void
  err(text: string): void
  /** Aico's data directory (usage.db, the plans file, the secrets folder). */
  dataDir: string
  home: string
  env: NodeJS.ProcessEnv
  /** This host's id on Status rows. */
  machine: string
  /** aico-web's POST /api/status/rows on loopback, or null to skip the rows. */
  statusUrl: string | null
  fetch: typeof fetch
  now(): Date
  /** The registered projects, to name the folders usage is filed under. */
  projects?: () => ProjectRef[]
}

const USAGE = `Usage: aico usage [command]   (no command: show)

  aico usage collect [--no-status]   read each subscription's usage now and update its Status row
  aico usage [show] [--json]         what each subscription has left, and for Claude and Codex
                                     which projects the last 7 days of use came from
`

class UsageError extends Error {}

function flags(command: string, argv: string[], valued: string[], bare: string[]) {
  const set = new Set<string>()
  const values = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string
    if (bare.includes(arg)) set.add(arg)
    else if (valued.includes(arg)) {
      const value = argv[i + 1]
      if (value === undefined) throw new UsageError(`aico usage ${command}: ${arg} needs a value`)
      values.set(arg, value)
      i += 1
    } else
      throw new UsageError(
        `aico usage ${command}: unknown option ${arg}${bare.length ? ` (${bare.join(', ')})` : ''}`,
      )
  }
  return { set, values }
}

async function postRows(io: UsageCliIo, rows: StatusRow[]) {
  if (!io.statusUrl) return
  try {
    const waiting = await postOrKeep(io.statusUrl, rows, {
      dir: outboxDir(io.dataDir),
      fetch: io.fetch,
    })
    if (waiting) io.err(`Status rows not sent yet, they go out on the next try: ${waiting}\n`)
  } catch (cause) {
    io.err(`Status rows not saved: ${(cause as Error).message}\n`)
  }
}

function spendInput(db: ReturnType<typeof openUsage>, io: UsageCliIo): SpendInput {
  const now = io.now().toISOString()
  const plans = loadPlans(plansPath(io.dataDir))
  const saved = getState<{ at: string; problems: Record<string, string> }>(db, 'collected')
  return {
    facts: loadFacts(db, plans, now),
    plans,
    machine: io.machine,
    now,
    collectedAt: saved?.at ?? now,
    problems: saved?.problems ?? {},
  }
}

async function collectCommand(argv: string[], io: UsageCliIo): Promise<number> {
  const { set } = flags('collect', argv, [], ['--no-status'])
  const db = openUsage(usageDbPath(io.dataDir))
  try {
    const plans = loadPlans(plansPath(io.dataDir))
    const done = await collect(db, {
      dataDir: io.dataDir,
      home: io.home,
      env: io.env,
      fetch: io.fetch,
      now: io.now().getTime(),
      plans,
    })
    const input = spendInput(db, io)
    const rows = spendRows(input)
    if (!set.has('--no-status')) await postRows(io, rows)
    const summary = config.providers.map((provider) => brief(provider, input)).join('; ')
    if (done.failed.length) {
      for (const provider of done.failed) io.err(`${provider}: ${done.problems[provider]}\n`)
      io.out(`Could not read ${done.failed.join(', ')}. ${summary}.\n`)
      return 1
    }
    io.out(`Usage read: ${summary}.\n`)
    return 0
  } finally {
    db.close()
  }
}

/** 141,089,000 -> "141M": counts in a few characters. */
const compact = (value: number): string =>
  value >= 1e9
    ? `${(value / 1e9).toFixed(1)}B`
    : value >= 1e6
      ? `${(value / 1e6).toFixed(value >= 1e7 ? 0 : 1)}M`
      : value >= 1e4
        ? `${(value / 1e3).toFixed(0)}K`
        : value >= 1e3
          ? `${(value / 1e3).toFixed(1)}K`
          : String(Math.round(value))

/** "62%", or "<1%" for a share that rounds to nothing. */
const percent = (share: number): string => {
  const value = Math.round(share * 100)
  return value === 0 && share > 0 ? '<1%' : `${value}%`
}

/** The by-project lines of `aico usage show`: one block per provider, or why there is none. */
export function projectLines(report: ReturnType<typeof usageReport>): string {
  if ('error' in report) return `By project: not available (${report.error})\n`
  let out = ''
  for (const provider of report.providers) {
    const split = provider.by_project
    if (!split.tracked) {
      out += `${provider.name} by project: not tracked by project.\n`
      continue
    }
    const days = config.project_split.days
    if (!split.unit || split.items.length === 0) {
      out += `${provider.name} by project: nothing recorded in the last ${days} days.\n`
      continue
    }
    const what = split.unit === 'credits' ? 'credits spent' : 'tokens'
    out += `${provider.name} by project, last ${days} days (${compact(split.total)} ${what}):\n`
    const width = Math.max(...split.items.map((item) => item.name.length))
    for (const item of split.items)
      out += `  ${item.name.padEnd(width)}  ${percent(item.share).padStart(4)}  ${compact(item.amount)}\n`
  }
  return out
}

function showCommand(argv: string[], io: UsageCliIo): number {
  const { set } = flags('show', argv, [], ['--json'])
  if (!existsSync(usageDbPath(io.dataDir))) {
    io.err('Aico has not collected usage yet: run aico usage collect.\n')
    return 1
  }
  const db = openUsage(usageDbPath(io.dataDir))
  try {
    const input = spendInput(db, io)
    const report = usageReport(io.dataDir, input.now, io.projects?.())
    if (set.has('--json')) {
      const by_project =
        'error' in report
          ? { error: report.error }
          : Object.fromEntries(report.providers.map((p) => [p.id, p.by_project]))
      io.out(
        `${JSON.stringify({ as_of: input.now, collected_at: input.collectedAt, facts: input.facts, rows: spendRows(input), by_project }, null, 2)}\n`,
      )
      return 0
    }
    for (const row of spendRows(input)) io.out(`${row.what}: ${row.meaning}\n`)
    io.out(projectLines(report))
    io.out(`Collected ${localTime(micros(input.collectedAt) / 1000)}.\n`)
    return 0
  } finally {
    db.close()
  }
}

/** One `aico usage` command; its exit status. */
export async function runUsageCli(argv: string[], io: UsageCliIo): Promise<number> {
  // Bare `aico usage` (or only flags, like --json) shows.
  const [sub, ...rest] =
    !argv[0] || (argv[0].startsWith('-') && !['--help', '-h'].includes(argv[0]))
      ? ['show', ...argv]
      : argv
  if (sub === '--help' || sub === '-h' || rest.includes('--help') || rest.includes('-h')) {
    io.out(USAGE)
    return 0
  }
  try {
    if (sub === 'collect') return await collectCommand(rest, io)
    if (sub === 'show') return showCommand(rest, io)
    throw new UsageError(`aico usage: unknown command ${sub} (collect or show; aico usage --help)`)
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    io.err(`${error.message}\n`)
    return 2
  }
}

/**
 * The facts routing reads, or why there are none: usage.db was never filled, or cannot be read.
 * Opens the file read-only in effect (nothing is written) and never creates it.
 */
export function routeFacts(
  dataDir: string,
  now: string,
): { facts: Facts; collectedAt: string } | { error: string } {
  const path = usageDbPath(dataDir)
  if (!existsSync(path) || statSync(path).size === 0)
    return { error: 'Aico has not collected usage yet (run aico usage collect)' }
  let db: ReturnType<typeof openUsage> | null = null
  try {
    db = openUsage(path)
    const saved = getState<{ at: string }>(db, 'collected')
    if (!saved) return { error: 'Aico has not collected usage yet (run aico usage collect)' }
    return { facts: loadFacts(db, loadPlans(plansPath(dataDir)), now), collectedAt: saved.at }
  } catch (error) {
    return { error: `Aico's usage facts could not be read: ${(error as Error).message}` }
  } finally {
    db?.close()
  }
}
