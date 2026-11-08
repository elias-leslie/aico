// What the desktop tray reads and writes (native/tray). Loopback only: the tray runs on this
// machine, and the public host reaches this server through a proxy on loopback (guard.ts).
//
//   GET  /api/tray              the tray's whole picture in one read: the panel's lists, the badge
//                               summary, and the notice log with its read marks.
//   POST /api/tray/seen         {ids?, all?, at?, via?}: the owner read these, or pressed Mark all read.
//   GET  /api/tray/notice/:id   one notice (or one waiting question) as the tray's card shows it.
//
// What counts, owner rule 2026-11-03: open Status problems, and agent reports nobody has read.
// Anything that ended on its own (a Status row that recovered, a notice followed by an "ok" under
// the same key, one past its expiry) leaves the tray and counts as nothing; it stays on the Status
// page. Needs you stays what the tray's Questions list shows: the open Tether asks, except the ones
// that stand for a failing Status row (those are the row itself).

import { type NotifyStore, popsUp, type StoredNotice } from '@aico/notify'
import { counted, type ShownRow, type StatusStore, type StatusView } from '@aico/status'
import type { Approval, Ask } from './asks'
import { fromThisMachine } from './guard'
import { objectBody, type Router } from './http'
import { HttpError } from './tether'

const HEX12 = /^[0-9a-f]{12}$/
const DAY_MS = 86_400_000
/** The tray looks back this far; older notices are on the phone and nowhere else. */
const LOOKBACK_MS = 7 * DAY_MS
/** The notices a read lists (the tray shows a few corner cards at most). */
const LOG_MAX = 60
/** Words kept in the health line (the tray cuts at 200 characters). */
const HEALTH_MAX = 200
const ASK_TITLE = 'An agent is waiting on you'
const SEVERE = new Set(['warning', 'critical'])

/**
 * How the owner reads each kind of access grant. These words belong to the grants (M5b moves
 * them there); the tray labels an open grant with them until then.
 */
const GRANT_LABELS = {
  'github-admin': 'GitHub admin',
  'owner-chrome': 'your main Chrome',
  'owner-email': 'your email inbox',
}

/** The approval kind a host-grant link (`/grants?request=<id>`) opens; the tray's card is for this kind. */
const APPROVE_KIND: Record<string, string> = {
  grants: 'elevate',
}

interface Action {
  id: string
  label: string
  tier: 'key' | 'plain' | 'view'
  hint: string
  primary?: boolean
  [more: string]: unknown
}

export interface TrayInput {
  /** Epoch ms. */
  now: number
  publicHost: string | null
  status: StatusView
  /** Newest first. */
  notices: StoredNotice[]
  marks: { readAllAt: number; reads: Map<string, number> }
  /** Null: Tether could not be read (`askError` says why). */
  asks: Ask[] | null
  askError: string | null
  /** Tether asks that stand for failing Status rows. */
  rowAsks: ReadonlySet<string>
  /** Null: the pending host grants could not be read. */
  approvals: Approval[] | null
}

// -- Words --------------------------------------------------------------------------

/** The website's short age: 5m, 3h, 2d. */
export function ageText(seconds: number): string {
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m`
  if (seconds < 2 * 86_400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86_400)}d`
}

const STATE_WORD: Record<string, string> = {
  failed: 'failed',
  warn: 'warning',
  late: 'late',
  unknown: 'unknown',
}

const cut = (text: string, max: number) =>
  [...text].length <= max ? text : `${[...text].slice(0, max - 1).join('')}…`

function problemTitle(row: ShownRow): string {
  return `${row.what} ${STATE_WORD[row.shown] ?? row.shown}`
}

/** One line for the tray's header and the panel: what is wrong, or that nothing is. */
function healthLine(view: StatusView, problems: ShownRow[]): string {
  if (view.rows.length === 0) return 'Status has no rows yet'
  if (problems.length === 0) return `Everything is fine · ${view.summary.healthy} healthy`
  const names = problems.slice(0, 3).map(problemTitle).join(', ')
  const more = problems.length > 3 ? ` +${problems.length - 3} more` : ''
  const count = problems.length === 1 ? '1 problem' : `${problems.length} problems`
  return cut(`${count}: ${names}${more}`, HEALTH_MAX)
}

// -- Which notices the tray lists -----------------------------------------------------

/** A Status alert (the phone rule's notice): it repeats a Status row, which the tray counts itself. */
function isStatusAlert(notice: StoredNotice['notice'], publicHost: string | null): boolean {
  return (
    notice.source === 'aico' &&
    notice.kind === 'alert' &&
    publicHost !== null &&
    notice.open === `https://${publicHost}/status`
  )
}

const expired = (stored: StoredNotice, now: number) =>
  stored.notice.expires !== undefined && stored.receivedAt + stored.notice.expires * 1000 < now

/** When a later "ok" under the same source and key ended it (epoch ms), else null. */
function endedAt(stored: StoredNotice, all: readonly StoredNotice[]): number | null {
  const { key, source } = stored.notice
  if (!key) return null
  let at: number | null = null
  for (const other of all) {
    if (other.notice.source !== source || other.notice.key !== key) continue
    if (other.notice.severity !== 'ok' || other.receivedAt <= stored.receivedAt) continue
    if (at === null || other.receivedAt < at) at = other.receivedAt
  }
  return at
}

// -- Links ----------------------------------------------------------------------------

const base = (host: string | null) => (host ? `https://${host}` : '')
const statusUrl = (host: string | null) => (host ? `${base(host)}/status` : '')
const askUrl = (host: string | null, id: string) => (host ? `${base(host)}/?ask=${id}` : '')

function openAction(url: string, label: string, hint: string, primary = false): Action[] {
  return url ? [{ id: 'open', label, tier: 'view', hint, primary, url }] : []
}

const markRead = (id: string): Action => ({
  id: 'mark-read',
  label: 'Mark read',
  tier: 'view',
  hint: 'Clears it from new. Changes nothing else.',
  primary: false,
  ids: [id],
})

// -- Cards ----------------------------------------------------------------------------

/** A notice as the tray's card shows it (notice.rs): what happened, the details, what to run. */
function noticeCard(stored: StoredNotice): Record<string, unknown> {
  const { notice } = stored
  const details = [
    ...(notice.detail ? [notice.detail] : []),
    ...notice.fields.map((field) => `${field.label}: ${field.value}`),
    ...(notice.if_ignored ? [`If you leave it: ${notice.if_ignored}`] : []),
  ]
  const sent = stored.deliveries.filter((d) => d.state === 'sent').length
  const open = notice.open && /^https:\/\//.test(notice.open) ? notice.open : ''
  return {
    id: stored.id,
    title: notice.title,
    body: notice.body,
    kind: notice.source === 'aico' ? 'From Aico' : `From ${notice.source}`,
    ts: stored.receivedAt / 1000,
    delivery: stored.deliveries.length
      ? `delivered to ${sent} of ${stored.deliveries.length} phone${stored.deliveries.length === 1 ? '' : 's'}`
      : '',
    now: null,
    current: [],
    who: '',
    snapshot: '',
    details,
    commands: notice.command ? [notice.command] : [],
    links: open ? [{ label: 'Open', url: open }] : [],
    actions: [...openAction(open, 'Open', 'Where this came from.'), markRead(stored.id)],
  }
}

function askCard(ask: Ask, host: string | null): Record<string, unknown> {
  return {
    id: ask.id,
    title: ASK_TITLE,
    body: 'A session has a question for you.',
    kind: 'A question from an agent',
    ts: ask.createdAt / 1000,
    delivery: '',
    now: null,
    current: [],
    who: '',
    snapshot: '',
    details: [],
    commands: [],
    links: askUrl(host, ask.id) ? [{ label: 'Open in Aico', url: askUrl(host, ask.id) }] : [],
    actions: [
      ...openAction(askUrl(host, ask.id), 'Open in Aico', 'The question in Aico.', true),
      markRead(ask.id),
    ],
  }
}

// -- The read --------------------------------------------------------------------------

/** A waiting question is shown in the corner once, as the push for it was. */
const toastAsk = (ask: Ask) => ask.blocking && ask.state === 'open'

export function buildTray(input: TrayInput): Record<string, unknown> {
  const { now, publicHost: host, status, marks } = input
  const seconds = (ms: number) => ms / 1000
  const problems = status.rows.filter(counted)
  const readAt = (id: string, at: number) => marks.reads.has(id) || at <= marks.readAllAt

  // Needs you: the open Status problems, worst first (the view's own order).
  const needs = problems.map((row) => ({
    key: row.id,
    kind: 'problem',
    severity: row.shown === 'failed' ? 'critical' : 'warning',
    title: problemTitle(row),
    text: [row.meaning],
    host: row.machine,
    age: null,
    age_text: '',
    notice: null,
    unread: [] as string[],
    open: statusUrl(host),
    card: null,
    lookinto: null,
    actions: openAction(
      statusUrl(host),
      'Open Status',
      'The Status page, where it can be run or looked into.',
      true,
    ),
    answered: '',
  }))

  // Approvals: the pending host grants; the tray's Approve opens its card and the key signs there.
  const approvals = (input.approvals ?? []).flatMap((tap) => {
    const kind = APPROVE_KIND[new URL(tap.url).pathname.split('/')[1] ?? ''] ?? ''
    if (!kind) return []
    return [
      {
        id: tap.id,
        kind,
        title: tap.title,
        body: `Approve with your security key within ${Math.max(1, Math.round(tap.expiresInS / 60))} min or deny.`,
        left: tap.expiresInS,
        left_text: `${Math.max(1, Math.round(tap.expiresInS / 60))} min left`,
        open: tap.url,
        notice: null,
        actions: [
          {
            id: 'approve',
            label: 'Approve',
            tier: 'key',
            hint: 'Opens the approval card: approve or deny there; your security key confirms either.',
            primary: true,
            approve: { request: tap.id, kind },
          },
          ...openAction(tap.url, 'Open', 'Where this item lives.'),
        ],
      },
    ]
  })

  // Questions: the open Tether asks, blocking first, then oldest; a failing row's own ask is the row.
  const open = (input.asks ?? []).filter((ask) => ask.state === 'open')
  const questions = open
    .filter((ask) => !input.rowAsks.has(ask.id))
    .sort((a, b) => Number(b.blocking) - Number(a.blocking) || a.createdAt - b.createdAt)
    .map((ask) => {
      const age = Math.max(0, seconds(now - ask.createdAt))
      const link = askUrl(host, ask.id)
      return {
        id: ask.id,
        key: `ask:${ask.id}`,
        source: 'aico',
        kind: 'question',
        severity: ask.blocking ? 'warning' : 'info',
        title: ask.question,
        text: ask.body ? [ask.body] : [],
        age,
        age_text: ageText(age),
        open: link,
        unread: [] as string[],
        test: false,
        actions: openAction(
          link,
          'Open in Aico',
          'The question in Aico, where you can also answer in your own words.',
        ),
        question: ask.question,
        options: ask.options,
        recommended: ask.recommended,
        body: ask.body,
        command: ask.command,
        requester: ask.requester,
        session: ask.session,
        blocking: ask.blocking,
        state: 'open',
        answer: null,
        note: null,
        createdAt: ask.createdAt,
        answeredAt: null,
      }
    })

  // The notice log the corner cards and the unread count read, oldest first.
  // Every notice in the lookback decides what is unread and what ended; only the log is cut.
  const recent = input.notices.filter((stored) => stored.receivedAt >= now - LOOKBACK_MS)
  const log: Record<string, unknown>[] = []
  const ended = new Map<string, number | null>()
  for (const stored of recent) {
    const { notice } = stored
    ended.set(stored.id, expired(stored, now) ? now : endedAt(stored, recent))
    // The log is what the corner cards and the unread count read, so it holds only what pops up
    // (popsUp in packages/notify phone.ts). An info or ok notice, such as "nothing left to do",
    // already did its job by ending the earlier notice above; it is not a new item.
    if (!popsUp(notice) || log.length >= LOG_MAX) continue
    log.push({
      id: stored.id,
      ts: seconds(stored.receivedAt),
      kind: 'manual',
      severity: notice.severity,
      title: notice.title,
      body: notice.body,
      key: notice.key ?? '',
      result: 'sent',
      refs: notice.open ? { open: notice.open } : {},
    })
  }
  for (const ask of open.filter((a) => toastAsk(a) && !input.rowAsks.has(a.id))) {
    log.push({
      id: ask.id,
      ts: seconds(ask.createdAt),
      kind: 'manual',
      severity: 'warning',
      title: ASK_TITLE,
      body: `${ask.requester ?? 'A session'} has a question for you. Open Aico to answer it.`,
      key: `ask:${ask.id}`,
      result: 'sent',
      refs: { open: askUrl(host, ask.id) },
    })
  }
  for (const tap of input.approvals ?? []) {
    const kind = APPROVE_KIND[new URL(tap.url).pathname.split('/')[1] ?? ''] ?? ''
    if (kind)
      log.push({
        id: tap.id.slice(0, 12),
        ts: seconds(now),
        kind: 'approve',
        severity: 'warning',
        title: tap.title,
        body: '',
        key: `approve:${kind}:${tap.id}`,
        result: 'sent',
        refs: {},
      })
  }
  log.sort((a, b) => (a.ts as number) - (b.ts as number))

  // Agent reports: warnings and criticals nobody read and that did not end on their own. A notice
  // that asks something is a question (its ask), and a Status alert is the Status row.
  const reports = recent.filter(({ id, notice, askId, receivedAt }) => {
    return (
      SEVERE.has(notice.severity) &&
      askId === null &&
      !isStatusAlert(notice, host) &&
      !readAt(id, receivedAt) &&
      ended.get(id) === null
    )
  })
  const notifications = reports.map((stored) => {
    const card = noticeCard(stored)
    return {
      id: stored.id,
      kind: 'manual',
      severity: stored.notice.severity,
      title: stored.notice.title,
      body: stored.notice.body,
      pills: [] as unknown[],
      asked: '',
      pushes: stored.repeats + 1,
      ts: seconds(stored.receivedAt),
      unread: [stored.id],
      open: stored.notice.open ?? '',
      ask: null,
      card,
      lookinto: null,
      actions: card.actions,
    }
  })

  const marksOut = {
    read_all_at: seconds(marks.readAllAt),
    pushes: log.map((entry) => {
      const id = entry.id as string
      const read = marks.reads.get(id)
      const over = ended.get(id)
      return {
        id,
        ts: entry.ts,
        read_at: read === undefined ? null : seconds(read),
        over_at: over === undefined || over === null ? null : seconds(over),
        push: entry,
      }
    }),
  }

  const askUnknown =
    input.asks === null ? `Tether can't be read (${input.askError ?? 'no answer'})` : null
  const snapshot = status.rows.length === 0 ? 'missing' : 'fresh'
  const health = healthLine(status, problems)
  const url = statusUrl(host)
  return {
    version: 1,
    at: seconds(now),
    snapshot,
    health,
    needs,
    approvals,
    questions,
    questions_unknown: askUnknown,
    notifications,
    more: 0,
    counts: {
      needs: needs.length,
      approvals: approvals.length,
      board: needs.length + approvals.length,
      questions: questions.length,
      unread: notifications.length,
      open: 0,
      reports: notifications.length,
      ended_today: 0,
    },
    elsewhere: 'Open the Status page',
    links: { dashboard: url, needs_you: url, notices: url },
    // The badge: the same problems the Status page and the phone count.
    summary: {
      needs_you: needs.length,
      snapshot,
      health,
      grant_labels: GRANT_LABELS,
      unread_rows: notifications.map((row) => row.unread),
    },
    read_marks: marksOut,
  }
}

// -- Routes ----------------------------------------------------------------------------

export interface TrayDeps {
  status: Pick<StatusStore, 'read'>
  notify: Pick<NotifyStore, 'list' | 'get' | 'readMarks' | 'rowAskIds' | 'markRead' | 'markAllRead'>
  asks: { list(): Promise<Ask[]>; approvals(): Promise<Approval[] | null> }
  publicHost: string | null
  now?: () => number
}

function requireThisMachine(req: Parameters<typeof fromThisMachine>[0]): void {
  if (!fromThisMachine(req))
    throw new HttpError(403, 'The tray reads and writes here only, from this machine (loopback)')
}

export function registerTrayRoutes(router: Router, deps: TrayDeps): void {
  const now = () => (deps.now ?? Date.now)()

  router.on('GET', '/api/tray', async (ctx) => {
    requireThisMachine(ctx.req)
    let asks: Ask[] | null = null
    let askError: string | null = null
    try {
      asks = await deps.asks.list()
    } catch (error) {
      askError = error instanceof Error ? error.message : String(error)
    }
    const approvals = await deps.asks.approvals().catch(() => null)
    return buildTray({
      now: now(),
      publicHost: deps.publicHost,
      status: deps.status.read(),
      notices: deps.notify.list(200),
      marks: deps.notify.readMarks(),
      asks,
      askError,
      rowAsks: deps.notify.rowAskIds(),
      approvals,
    })
  })

  router.on('POST', '/api/tray/seen', async (ctx) => {
    requireThisMachine(ctx.req)
    const body = objectBody(await ctx.body())
    const via = typeof body.via === 'string' && /^[a-z-]{1,20}$/.test(body.via) ? body.via : 'tray'
    if (body.all === true) {
      const at = body.at === undefined ? now() : Number(body.at) * 1000
      if (!Number.isFinite(at) || at < 0) throw new HttpError(422, 'at is a time in seconds')
      deps.notify.markAllRead(Math.min(at, now()))
    }
    const ids = Array.isArray(body.ids) ? body.ids : []
    if (!ids.every((id) => typeof id === 'string' && HEX12.test(id)))
      throw new HttpError(422, 'ids are 12-character notice ids')
    if (ids.length > 100) throw new HttpError(422, 'At most 100 ids at a time')
    deps.notify.markRead(ids as string[], via, now())
    return { read: ids.length, all: body.all === true }
  })

  router.on('GET', '/api/tray/notice/:id', async (ctx) => {
    requireThisMachine(ctx.req)
    const id = ctx.params.id as string
    if (!HEX12.test(id)) throw new HttpError(404, 'No such notice')
    const stored = deps.notify.get(id)
    if (stored) return noticeCard(stored)
    const ask = (await deps.asks.list().catch(() => [])).find((item) => item.id === id)
    if (ask) return askCard(ask, deps.publicHost)
    throw new HttpError(404, 'No such notice')
  })
}
