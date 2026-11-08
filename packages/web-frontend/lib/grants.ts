// The Grants page's words: which requests are live (Active) and which are over (History).

import { formatClock, formatWhen } from './capture-format'

export interface GrantRequest {
  id: string
  title: string
  reason: string
  agent: string
  state: string
  /** Seconds since the epoch. */
  expires: number
  /** When it was ended or withdrawn, in seconds. */
  ended?: number
}

export interface GrantUse {
  at: number
  event: string
  id: string
  kind: string
  uid: number
}

export interface GrantsView {
  requests: GrantRequest[]
  uses: GrantUse[]
  labels: Record<string, string>
}

export type GrantKind =
  | 'open'
  | 'waiting'
  | 'ended'
  | 'expired'
  | 'withdrawn'
  | 'denied'

export interface GrantItem {
  request: GrantRequest
  kind: GrantKind
  /** The chip's word. */
  chip: string
  /** The second line: the state and when, in the tense it is in. */
  when: string
  title: string
  /** It can still be withdrawn or ended. */
  live: boolean
}

/** The request as a statement once it's not a question any more: "Your main Chrome for 15 min". */
export function statement(title: string): string {
  const text = title.replace(/\?\s*$/, '').replace(/^Open\s+/i, '')
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : title
}

/** Where a request stands now. Past its expiry, nothing is waiting or open any more. */
function classify(
  request: GrantRequest,
  approved: ReadonlySet<string>,
  now: number,
): GrantItem {
  const expiresMs = request.expires * 1000
  const endedMs = (request.ended ?? request.expires) * 1000
  const live = expiresMs > now
  const wasApproved = approved.has(request.id) || request.state === 'approved'
  const make = (
    kind: GrantKind,
    chip: string,
    when: string,
    isLive = false,
  ): GrantItem => ({
    request,
    kind,
    chip,
    when,
    title: kind === 'waiting' ? request.title : statement(request.title),
    live: isLive,
  })
  switch (request.state) {
    case 'approved':
      return live
        ? make('open', 'Open', `Ends ${formatWhen(expiresMs, now)}`, true)
        : make('ended', 'Ended', `Ended ${formatWhen(expiresMs, now)}`)
    case 'pending':
      return live
        ? make(
            'waiting',
            'Waiting',
            `Waiting for your tap in the Nightshift or Aico tray. Expires ${formatWhen(expiresMs, now)}`,
            true,
          )
        : make(
            'expired',
            'Expired',
            `Expired ${formatWhen(expiresMs, now)}. Nobody tapped`,
          )
    case 'revoked':
      return wasApproved
        ? make('ended', 'Ended', `Ended by you ${formatWhen(endedMs, now)}`)
        : make(
            'withdrawn',
            'Withdrawn',
            `Withdrawn ${formatWhen(endedMs, now)}`,
          )
    case 'denied':
      return make('denied', 'Denied', `Denied ${formatWhen(endedMs, now)}`)
    case 'expired':
      return wasApproved
        ? make(
            'ended',
            'Ended',
            `Ended ${formatWhen(expiresMs, now)}. Time ran out`,
          )
        : make(
            'expired',
            'Expired',
            `Expired ${formatWhen(expiresMs, now)}. Nobody tapped`,
          )
    default:
      return make(
        'ended',
        request.state.charAt(0).toUpperCase() + request.state.slice(1),
        `${request.state.charAt(0).toUpperCase() + request.state.slice(1)} ${formatWhen(endedMs, now)}`,
      )
  }
}

/** Active (open and waiting, soonest to end first) and History (newest first). */
export function splitGrants(
  view: Pick<GrantsView, 'requests' | 'uses'>,
  now: number,
): { active: GrantItem[]; history: GrantItem[] } {
  const approved = new Set(
    view.uses.filter((u) => u.event === 'approved').map((u) => u.id),
  )
  const items = view.requests.map((r) => classify(r, approved, now))
  const active = items
    .filter((i) => i.kind === 'waiting' || i.kind === 'open')
    .sort((a, b) => a.request.expires - b.request.expires)
  const history = items
    .filter((i) => i.kind !== 'waiting' && i.kind !== 'open')
    .sort(
      (a, b) =>
        (b.request.ended ?? b.request.expires) -
        (a.request.ended ?? a.request.expires),
    )
  return { active, history }
}

/** "1 waiting for you · none open", "Nothing open or waiting". */
export function grantsLine(active: GrantItem[]): string {
  const waiting = active.filter((i) => i.kind === 'waiting').length
  const open = active.length - waiting
  if (!active.length) return 'Nothing open or waiting.'
  return `${waiting ? `${waiting} waiting for your tap` : 'Nothing waiting'} · ${open ? `${open} open` : 'none open'}`
}

/**
 * What a grant's own use looked like, in a sentence for its open row. Agents check in every
 * half minute or so while a grant is open, so the raw uses fold into one line: the span and the count.
 * Null when the use isn't worth saying (a request nobody approved).
 */
export function grantUseLine(
  item: GrantItem,
  uses: readonly GrantUse[],
  now: number,
): string | null {
  const mine = uses
    .filter((u) => u.event === 'use' && u.id === item.request.id)
    .map((u) => u.at * 1000)
  if (mine.length === 0) {
    return item.kind === 'open' || item.kind === 'ended'
      ? 'Nothing used it.'
      : null
  }
  const first = Math.min(...mine)
  const last = Math.max(...mine)
  if (mine.length === 1) return `Used once, at ${formatWhen(first, now)}.`
  const sameDay =
    new Date(first).toDateString() === new Date(last).toDateString()
  const span = sameDay
    ? `${formatClock(first)} to ${formatClock(last)}`
    : `${formatWhen(first, now)} to ${formatWhen(last, now)}`
  return `Used ${span} (${mine.length} checks).`
}
