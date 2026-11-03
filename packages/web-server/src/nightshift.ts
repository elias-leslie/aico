// The Health panel's source: Nightshift's item store (its GET /api/items,
// docs/adr/0005 in Nightshift), read server-side on loopback and composed into
// the owner view the panel has always read (version 1, tiles[]), exactly as
// Nightshift's items/present.py api_view() builds it. Read-only: decisions and
// approvals stay in Nightshift. When Nightshift does not answer, cannot read
// its store, or its words are too old, the panel is told so and shows
// unknown, never OK.
//
//   GET /api/nightshift/view -> {available: true, view} | {available: false, reason}

import type { Router } from './http'

export interface NightshiftConfig {
  /** Nightshift's own web server, loopback; null turns the panel off. */
  nightshiftUrl: string | null
}

/** The item API version this reader understands (Nightshift items/present.py API_V). */
export const NIGHTSHIFT_ITEMS_VERSION = 1
/** The owner view version the panel reads (packages/web-frontend lib/health.ts). */
export const NIGHTSHIFT_VIEW_VERSION = 1
const TIMEOUT_MS = 5_000

export type NightshiftUnavailable =
  | 'not_configured'
  | 'not_answering'
  | 'unexpected'
  | 'store_refused'
  | 'store_stale'

export type NightshiftView =
  | { available: true; view: Record<string, unknown> }
  | { available: false; reason: NightshiftUnavailable }

type Row = Record<string, unknown>
type Placed = { pos: number; row: Row }

const isObject = (value: unknown): value is Row =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

/** Nightshift view.age_text: `5m`, `3h`, `4d`. */
function ageText(seconds: number): string {
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m`
  if (seconds < 86400 * 2) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}

/** present._aged: a row's age and time left, moved on from when its words were computed. */
function aged(row: Row, dt: number): Row {
  const out = { ...row }
  if (isNumber(row.age)) {
    const age = row.age + dt
    out.age = age
    if ('age_text' in out) out.age_text = ageText(age)
  }
  if (isNumber(row.left)) {
    const left = row.left - dt
    out.left = left
    if ('left_text' in out) out.left_text = `${Math.max(1, Math.round(left / 60))} min left`
  }
  return out
}

const placed = (value: unknown): value is Placed =>
  isObject(value) && isNumber(value.pos) && isObject(value.row)

/** present.findings: one board row per pos (the first item's wins), unattached rows after, by pos. */
function findings(items: Row[], loose: unknown[], dt: number): Row[] {
  const seen = new Map<number, Row>()
  const add = (f: unknown) => {
    if (placed(f) && !seen.has(f.pos)) seen.set(f.pos, f.row)
  }
  for (const it of items) add((it.words as Row | undefined)?.finding)
  for (const f of loose) add(f)
  return [...seen.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, r]) => {
      const out = aged(r, dt)
      if (isNumber(r.checked)) out.checked = r.checked + dt
      return out
    })
}

/** present.inbox's approvals, as api_view() lists them: by pos, still open. */
function approvals(items: Row[], loose: unknown[], dt: number): Row[] {
  const rows: Placed[] = []
  const add = (t: unknown) => {
    if (placed(t) && (t as Row).section === 'approvals') rows.push(t)
  }
  for (const it of items) add((it.words as Row | undefined)?.tray)
  for (const t of loose) add(t)
  return rows
    .sort((a, b) => a.pos - b.pos)
    .map(({ row }) => row)
    .filter((a) => !isNumber(a.left) || a.left - dt > 0)
    .map((a) => {
      const row = aged(a, dt)
      return { id: row.id, title: row.title, url: row.open, left: row.left }
    })
}

const LIVE_STATES = new Set(['needs_you', 'open', 'on_it', 'unknown'])
const OTHER_KINDS = new Set(['alert', 'todo'])

/** Open items that are not a host check's finding and not an approval: an agent's or a project's alert or to-do, and
 * Nightshift's own floor and delivery alarms (the sheet's heading says "not from host checks", not who sent them).
 * The board lists host findings only, so these were invisible here. Most urgent first, then oldest. */
function others(items: Row[], now: number): Row[] {
  const rank = (state: unknown) => LIVE_STATES.size - [...LIVE_STATES].indexOf(String(state))
  return items
    .filter((it) => {
      const words = isObject(it.words) ? it.words : {}
      const tray = isObject(words.tray) ? words.tray : {}
      return (
        LIVE_STATES.has(String(it.state)) &&
        OTHER_KINDS.has(String(it.kind)) &&
        typeof it.title === 'string' &&
        !words.finding &&
        !(tray.section === 'approvals')
      )
    })
    .sort(
      (a, b) =>
        rank(b.state) - rank(a.state) || Number(a.created_at ?? 0) - Number(b.created_at ?? 0),
    )
    .map((it) => ({
      id: String(it.id),
      title: it.title,
      source: typeof it.source === 'string' ? it.source : '',
      state: it.state,
      severity: typeof it.severity === 'string' ? it.severity : '',
      age: isNumber(it.created_at) ? Math.max(0, now - it.created_at) : null,
      link: typeof it.open === 'string' && it.open.startsWith('https://') ? it.open : '',
    }))
}

/** The owner view (version 1, tiles[]) from GET /api/items?list=all, as present.api_view() builds it. */
export function composeView(body: Row, now: number): Record<string, unknown> {
  const surface = isObject(body.surface) ? body.surface : {}
  const board = isObject(surface.board) ? surface.board : {}
  const unattached = isObject(body.unattached) ? body.unattached : {}
  const items = (Array.isArray(body.items) ? body.items : []).filter(isObject)
  const wordsAt = isNumber(body.words_at) ? body.words_at : 0
  const dt = wordsAt ? Math.max(0, now - wordsAt) : 0
  const list = (value: unknown) => (Array.isArray(value) ? value : [])
  return {
    version: NIGHTSHIFT_VIEW_VERSION,
    // The snapshot's age was true when the words were computed; move it on like every other age here.
    snapshot:
      isObject(board.snapshot) && isNumber(board.snapshot.age)
        ? { ...board.snapshot, age: board.snapshot.age + dt }
        : (board.snapshot ?? null),
    generated_at: board.generated_at ?? null,
    verdict: board.verdict ?? null,
    tiles: list(board.tiles),
    hosts: list(board.hosts),
    findings: findings(items, list(unattached.findings), dt),
    needs_you: board.needs_you ?? 0,
    approvals: approvals(items, list(unattached.tray), dt),
    others: others(items, now),
    links: isObject(board.links) ? board.links : {},
  }
}

export async function readNightshiftView(
  config: NightshiftConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<NightshiftView> {
  if (!config.nightshiftUrl) return { available: false, reason: 'not_configured' }
  let response: Response
  try {
    response = await fetchImpl(`${config.nightshiftUrl.replace(/\/+$/, '')}/api/items?list=all`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (error) {
    console.error('[aico-web] Nightshift unreachable:', (error as Error).message)
    return { available: false, reason: 'not_answering' }
  }
  if (response.status === 503) {
    const why = await response
      .json()
      .then((b: unknown) => (isObject(b) ? b.error : undefined))
      .catch(() => undefined)
    console.error(`[aico-web] Nightshift can't read its item store: ${why ?? '503'}`)
    return { available: false, reason: 'store_refused' }
  }
  if (!response.ok) {
    console.error(`[aico-web] Nightshift /api/items answered ${response.status}`)
    return { available: false, reason: 'not_answering' }
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    body = null
  }
  if (
    !isObject(body) ||
    body.v !== NIGHTSHIFT_ITEMS_VERSION ||
    !Array.isArray(body.items) ||
    !isObject(body.surface) ||
    !isObject(body.surface.board) ||
    !Array.isArray(body.surface.board.tiles) ||
    !isObject(body.surface.board.snapshot)
  ) {
    console.error('[aico-web] Nightshift /api/items: not a list this version reads')
    return { available: false, reason: 'unexpected' }
  }
  if (body.stale != null) {
    const why = isObject(body.stale) ? body.stale.why : body.stale
    console.error(`[aico-web] Nightshift's item store words are not current: ${String(why)}`)
    return { available: false, reason: 'store_stale' }
  }
  const now = isNumber(body.at) ? body.at : Date.now() / 1000
  return { available: true, view: composeView(body, now) }
}

export function registerNightshiftRoutes(
  router: Router,
  config: NightshiftConfig,
  fetchImpl: typeof fetch = fetch,
): void {
  router.on('GET', '/api/nightshift/view', () => readNightshiftView(config, fetchImpl))
}
