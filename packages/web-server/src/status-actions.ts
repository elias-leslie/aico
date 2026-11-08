// What the Status page's row actions do, and the phone alert a Status batch sends.
//
//   POST /api/status/run  {id}                     runs the row's run ref on this machine. Answers when
//                                                  it ends, or after RUN_WAIT_MS while it keeps going;
//                                                  409 while an earlier run of the row still goes.
//   POST /api/status/log  {id}                     the last lines the row's log ref prints; `truncated`
//                                                  when it was still printing at LOG_WAIT_MS.
//   POST /api/status/look {id, message, project}   starts a session in that project with the default
//                                                  agent tool and `message` as its first message
//                                                  (a Tether root, as `st aico create` starts one).
//
// All three are POSTs, so a page on another site is refused by the Origin check (guard.ts).
// Refs run only for rows of this machine, and never for the OmniNull hub's rows (ids `ominull...`),
// which arrive over the LAN: a ref is a command a program on this machine wrote. Each runs in its
// own process group, so a cut-off log takes everything it started with it.

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import type { ActionKind, AlertBatch, StatusRow, StatusStore, Sustained } from '@aico/status'
import { alertText } from '@aico/status'
import type { TetherClient } from '@aico/tether-client'
import { objectBody, type Router, requiredString } from './http'
import { tetherCall } from './lifecycle'
import { HttpError, listTools } from './tether'

/** How long a run is waited on before the page hears "still running". */
const RUN_WAIT_MS = 4_000
/** A log ref that keeps printing (`-f`, or a whole journal) is cut off here. */
const LOG_WAIT_MS = 10_000
const LOG_LINES = 200
/** After SIGTERM, how long a cut-off log's process group has before SIGKILL. */
const KILL_GRACE_MS = 2_000
/** Tether's cap on a fresh session's first message. */
const MAX_MESSAGE_BYTES = 2_000
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
/** Who a session started from a row is, for Tether's root records. */
const LOOK_ROLE = 'status-look'
const LOOK_WORK_ROLE = 'operations'

/** The rows whose run ref is going now: one run per row at a time. */
export class StatusRuns {
  private readonly live = new Set<string>()

  /** Marks `id` running; false when it already is. */
  start(id: string): boolean {
    if (this.live.has(id)) return false
    this.live.add(id)
    return true
  }

  end(id: string): void {
    this.live.delete(id)
  }

  ids(): string[] {
    return [...this.live].sort()
  }
}

export interface StatusActionDeps {
  status: Pick<StatusStore, 'rows'>
  machine: string
  tether: Pick<TetherClient, 'request' | 'projects'>
  runs?: StatusRuns
  /** RUN_WAIT_MS and LOG_WAIT_MS, shorter in tests. */
  waitMs?: { run: number; log: number }
}

interface Ran {
  /** running: still going after the wait (a log is cut off then); done or failed: it ended. */
  state: 'running' | 'done' | 'failed'
  code: number | null
  lines: string[]
}

/** Signals `pid`'s whole process group; quiet when it is already gone. */
function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return
  try {
    process.kill(-pid, signal)
  } catch {
    // ESRCH: the group has ended.
  }
}

/**
 * Runs `ref` with sh in its own process group; resolves after `waitMs` or when it ends, with the
 * last lines it printed. `killAfterWait` ends the whole group at the wait (SIGTERM, then SIGKILL);
 * otherwise it keeps going. `onEnd` is told when it ends, even after the answer.
 */
export function runRef(
  ref: string,
  waitMs: number,
  options: { keep?: number; killAfterWait?: boolean; onEnd?: () => void } = {},
): Promise<Ran> {
  const keep = options.keep ?? 20
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', ref], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    let ended = false
    const end = () => {
      if (ended) return
      ended = true
      options.onEnd?.()
    }
    let tail: string[] = []
    let partial = ''
    const take = (chunk: Buffer) => {
      const parts = (partial + chunk.toString('utf8')).split('\n')
      partial = parts.pop() ?? ''
      tail = [...tail, ...parts].slice(-keep)
    }
    const lines = () => (partial ? [...tail, partial] : tail).slice(-keep)
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      if (options.killAfterWait) {
        signalGroup(child.pid, 'SIGTERM')
        setTimeout(() => {
          if (!ended) signalGroup(child.pid, 'SIGKILL')
        }, KILL_GRACE_MS).unref()
      } else child.unref()
      resolve({ state: 'running', code: null, lines: lines() })
    }, waitMs)
    child.on('error', (error) => {
      end()
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ state: 'failed', code: null, lines: [...lines(), error.message] })
    })
    child.on('close', (code) => {
      end()
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ state: code === 0 ? 'done' : 'failed', code, lines: lines() })
    })
  })
}

/** The row and its ref for `kind`, if this page may act on it here. */
function actionable(
  deps: StatusActionDeps,
  id: string,
  kind: ActionKind,
): { row: StatusRow; ref: string } {
  const stored = deps.status.rows().find((item) => item.row.id === id)
  if (!stored) throw new HttpError(404, 'No such row')
  const { row } = stored
  const ref = row.actions?.find((action) => action.kind === kind)?.ref
  if (!ref) throw new HttpError(422, `${row.what} has no ${kind} command`)
  if (row.machine !== deps.machine || row.id.startsWith('ominull'))
    throw new HttpError(422, `${row.what} runs on ${row.machine}; run it there`)
  return { row, ref }
}

export function registerStatusActions(router: Router, deps: StatusActionDeps): void {
  const runs = deps.runs ?? new StatusRuns()
  const wait = deps.waitMs ?? { run: RUN_WAIT_MS, log: LOG_WAIT_MS }

  router.on('POST', '/api/status/run', async (ctx) => {
    const id = requiredString(objectBody(await ctx.body()), 'id', { max: 200 })
    const { row, ref } = actionable(deps, id, 'run')
    if (!runs.start(id)) throw new HttpError(409, `${row.what} is still running`)
    return runRef(ref, wait.run, { onEnd: () => runs.end(id) })
  })

  router.on('POST', '/api/status/log', async (ctx) => {
    const id = requiredString(objectBody(await ctx.body()), 'id', { max: 200 })
    const { ref } = actionable(deps, id, 'log')
    const ran = await runRef(ref, wait.log, { keep: LOG_LINES, killAfterWait: true })
    return {
      ref,
      machine: deps.machine,
      ok: ran.state !== 'failed',
      truncated: ran.state === 'running',
      lines: ran.lines,
    }
  })

  router.on('POST', '/api/status/look', async (ctx) => {
    const body = objectBody(await ctx.body())
    const id = requiredString(body, 'id', { max: 200 })
    const message = requiredString(body, 'message').trim()
    const projectId = requiredString(body, 'project', { pattern: PROJECT })
    if (!message) throw new HttpError(422, 'Write a first message')
    if (Buffer.byteLength(message) > MAX_MESSAGE_BYTES)
      throw new HttpError(422, `The first message is longer than ${MAX_MESSAGE_BYTES} bytes`)
    if (!deps.status.rows().some((item) => item.row.id === id))
      throw new HttpError(404, 'No such row')
    const [projects, tools] = await Promise.all([
      tetherCall(() => deps.tether.projects()),
      tetherCall(() => listTools(deps.tether as TetherClient)),
    ])
    const project = projects.find((item) => item.id === projectId)
    if (!project?.root) throw new HttpError(422, `No project ${projectId} on this machine`)
    const tool = tools.defaultSlug
    if (!tool) throw new HttpError(503, 'No default agent tool is set')
    const { body: root } = await tetherCall(() =>
      deps.tether.request<{ hostIdentity?: unknown }>('POST', '/v1/roots', {
        requestId: `status-look-${randomUUID()}`,
        tool,
        projectId,
        projectRoot: project.root,
        initialPrompt: message,
        role: LOOK_ROLE,
        workRole: LOOK_WORK_ROLE,
      }),
    )
    return {
      session: typeof root?.hostIdentity === 'string' ? root.hostIdentity : null,
      tool,
      project: projectId,
    }
  })
}

/** Notice keys are at most this long (contracts/notice.schema.json). */
const MAX_KEY = 200

/**
 * The batch's notice key: what changed, to what (`status:a/backup=late,a/job=failed`). The same
 * rows turning the same way again inside the cooldown is a repeat notify keeps off the phone.
 */
export function statusKey(batch: AlertBatch): string {
  const what = batch.changes
    .map((change) => `${change.row.id}=${change.to}`)
    .sort()
    .join(',')
  const key = `status:${what}`
  return key.length <= MAX_KEY
    ? key
    : `status:${createHash('sha256').update(what).digest('hex').slice(0, 32)}`
}

/**
 * The Status alert notice (contracts/notice.schema.json) for rows that turned failed or late. It
 * goes to the tray and the morning digest, never the phone: a first late or failed run is usually
 * a guest, a drive or a copy catching up. What does reach the phone is a major row that stays that
 * way (sustainedNotice). Once per `cooldownS` for the same changes, so a flapping row doesn't
 * repeat in the tray.
 */
export function statusNotice(
  batch: AlertBatch,
  publicHost: string | null,
  cooldownS: number,
): Record<string, unknown> {
  const { title, body } = alertText(batch)
  const failed = batch.changes.some((change) => change.to === 'failed')
  return {
    v: 1,
    source: 'aico',
    kind: 'alert',
    severity: failed ? 'critical' : 'warning',
    title: title.slice(0, 200),
    body: body.slice(0, 1000),
    key: statusKey(batch),
    cooldown: cooldownS,
    push: 'tray',
    ...(publicHost ? { open: `https://${publicHost}/status` } : {}),
  }
}

const SUSTAINED_REASON: Record<Sustained['major'], string> = {
  'data-risk': 'has stayed failed or late past its retry',
  outage: 'is still down',
}

/** The notice key for a row that stayed bad; `resolveNotice` ends it when the row is well. */
export const sustainedKey = (rowId: string) => `status-sustained:${rowId}`.slice(0, MAX_KEY)

/**
 * The phone notice for a major row that stayed failed or late past its window (status/major.ts):
 * a backup that did not recover on its retry, an always-on machine or a service still down. One
 * per row until it is well again.
 */
export function sustainedNotice(
  item: Sustained,
  publicHost: string | null,
): Record<string, unknown> {
  const { row, major } = item
  return {
    v: 1,
    source: 'aico',
    kind: 'alert',
    severity: 'critical',
    title: `${row.what} ${SUSTAINED_REASON[major]}`.slice(0, 200),
    body: `${row.meaning || row.what} Since ${new Date(item.since).toISOString()}.`.slice(0, 1000),
    key: sustainedKey(row.id),
    cooldown: 7 * 24 * 3600,
    push: 'phone',
    interrupt: major,
    ...(publicHost ? { open: `https://${publicHost}/status` } : {}),
  }
}
