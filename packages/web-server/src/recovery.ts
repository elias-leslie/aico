// Recovery for the web app: which sessions stopped on their own (a crash, or a
// restart of the workstation), what came back, and one action that resumes the
// ones waiting on the owner. Tether owns the records and the resume
// (packages/tether docs/crash-recovery.md, reboot-continuity.md); this words
// them for the page. Session names only: no transcript, note or log content.

import { machineId } from '@aico/status'
import { type TetherClient, TetherError } from '@aico/tether-client'
import { objectBody, type Router } from './http'
import { type Lifecycle, tetherCall } from './lifecycle'
import type { WebSession } from './sessions'
import { HttpError, listTools, toHttpError } from './tether'

/** Tether keeps a recovered or given-up crash this long (crash-recovery.md); a
 * restart is shown as long. */
const SHOWN_MS = 24 * 3600_000
const SESSION_ID = /^[0-9a-f]{8}$/
const MAX_WORDS = 200

type RecoveryOutcome = 'resumed' | 'waiting' | 'gave_up'

interface RecoveryItem {
  id: string
  /** The session's name as the rest of the app shows it. */
  name: string
  /** The agent's name (Claude Code, Codex...), or Shell. */
  agent: string
  project: string | null
  machine: string
  /** `crash`: it stopped while the workstation kept running. `restart`: it stopped with the workstation. */
  cause: 'crash' | 'restart'
  /** What happened, as a short phrase. */
  what: string
  /** When it stopped (ms); for a restart, about when the workstation came back. */
  at: number
  /** The time is Tether noticing, not the moment it stopped. */
  atApprox: boolean
  outcome: RecoveryOutcome
  /** When it came back (ms), once it has. */
  resumedAt: number | null
  /** The outcome in plain words, with the reason when it did not come back. */
  note: string
  /** Automatic tries left in the window; the owner's Resume does not use them. */
  attemptsLeft: number | null
  /** The owner's Resume applies to it. */
  resumable: boolean
  /** It is running now, so Open can show it. */
  canOpen: boolean
}

interface RecoveryView {
  /** When this was read (ms). */
  checkedAt: number
  /** A part of the answer could not be read; the page says so rather than showing it as nothing happening. */
  partial: string | null
  /** When the workstation last restarted, if sessions were restored then (ms). */
  restartAt: number | null
  maxAttempts: number
  windowHours: number
  resumable: number
  items: RecoveryItem[]
}

interface CrashRow {
  id: string
  name: string | null
  tool: string
  state: string
  kind: string
  cause: string
  agent_was_hog: boolean
  died_at: number
  died_at_approx: boolean
  recovered_at: number | null
  attempt: number
  reason: string | null
  resumable: boolean
}

interface RestoreRow {
  id: string
  name: string | null
  tool: string
  resumed?: boolean
  reason?: string
}

interface RebootStatus {
  boot_id?: string
  restore_boot_id?: string | null
  restore_started_at?: number | null
  restored?: RestoreRow[]
  failed?: RestoreRow[]
  pending?: RestoreRow[]
}

const CAUSES: Record<string, string> = {
  'oom-kill': 'Ran out of memory',
  killed: 'Was killed',
  signal: 'Was killed',
  'core-dump': 'Crashed',
  'exit-code': 'Exited with an error',
  lost: 'Lost its session server',
  'entry-unavailable': 'Couldn’t start: something it needs wasn’t ready',
}
const KIND_FALLBACK: Record<string, string> = {
  'server-died': 'Lost its session server',
  'agent-exited': 'The agent stopped',
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

/** Tether's reason ("it crashed again within 10 minutes...") as a sentence start. */
function reasonText(reason: string | null | undefined): string {
  return (reason ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_WORDS)
}

/** The reason as its own sentence: "It crashed again within 10 minutes of being recovered." */
function sentence(reason: string | null | undefined): string {
  const clean = reasonText(reason).replace(/[.\s]+$/, '')
  return clean ? `${clean[0].toUpperCase()}${clean.slice(1)}.` : ''
}

function crashRows(body: unknown): { rows: CrashRow[]; maxAttempts: number; windowHours: number } {
  const root = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const list = Array.isArray(root.sessions) ? root.sessions : []
  const rows: CrashRow[] = []
  for (const value of list) {
    if (!value || typeof value !== 'object') continue
    const row = value as Record<string, unknown>
    const diedAt = num(row.died_at)
    if (!text(row.id) || diedAt === null) continue
    rows.push({
      id: text(row.id),
      name: text(row.name) || null,
      tool: text(row.tool),
      state: text(row.state),
      kind: text(row.kind),
      cause: text(row.cause),
      agent_was_hog: row.agent_was_hog === true,
      died_at: diedAt,
      died_at_approx: row.died_at_approx !== false,
      recovered_at: num(row.recovered_at),
      attempt: num(row.attempt) ?? 0,
      reason: text(row.reason) || null,
      resumable: row.resumable === true,
    })
  }
  return {
    rows,
    maxAttempts: num(root.max_attempts) ?? 2,
    windowHours: num(root.window_hours) ?? 6,
  }
}

function crashWhat(row: CrashRow): string {
  const base = CAUSES[row.cause] ?? KIND_FALLBACK[row.kind] ?? 'Stopped unexpectedly'
  return row.cause === 'oom-kill' && row.agent_was_hog
    ? `${base} (the agent itself was using most of it)`
    : base
}

function crashItem(
  row: CrashRow,
  maxAttempts: number,
): Pick<
  RecoveryItem,
  'what' | 'at' | 'atApprox' | 'outcome' | 'resumedAt' | 'note' | 'attemptsLeft' | 'resumable'
> {
  const why = reasonText(row.reason)
  const base = {
    what: crashWhat(row),
    at: row.died_at,
    atApprox: row.died_at_approx,
    resumedAt: null as number | null,
  }
  if (row.state === 'recovered')
    return {
      ...base,
      outcome: 'resumed',
      resumedAt: row.recovered_at,
      note: 'Resumed where it left off.',
      attemptsLeft: Math.max(0, maxAttempts - row.attempt),
      resumable: false,
    }
  if (row.state === 'held')
    return {
      ...base,
      outcome: 'gave_up',
      note: sentence(why) || 'It stopped and Aico gave up bringing it back.',
      attemptsLeft: 0,
      resumable: row.resumable,
    }
  return {
    ...base,
    outcome: 'waiting',
    note: sentence(why) || 'Waiting to resume by itself.',
    attemptsLeft: Math.max(0, maxAttempts - row.attempt),
    resumable: false,
  }
}

/** The restart's entries, as items to be filled in with session facts. */
function restartRows(
  status: RebootStatus | null,
  bootId: string | undefined,
  now: number,
): { at: number; rows: Array<{ row: RestoreRow; outcome: RecoveryOutcome }> } | null {
  const at = num(status?.restore_started_at)
  if (!status || at === null || !bootId || status.restore_boot_id !== bootId) return null
  if (now - at > SHOWN_MS) return null
  const rows: Array<{ row: RestoreRow; outcome: RecoveryOutcome }> = []
  const take = (list: RestoreRow[] | undefined, outcome: RecoveryOutcome) => {
    for (const row of Array.isArray(list) ? list : [])
      if (text(row?.id)) rows.push({ row, outcome })
  }
  take(status.failed, 'gave_up')
  take(status.pending, 'waiting')
  take(status.restored, 'resumed')
  return { at, rows }
}

function restartNote(row: RestoreRow, outcome: RecoveryOutcome): string {
  const why = reasonText(row.reason)
  if (outcome === 'resumed')
    return row.resumed === false
      ? 'Started again fresh; it had no conversation to resume.'
      : 'Resumed where it left off.'
  if (outcome === 'waiting') return sentence(why) || 'Still restarting.'
  return sentence(why) || 'It didn’t come back after the restart.'
}

async function bestEffort<T>(work: () => Promise<T>): Promise<T | null> {
  try {
    return await work()
  } catch {
    return null
  }
}

const ORDER: Record<RecoveryOutcome, number> = { gave_up: 0, waiting: 1, resumed: 2 }

async function readRecovery(
  life: Lifecycle,
  tether: TetherClient,
  machine: string,
  now = Date.now(),
): Promise<RecoveryView> {
  const [crashes, sessions, reboot, projects, tools] = await Promise.all([
    tetherCall(() => tether.request<unknown>('GET', '/v1/recovery/status').then((a) => a.body)),
    life.listSessions(),
    bestEffort(() => tether.request<RebootStatus>('GET', '/v1/reboot/status').then((a) => a.body)),
    bestEffort(() => tether.projects()),
    bestEffort(() => listTools(tether)),
  ])
  const byId = new Map<string, WebSession>(sessions.map((session) => [session.id, session]))
  const projectName = new Map((projects ?? []).map((project) => [project.id, project.name]))
  const agentName = new Map(
    (tools?.items ?? []).map((tool) => [text(tool.slug), text(tool.name) || text(tool.slug)]),
  )
  const agentOf = (slug: string) => (slug === 'shell' ? 'Shell' : agentName.get(slug) || slug)

  const { rows, maxAttempts, windowHours } = crashRows(crashes)
  const known = new Map<string, RecoveryItem>()
  const identity = (id: string, tool: string, recorded: string | null) => {
    const session = byId.get(id)
    return {
      id,
      name: session?.name || recorded || `${agentOf(tool)} session`,
      agent: agentOf(session?.mode || tool),
      project: session?.project_id
        ? (projectName.get(session.project_id) ?? session.project_id)
        : null,
      machine: session?.host ?? machine,
      canOpen: session?.status === 'running',
    }
  }

  for (const row of rows) {
    if (now - row.died_at > SHOWN_MS * 2) continue
    known.set(row.id, {
      ...identity(row.id, row.tool, row.name),
      cause: 'crash',
      ...crashItem(row, maxAttempts),
    })
  }

  const restart = restartRows(reboot, reboot?.boot_id, now)
  for (const { row, outcome } of restart?.rows ?? []) {
    // A later crash of the same session is the newer story; an ended session is not shown.
    if (known.has(row.id) || !byId.has(row.id)) continue
    known.set(row.id, {
      ...identity(row.id, row.tool, row.name ?? null),
      cause: 'restart',
      what: 'Stopped when the workstation restarted',
      at: restart?.at ?? now,
      atApprox: true,
      outcome,
      resumedAt: null,
      note: restartNote(row, outcome),
      attemptsLeft: null,
      resumable: false,
    })
  }

  const items = [...known.values()].sort(
    (a, b) => ORDER[a.outcome] - ORDER[b.outcome] || b.at - a.at,
  )
  return {
    checkedAt: now,
    partial: reboot ? null : 'The list of sessions restored after a restart could not be read.',
    restartAt: restart?.at ?? null,
    maxAttempts,
    windowHours,
    resumable: items.filter((item) => item.resumable).length,
    items,
  }
}

interface ResumeResult {
  id: string
  name: string
  ok: boolean
  /** Why not, in plain words. */
  reason: string | null
}

function refusal(error: unknown): string {
  if (error instanceof TetherError) {
    if (error.code === 'not_held') return 'It isn’t waiting on you any more.'
    if (error.code === 'reservation_unavailable')
      return `There isn’t room to start it now${error.reason ? ` (${reasonText(error.reason)})` : ''}.`
  }
  try {
    return toHttpError(error).detail
  } catch {
    return 'Tether could not resume it.'
  }
}

export function registerRecoveryRoutes(
  router: Router,
  life: Lifecycle,
  tether: TetherClient,
  machine: string = machineId(),
): void {
  router.on('GET', '/api/recovery', () => readRecovery(life, tether, machine))

  // One session ({id}), or everything waiting on the owner (no body).
  router.on('POST', '/api/recovery/resume', async (ctx) => {
    const body = objectBody(await ctx.body())
    const only = body.id
    if (only !== undefined && (typeof only !== 'string' || !SESSION_ID.test(only)))
      throw new HttpError(422, 'id must be a session id')
    const view = await readRecovery(life, tether, machine)
    const targets = view.items.filter(
      (item) => item.resumable && (only === undefined || item.id === only),
    )
    if (only !== undefined && targets.length === 0)
      throw new HttpError(409, 'That session isn’t waiting to be resumed')
    if (targets.length === 0) throw new HttpError(409, 'Nothing is waiting to be resumed')
    const results: ResumeResult[] = []
    // One at a time: Tether starts agents one by one through host admission anyway.
    for (const item of targets) {
      try {
        await tether.request(
          'POST',
          `/v1/recovery/${encodeURIComponent(item.id)}/resume`,
          undefined,
          {
            timeoutMs: 60_000,
          },
        )
        results.push({ id: item.id, name: item.name, ok: true, reason: null })
      } catch (error) {
        results.push({ id: item.id, name: item.name, ok: false, reason: refusal(error) })
      }
    }
    return { resumed: results.filter((result) => result.ok).length, results }
  })
}
