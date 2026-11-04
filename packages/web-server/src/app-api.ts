// The phone app's API (native/android): /api/app/*, every call signed by the phone's own key
// (app-phones.ts). The wire protocol is the Nightshift app's, unchanged, so the phone paired there
// keeps working: errors are `{error}`; the rows are Status problems, open Tether asks, Nightshift's
// pending taps and the notice log.
//
//   GET  /api/app/health          {ok, now, checked_at, phone_confirmed_at, line}; 503 {drill:true} in a drill
//   GET  /api/app/items           {health, needs_you: [Row], recent: [Row]}
//   POST /api/app/token           {fcm_token}              the phone's FCM token changed
//   POST /api/app/ack             {acks: [...], state}     what the phone got, and what it can do
//   POST /api/app/items/:item/act {action}                 a button without a link
//   POST /api/app/act             {row, action}            the same, by row id (older builds)
//   GET  /api/app/update          {version_code, version_name, sha256, size, download}
//   GET  /api/app/apk             the published APK
//   GET  /api/app/stream          Server-Sent Events: hello, item, health, reset; a keepalive every 15 s
//
// Not here: pairing a new phone (register, the pair link, the gate token) and the hourly canary.
//
// Health is "fresh" when aico-web reports itself and the host checks report: checked_at is the
// older of the two newest reports. The phone alarms when it is more than 60 minutes old.

import { createHash } from 'node:crypto'
import { createReadStream, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import type { NotifyStore, StoredNotice } from '@aico/notify'
import { counted, type ShownRow, type StatusStore } from '@aico/status'
import { AppError, cantBuzz, type Phone, type PhoneRegistry } from './app-phones'
import { apkPath, currentRelease, releaseDir } from './app-release'
import type { Approval, Ask } from './asks'
import { RAW, type RequestContext, type Router, sendJson } from './http'

const MAX_BODY = 16 * 1024
const DAY_MS = 86_400_000
/** Notices older than this are not listed as recent. */
const RECENT_MS = 7 * DAY_MS
const RECENT_MAX = 40
const KEEPALIVE_MS = 15_000
const WATCH_MS = 10_000
const MAX_STREAMS = 4
const DRILL_MAX_MIN = 120
const NOT_FOUND = 'not found'

export interface AppApiDeps {
  phones: PhoneRegistry
  status: Pick<StatusStore, 'read'>
  notify: Pick<NotifyStore, 'list' | 'get' | 'rowAskIds' | 'markRead'>
  asks: {
    list(): Promise<Ask[]>
    answer(id: string, reply: { option: number }): Promise<Ask>
    approvals(): Promise<Approval[] | null>
  }
  /** The machine whose `<machine>/aico-web` row is aico-web's own report. */
  machine: string
  publicHost: string | null
  dataDir: string
  /** Epoch ms. */
  now?: () => number
  /** How often a live feed checks the list, health and that its phone is still paired. */
  watchMs?: number
}

// -- Words -------------------------------------------------------------------------------

/** The website's short age: 5m, 3h, 2d. */
function ageText(seconds: number): string {
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m`
  if (seconds < 2 * 86_400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86_400)}d`
}

const pad = (n: number) => String(n).padStart(2, '0')
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** HH:MM today, else "Fri 17:12" (a stale time must not read as today's). */
function hhmm(seconds: number | null, nowMs: number): string {
  if (!seconds) return 'never'
  const at = new Date(seconds * 1000)
  const today = new Date(nowMs)
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`
  return at.toDateString() === today.toDateString() ? time : `${DAYS[at.getDay()]} ${time}`
}

const STATE_WORD: Record<string, string> = {
  failed: 'Failed',
  warn: 'Warning',
  late: 'Late',
  unknown: 'Unknown',
}

const cut = (text: string, max: number) =>
  [...text].length <= max ? text : `${[...text].slice(0, max - 1).join('')}…`

// -- Rows ----------------------------------------------------------------------------------

interface Action {
  id: string
  label: string
  tier: 'view' | 'plain' | 'key'
  url?: string
}

interface Row {
  id: string
  title: string
  body: string
  severity: 'critical' | 'warning' | 'info' | 'ok'
  state: string
  ts: number
  age: string
  url: string
  /** What /api/app/items/<item>/act takes; null when the row has no button that posts. */
  item: string | null
  actions: Action[]
}

const choiceId = (index: number, option: string) =>
  `choice:${index}:${createHash('sha256').update(option).digest('hex').slice(0, 8)}`

const base = (host: string | null) => (host ? `https://${host}` : '')

function openAction(url: string, label: string): Action[] {
  return url ? [{ id: 'open', label, tier: 'view', url }] : []
}

function problemRow(row: ShownRow, host: string | null, nowMs: number): Row {
  const since = Date.parse(row.shown_since ?? row.updated_at)
  const url = host ? `${base(host)}/status` : ''
  return {
    id: `k:${row.id}`,
    title: cut(`${row.what} ${STATE_WORD[row.shown]?.toLowerCase() ?? row.shown}`, 200),
    body: cut(row.meaning, 1000),
    severity: row.shown === 'failed' ? 'critical' : 'warning',
    state: STATE_WORD[row.shown] ?? row.shown,
    ts: Math.floor(since / 1000),
    age: ageText(Math.max(0, (nowMs - since) / 1000)),
    url,
    item: null,
    actions: openAction(url, 'Open Status'),
  }
}

function askRow(ask: Ask, host: string | null, nowMs: number): Row {
  const url = host ? `${base(host)}/?ask=${ask.id}` : ''
  return {
    id: `q:${ask.id}`,
    title: cut(ask.question, 200),
    body: cut(ask.body ?? '', 1000),
    severity: ask.blocking ? 'warning' : 'info',
    state: 'Needs your answer',
    ts: Math.floor(ask.createdAt / 1000),
    age: ageText(Math.max(0, (nowMs - ask.createdAt) / 1000)),
    url,
    item: ask.id,
    actions: [
      ...ask.options.slice(0, 6).map((option, index) => ({
        id: choiceId(index, option),
        label: cut(option, 40),
        tier: 'plain' as const,
      })),
      ...openAction(url, 'Open in Aico'),
    ],
  }
}

function approvalRow(tap: Approval): Row {
  return {
    id: `a:${tap.id}`,
    title: cut(tap.title, 200),
    body: `Approve with your security key within ${Math.max(1, Math.round(tap.expiresInS / 60))} min or deny.`,
    severity: 'warning',
    state: 'Needs you',
    ts: 0,
    age: `${Math.max(1, Math.round(tap.expiresInS / 60))} min left`,
    url: tap.url,
    item: null,
    actions: [{ id: 'approve', label: 'Approve', tier: 'key', url: tap.url }],
  }
}

function noticeRow(stored: StoredNotice, nowMs: number): Row {
  const { notice } = stored
  const open = notice.open && /^https:\/\//.test(notice.open) ? notice.open : ''
  return {
    id: `n:${stored.id}`,
    title: cut(notice.title, 200),
    body: cut(notice.body, 1000),
    severity: notice.severity,
    state: stored.answer ? `Answered: ${cut(stored.answer, 40)}` : '',
    ts: Math.floor(stored.receivedAt / 1000),
    age: `${ageText(Math.max(0, (nowMs - stored.receivedAt) / 1000))} ago`,
    url: open,
    item: stored.id,
    actions: [...openAction(open, 'Open'), { id: 'mark-read', label: 'Mark read', tier: 'view' }],
  }
}

// -- The drill -----------------------------------------------------------------------------

const drillFile = (dataDir: string) => join(releaseDir(dataDir), 'drill.json')

/** When the outage drill ends (epoch ms), or 0. */
export function drillUntil(dataDir: string, nowMs: number): number {
  try {
    const until = JSON.parse(readFileSync(drillFile(dataDir), 'utf8')).until
    return typeof until === 'number' && until > nowMs ? until : 0
  } catch {
    return 0
  }
}

/** Starts (minutes) or stops (null) the drill: health answers 503 until it ends. Returns the end (epoch ms) or 0. */
export function setDrill(dataDir: string, minutes: number | null, nowMs: number): number {
  const until =
    minutes === null ? 0 : nowMs + Math.min(Math.max(minutes, 1), DRILL_MAX_MIN) * 60_000
  mkdirSync(dirname(drillFile(dataDir)), { recursive: true, mode: 0o700 })
  writeFileSync(`${drillFile(dataDir)}.tmp`, JSON.stringify({ until, at: nowMs }))
  renameSync(`${drillFile(dataDir)}.tmp`, drillFile(dataDir))
  return until
}

// -- The API -------------------------------------------------------------------------------

function rawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new AppError(400, 'body too large'))
        req.destroy()
        return
      }
      parts.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => resolve(Buffer.concat(parts)))
  })
}

function jsonObject(body: Buffer): Record<string, unknown> {
  if (body.length === 0) return {}
  let value: unknown
  try {
    value = JSON.parse(body.toString('utf8'))
  } catch {
    throw new AppError(400, 'body is not JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AppError(400, 'body must be a JSON object')
  return value as Record<string, unknown>
}

interface Snapshot {
  needs_you: Row[]
  recent: Row[]
}

export class AppApi {
  /** Each live feed with the device that opened it. */
  private readonly streams = new Map<ServerResponse, string>()

  constructor(private readonly deps: AppApiDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /** The newest report of aico-web itself and of the host checks, as the older of the two (epoch s), or null. */
  private checkedAt(): number | null {
    const rows = this.deps.status.read().rows
    const newest = (match: (row: ShownRow) => boolean) =>
      rows.filter(match).reduce((max, row) => Math.max(max, Date.parse(row.updated_at)), 0)
    const web = newest((row) => row.id === `${this.deps.machine}/aico-web`)
    const checks = newest((row) => row.kind === 'check')
    const at = Math.min(web, checks)
    return at > 0 ? Math.floor(at / 1000) : null
  }

  health(phones: Phone[]): Record<string, unknown> {
    const nowMs = this.now()
    const checked = this.checkedAt()
    const confirmed = Math.max(0, ...phones.map((phone) => Number(phone.last_ack) || 0)) || null
    const why = phones.map(cantBuzz).find(Boolean)
    const line = `last check ${hhmm(checked, nowMs)}, ${
      why ? `phone can't buzz: ${why}` : `phone confirmed ${hhmm(confirmed, nowMs)}`
    }`
    return {
      ok: true,
      now: Math.floor(nowMs / 1000),
      checked_at: checked,
      phone_confirmed_at: confirmed,
      line,
    }
  }

  async snapshot(): Promise<Snapshot> {
    const nowMs = this.now()
    const host = this.deps.publicHost
    const rowAsks = this.deps.notify.rowAskIds()
    const [asks, approvals] = await Promise.all([
      this.deps.asks.list().catch(() => null),
      this.deps.asks.approvals().catch(() => null),
    ])
    const open = (asks ?? []).filter((ask) => ask.state === 'open' && !rowAsks.has(ask.id))
    open.sort((a, b) => Number(b.blocking) - Number(a.blocking) || a.createdAt - b.createdAt)
    const needs_you = [
      ...(approvals ?? []).map(approvalRow),
      ...this.deps.status
        .read()
        .rows.filter(counted)
        .map((row) => problemRow(row, host, nowMs)),
      ...open.map((ask) => askRow(ask, host, nowMs)),
    ]
    const asked = new Set(open.map((ask) => ask.id))
    const recent = this.deps.notify
      .list(200)
      .filter(
        (stored) =>
          stored.receivedAt >= nowMs - RECENT_MS &&
          stored.notice.push === 'phone' &&
          !(stored.askId && asked.has(stored.askId)),
      )
      .slice(0, RECENT_MAX)
      .map((stored) => noticeRow(stored, nowMs))
    return { needs_you, recent }
  }

  /** The button a row's `item` and action id name, done now. Answers `{ok, text}` or throws an AppError. */
  private async act(
    phone: Phone,
    kind: 'q' | 'n',
    id: string,
    action: string,
  ): Promise<Record<string, unknown>> {
    const choice = /^choice:(\d{1,2}):([0-9a-f]{8})$/.exec(action)
    if (choice && kind === 'q') {
      const asks = await this.deps.asks.list().catch(() => null)
      if (!asks) throw new AppError(503, "Aico can't read its questions now; nothing was done")
      const ask = asks.find((item) => item.id === id)
      if (!ask) throw new AppError(404, NOT_FOUND)
      const option = ask.options[Number(choice[1])]
      if (
        ask.state !== 'open' ||
        option === undefined ||
        choiceId(Number(choice[1]), option) !== action
      )
        throw new AppError(409, 'No longer open.')
      await this.deps.asks.answer(id, { option: Number(choice[1]) })
      return { ok: true, text: `Answered: ${option}.`, item: id }
    }
    if (kind === 'n') {
      const stored = this.deps.notify.get(id)
      if (!stored) throw new AppError(404, NOT_FOUND)
      if (action === 'mark-read' || action === 'done') {
        this.deps.notify.markRead([id], `phone:${phone.id.slice(0, 8)}`, this.now())
        return { ok: true, text: 'Marked read.', item: id }
      }
      throw new AppError(400, stored.notice.open ? 'open it instead' : 'not available from the app')
    }
    if (kind === 'q' && !choice) throw new AppError(400, 'open it instead')
    throw new AppError(404, NOT_FOUND)
  }

  /** One handler for the router: verifies the phone, answers `{error}` on a refusal. */
  private wrap(
    handler: (ctx: RequestContext, phone: Phone, body: Buffer, phones: Phone[]) => Promise<unknown>,
  ) {
    return async (ctx: RequestContext) => {
      try {
        const body = await rawBody(ctx.req)
        const phones = this.deps.phones.all()
        const phone = this.deps.phones.verify(
          ctx.req.method ?? 'GET',
          ctx.req.url ?? '',
          ctx.req.headers,
          body,
          Math.floor(this.now() / 1000),
        )
        const out = await handler(ctx, phone, body, phones ?? [])
        if (out === RAW) return RAW
        sendJson(ctx.res, 200, out)
      } catch (error) {
        if (error instanceof AppError) sendJson(ctx.res, error.status, { error: error.message })
        else {
          console.error(`[app] ${ctx.req.method} ${ctx.req.url} failed:`, error)
          sendJson(ctx.res, 500, { error: 'unexpected error' })
        }
      }
      return RAW
    }
  }

  register(router: Router): void {
    router.on(
      'GET',
      '/api/app/health',
      this.wrap(async (ctx, phone, _body, phones) => {
        await this.deps.phones.probed(
          phone.id,
          Math.floor(this.now() / 1000),
          Number(ctx.req.headers['x-nightshift-ts']),
        )
        if (drillUntil(this.deps.dataDir, this.now())) {
          sendJson(ctx.res, 503, { drill: true })
          return RAW
        }
        return this.health(phones)
      }),
    )
    router.on(
      'GET',
      '/api/app/items',
      this.wrap(async (_ctx, _phone, _body, phones) => {
        try {
          return { health: this.health(phones), ...(await this.snapshot()) }
        } catch (error) {
          console.error('[app] items failed:', error)
          throw new AppError(503, 'the list cannot be read now')
        }
      }),
    )
    router.on(
      'POST',
      '/api/app/token',
      this.wrap(async (_ctx, phone, body) => {
        const token = jsonObject(body).fcm_token
        if (typeof token !== 'string' || !token) throw new AppError(400, 'fcm_token required')
        await this.deps.phones.setToken(phone.id, token, Math.floor(this.now() / 1000))
        return { ok: true }
      }),
    )
    router.on(
      'POST',
      '/api/app/ack',
      this.wrap(async (_ctx, phone, body) => {
        await this.deps.phones.ack(phone.id, jsonObject(body), Math.floor(this.now() / 1000))
        return { ok: true }
      }),
    )
    router.on(
      'POST',
      '/api/app/items/:item/act',
      this.wrap(async (ctx, phone, body) => {
        const action = jsonObject(body).action
        if (typeof action !== 'string' || !action) throw new AppError(400, 'action required')
        const item = ctx.params.item as string
        // The item is an ask when its choice button is pressed, else a notice.
        return this.act(phone, action.startsWith('choice:') ? 'q' : 'n', item, action)
      }),
    )
    router.on(
      'POST',
      '/api/app/act',
      this.wrap(async (_ctx, phone, body) => {
        const { row, action } = jsonObject(body)
        const match = typeof row === 'string' ? /^([knaq]):(.+)$/.exec(row) : null
        if (!match || typeof action !== 'string' || !action)
          throw new AppError(400, 'row and action required')
        if (match[1] === 'q' || match[1] === 'n')
          return this.act(phone, match[1], match[2] as string, action)
        throw new AppError(409, 'open it instead')
      }),
    )
    router.on(
      'GET',
      '/api/app/update',
      this.wrap(async () => {
        const release = currentRelease(this.deps.dataDir)
        if (!release) throw new AppError(404, 'nothing is published')
        return { ...release, download: '/api/app/apk' }
      }),
    )
    router.on(
      'GET',
      '/api/app/apk',
      this.wrap(async (ctx) => {
        const release = currentRelease(this.deps.dataDir)
        if (!release) throw new AppError(404, 'nothing is published')
        ctx.res.statusCode = 200
        ctx.res.setHeader('Content-Type', 'application/vnd.android.package-archive')
        ctx.res.setHeader('Content-Length', release.size)
        createReadStream(apkPath(this.deps.dataDir)).pipe(ctx.res)
        return RAW
      }),
    )
    router.on(
      'GET',
      '/api/app/stream',
      this.wrap(async (ctx, phone) => {
        // One feed per phone, newest wins: a copy of an old request, or a connection the phone
        // lost without closing, never crowds out the phone's own new feed.
        this.closeStreams(phone.id)
        if (this.streams.size >= MAX_STREAMS) throw new AppError(429, 'too many live feeds')
        this.stream(ctx, phone.id)
        return RAW
      }),
    )
  }

  /**
   * The live feed. Nothing here is a replay buffer: `hello` first, and the phone re-reads the list
   * on it. After that an `item` event goes out when the list changes (checked every few seconds),
   * and a `health` event when health's words change. A Last-Event-ID that is no time this process
   * could have issued is answered with `reset`.
   */
  private stream(ctx: RequestContext, device: string): void {
    const { req, res } = ctx
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    })
    this.streams.set(res, device)
    const send = (event: string, data: unknown) =>
      res.write(`id: ${this.now()}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    res.write('retry: 3000\n\n')
    const last = req.headers['last-event-id']
    const lastMs = typeof last === 'string' ? Number(last) : null
    if (lastMs !== null && (!Number.isFinite(lastMs) || lastMs > this.now()))
      send('reset', { reason: 'unknown id' })
    send('hello', { now: Math.floor(this.now() / 1000) })

    let rev = ''
    let line = ''
    const watch = async () => {
      try {
        const snap = await this.snapshot()
        const next = createHash('sha256').update(JSON.stringify(snap)).digest('hex').slice(0, 12)
        const all = this.deps.phones.all()
        // A phone that was unpaired (or whose file entry is gone) loses its feeds at the next tick.
        if (all && !all.some((phone) => phone.id === device)) {
          this.closeStreams(device)
          return
        }
        const phones = all ?? []
        const nextLine = String(this.health(phones).line)
        if (rev && next !== rev) send('item', { rev: next })
        if (line && nextLine !== line) send('health', { line: nextLine })
        rev = next
        line = nextLine
      } catch (error) {
        console.error('[app] live feed check failed:', error)
      }
    }
    void watch()
    const keep = setInterval(() => res.write(': keepalive\n\n'), KEEPALIVE_MS)
    const poll = setInterval(() => void watch(), this.deps.watchMs ?? WATCH_MS)
    const end = () => {
      clearInterval(keep)
      clearInterval(poll)
      this.streams.delete(res)
    }
    res.on('close', end)
    res.on('error', end)
  }

  /** Ends every live feed `device` has open. */
  private closeStreams(device: string): void {
    for (const [res, owner] of this.streams) {
      if (owner !== device) continue
      this.streams.delete(res)
      res.end()
    }
  }

  stop(): void {
    for (const res of this.streams.keys()) res.end()
  }
}
