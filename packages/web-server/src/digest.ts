// "While you were away": what finished, failed, stalled or needs the owner since a time.
// One builder serves the web card (GET /api/digest) and the morning phone push. Each source
// is read on its own; a part that cannot be read is named in `unavailable` and its numbers
// are not to be shown as zero.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Notifier } from '@aico/notify'
import type { StatusStore } from '@aico/status'
import type { TetherClient } from '@aico/tether-client'
import { localDay, openUsage, usageDbPath } from '@aico/usage'
import type { Ask } from './asks'
import { fromThisMachine } from './guard'
import { liveSessions } from './history'
import type { Router } from './http'
import { isTestRun } from './test-runs'
import { HttpError } from './tether'

/** A working session whose agent has written nothing for this long counts as quiet. */
export const QUIET_MINUTES = 10
/** How many recent conversations the digest looks through. */
const DIGEST_HISTORY_LIMIT = 200
/** The longest window a digest covers. */
const DIGEST_MAX_DAYS = 14

export type DigestPart = 'history' | 'sessions' | 'asks' | 'status' | 'spend'

export interface Digest {
  since: number
  generatedAt: number
  finished: number
  failed: number
  stuck: { quiet: number; waiting: number }
  asks: number
  problems: { count: number; failed: number }
  spend: { sinceDay: string; items: { provider: string; credits: number }[] } | null
  unavailable: DigestPart[]
}

export interface DigestDeps {
  dataDir: string
  tether: Pick<TetherClient, 'listSessions' | 'history'>
  asks: { list(): Promise<Pick<Ask, 'createdAt'>[]> }
  status: Pick<StatusStore, 'read'>
}

function spendSince(dataDir: string, since: number): NonNullable<Digest['spend']> {
  const path = usageDbPath(dataDir)
  // openUsage would create a missing file; a missing one is unreadable, not empty.
  if (!existsSync(path)) throw new Error('no usage database')
  const sinceDay = localDay(since)
  const db = openUsage(path)
  try {
    const rows = db
      .prepare(
        'SELECT provider, SUM(credits_drawn) AS credits FROM daily WHERE day >= ? AND credits_drawn > 0 GROUP BY provider ORDER BY credits DESC',
      )
      .all(sinceDay) as unknown as { provider: string; credits: number }[]
    return { sinceDay, items: rows.map((r) => ({ provider: r.provider, credits: r.credits })) }
  } finally {
    db.close()
  }
}

export async function buildDigest(deps: DigestDeps, since: number, now: number): Promise<Digest> {
  const unavailable: DigestPart[] = []
  const [live, history, asks] = await Promise.all([
    liveSessions(deps.tether).catch(() => null),
    deps.tether.history({ limit: DIGEST_HISTORY_LIMIT }).catch(() => null),
    deps.asks.list().catch(() => null),
  ])
  const digest: Digest = {
    since,
    generatedAt: now,
    finished: 0,
    failed: 0,
    stuck: { quiet: 0, waiting: 0 },
    asks: 0,
    problems: { count: 0, failed: 0 },
    spend: null,
    unavailable,
  }

  if (live) {
    const quietBefore = now - QUIET_MINUTES * 60_000
    for (const s of live) {
      if (s.activity === 'blocked' || s.asking) digest.stuck.waiting++
      else if (s.activity === 'working' && s.lastWriteAt !== null && s.lastWriteAt < quietBefore)
        digest.stuck.quiet++
    }
  } else unavailable.push('sessions')

  if (history) {
    const running = new Set((live ?? []).map((s) => s.conversation))
    for (const item of history.items) {
      if (item.outcome === null || item.outcome === undefined) continue
      if (item.endedAt === null || item.endedAt < since) continue
      if (running.has(item.id) || isTestRun(item)) continue
      digest.finished++
      if (item.outcome === 'error' || item.outcome === 'aborted') digest.failed++
    }
  } else unavailable.push('history')

  if (asks) digest.asks = asks.filter((ask) => ask.createdAt >= since).length
  else unavailable.push('asks')

  try {
    const { summary } = deps.status.read()
    digest.problems = { count: summary.problems, failed: summary.counts.failed ?? 0 }
  } catch {
    unavailable.push('status')
  }

  try {
    digest.spend = spendSince(deps.dataDir, since)
  } catch {
    unavailable.push('spend')
  }
  return digest
}

// -- The morning push -------------------------------------------------------------------

const PUSH_FILE = 'digest-push.json'

interface PushState {
  at: number
  day: string
}

function readPushState(dataDir: string): PushState | null {
  try {
    const value = JSON.parse(readFileSync(join(dataDir, PUSH_FILE), 'utf8')) as Partial<PushState>
    return typeof value.at === 'number' && typeof value.day === 'string'
      ? { at: value.at, day: value.day }
      : null
  } catch {
    return null
  }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** True when there is nothing to tell: no counts and no problems. */
function digestIsQuiet(d: Digest): boolean {
  return (
    d.finished === 0 &&
    d.failed === 0 &&
    d.stuck.quiet === 0 &&
    d.stuck.waiting === 0 &&
    d.asks === 0 &&
    d.problems.count === 0
  )
}

/** The phone notice's title and body, in plain words; parts left out when zero. */
function digestWording(d: Digest): { title: string; body: string } {
  const title = [
    d.finished && `${d.finished} finished`,
    d.failed && `${d.failed} failed`,
    d.stuck.waiting && `${d.stuck.waiting} waiting on you`,
    d.asks && plural(d.asks, 'new question', 'new questions'),
    d.stuck.quiet && `${d.stuck.quiet} quiet`,
    d.problems.count && plural(d.problems.count, 'problem', 'problems'),
  ]
    .filter(Boolean)
    .slice(0, 3)
    .join(', ')
  const facts = [
    d.finished &&
      `${plural(d.finished, 'session', 'sessions')} finished${d.failed ? ` (${d.failed} failed)` : ''}`,
    d.stuck.waiting && `${plural(d.stuck.waiting, 'session is', 'sessions are')} waiting on you`,
    d.stuck.quiet && `${plural(d.stuck.quiet, 'session has', 'sessions have')} gone quiet`,
    d.asks && plural(d.asks, 'new question', 'new questions'),
    d.problems.count &&
      `${plural(d.problems.count, 'problem', 'problems')} in Status${d.problems.failed ? ` (${d.problems.failed} failed)` : ''}`,
  ].filter(Boolean) as string[]
  const list =
    facts.length > 1 ? `${facts.slice(0, -1).join(', ')} and ${facts[facts.length - 1]}` : facts[0]
  return {
    title: `While you were away: ${title}`,
    body: `${list ? `${list[0]?.toUpperCase()}${list.slice(1)}. ` : ''}Open Aico to see the day.`,
  }
}

export interface DigestRouteDeps extends DigestDeps {
  publicHost: string | null
  notifier: Pick<Notifier, 'receive'>
  now?: () => number
}

export function registerDigestRoutes(router: Router, deps: DigestRouteDeps): void {
  const clock = deps.now ?? Date.now
  router.on('GET', '/api/digest', async (ctx) => {
    const raw = ctx.query.get('since')
    if (raw === null || !/^\d{1,16}$/.test(raw))
      throw new HttpError(400, 'since must be a time in ms')
    const now = clock()
    const given = Number(raw)
    if (given > now) throw new HttpError(400, 'since is in the future')
    return buildDigest(deps, Math.max(given, now - DIGEST_MAX_DAYS * 86_400_000), now)
  })

  router.on('POST', '/api/digest/push', async (ctx) => {
    if (!fromThisMachine(ctx.req)) throw new HttpError(403, 'Send the digest from the Aico host.')
    const now = clock()
    const today = localDay(now)
    const last = readPushState(deps.dataDir)
    if (last?.day === today) return { pushed: false, reason: 'already sent today' }
    const since = Math.max(last?.at ?? now - 86_400_000, now - DIGEST_MAX_DAYS * 86_400_000)
    const digest = await buildDigest(deps, since, now)
    const record = () =>
      writeFileSync(join(deps.dataDir, PUSH_FILE), JSON.stringify({ at: now, day: today }))
    if (digestIsQuiet(digest)) {
      record()
      return { pushed: false, reason: 'nothing new' }
    }
    const { title, body } = digestWording(digest)
    deps.notifier.receive(
      {
        v: 1,
        source: 'aico',
        kind: 'info',
        severity: 'info',
        push: 'phone',
        key: `digest:${today}`,
        title,
        body,
        cooldown: 86_400,
        ...(deps.publicHost
          ? {
              open: `https://${deps.publicHost}/`,
              actions: ['open', 'mark-read'],
              primary: 'open',
            }
          : {}),
      },
      'local',
    )
    record()
    return { pushed: true }
  })
}
