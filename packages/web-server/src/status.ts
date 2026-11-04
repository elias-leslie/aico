// Status rows over HTTP, and the rows aico-web writes about itself.
//
//   GET    /api/status          the rows as a reader sees them (late and unknown applied), problems
//                               first, plus the rollup, the badge summary, this machine's id and
//                               the rows whose run ref is going now (`running`).
//                               Filters: state, kind, machine, project (comma lists), q (text),
//                               sort (problems, what, updated, next).
//   POST   /api/status/rows     one row or a list (contracts/status-row.schema.json), all or none.
//   DELETE /api/status/rows?id= drops a row whose thing is gone.
//
// Writes come only from programs on this machine (guard.ts fromThisMachine): the public host
// reaches this server through a proxy on loopback, so the page can read rows but never write them.

import {
  type Filter,
  KINDS,
  type Kind,
  parseRow,
  RowError,
  SHOWN,
  type Shown,
  SORTS,
  type Sort,
  type StatusRow,
  type StatusStore,
} from '@aico/status'
import { fromThisMachine } from './guard'
import type { Router } from './http'
import { HttpError } from './tether'

/** Most rows one POST may carry. */
const MAX_ROWS_PER_POST = 500

function list<T extends string>(
  query: URLSearchParams,
  name: string,
  allowed?: readonly T[],
): T[] | undefined {
  const raw = query.get(name)
  if (!raw) return undefined
  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  const wrong = allowed && values.find((value) => !(allowed as readonly string[]).includes(value))
  if (wrong) throw new HttpError(422, `${name} must be among ${allowed.join(', ')} (got ${wrong})`)
  return values as T[]
}

export function filterFrom(query: URLSearchParams): Filter {
  const sort = query.get('sort') || undefined
  if (sort && !(SORTS as readonly string[]).includes(sort))
    throw new HttpError(422, `sort must be one of ${SORTS.join(', ')}`)
  return {
    state: list<Shown>(query, 'state', SHOWN),
    kind: list<Kind>(query, 'kind', KINDS),
    machine: list(query, 'machine'),
    project: list(query, 'project'),
    search: query.get('q') || undefined,
    sort: sort as Sort | undefined,
  }
}

function parseRows(body: unknown): StatusRow[] {
  const items = Array.isArray(body) ? body : [body]
  if (items.length === 0 || items.length > MAX_ROWS_PER_POST)
    throw new HttpError(422, `Post 1 to ${MAX_ROWS_PER_POST} rows`)
  return items.map((item, index) => {
    try {
      return parseRow(item)
    } catch (error) {
      if (!(error instanceof RowError)) throw error
      const where = Array.isArray(body) ? `rows[${index}].` : ''
      throw new HttpError(422, `${where}${error.field}: ${error.message}`)
    }
  })
}

function requireThisMachine(req: Parameters<typeof fromThisMachine>[0]): void {
  if (!fromThisMachine(req))
    throw new HttpError(403, 'Status rows are written only by programs on this machine (loopback)')
}

/** Told of each write (Needs you raises or withdraws a row's ask). */
export interface RowsChanged {
  rowsWritten(rows: readonly StatusRow[]): void
  rowRemoved(id: string): void
}

export interface StatusRouteOptions {
  changed?: RowsChanged
  /** This server's machine, sent with the rows so the page knows which refs run here. */
  machine?: string
  /** The rows whose run ref is going now (status-actions.ts StatusRuns). */
  running?: () => readonly string[]
}

export function registerStatusRoutes(
  router: Router,
  status: StatusStore,
  { changed, machine, running }: StatusRouteOptions = {},
): void {
  router.on('GET', '/api/status', (ctx) => ({
    ...status.read(filterFrom(ctx.query)),
    machine,
    running: running?.() ?? [],
  }))
  router.on('POST', '/api/status/rows', async (ctx) => {
    requireThisMachine(ctx.req)
    const rows = parseRows(await ctx.body())
    status.upsert(rows)
    changed?.rowsWritten(rows)
    return { written: rows.length }
  })
  router.on('DELETE', '/api/status/rows', (ctx) => {
    requireThisMachine(ctx.req)
    const id = ctx.query.get('id')
    if (!id) throw new HttpError(422, 'id is required')
    const removed = status.remove(id)
    if (removed) changed?.rowRemoved(id)
    return { removed }
  })
}

// -- aico-web's own rows ------------------------------------------------------------

const PROJECT = 'aico'
const WEB_UNIT = 'aico-web.service'

export interface SelfRowOptions {
  status: Pick<StatusStore, 'upsert'>
  hostName: string
  /** Where the app answers, for the service row's meaning. */
  address: string
  heartbeatMs: number
  now?: () => number
}

/** A row that is due again after two heartbeats: one missed beat is not late. */
function heartbeatRows(options: SelfRowOptions, now: number): StatusRow[] {
  const next_run = new Date(now + 2 * options.heartbeatMs).toISOString()
  const last_run = new Date(now).toISOString()
  const host = options.hostName
  return [
    {
      // Until host-steward reports the machine itself, aico-web's heartbeat stands for it: when
      // it stops, the machine's other rows show unknown.
      id: `${host}/machine`,
      what: host,
      kind: 'machine',
      machine: host,
      state: 'ok',
      meaning: 'Up and reporting to Aico.',
      last_run,
      next_run,
    },
    {
      id: `${host}/aico-web`,
      what: 'Aico web server',
      kind: 'service',
      machine: host,
      project: PROJECT,
      state: 'ok',
      meaning: `Serving the app and API on ${options.address}.`,
      last_run,
      next_run,
      actions: [
        { kind: 'run', ref: `systemctl --user restart ${WEB_UNIT}` },
        // The last lines, then end: printed from the oldest, a whole journal is cut off at 10 s.
        { kind: 'log', ref: `journalctl --user -u ${WEB_UNIT} -n 200 --no-pager` },
      ],
    },
  ]
}

/** Writes the machine and service rows now and every heartbeat; `stop` marks the service off. */
export function startSelfRows(options: SelfRowOptions): { stop(reason: string): void } {
  const now = options.now ?? Date.now
  const beat = () => {
    try {
      options.status.upsert(heartbeatRows(options, now()))
    } catch (error) {
      console.error('[aico-web] status heartbeat failed:', error)
    }
  }
  beat()
  const timer = setInterval(beat, options.heartbeatMs)
  timer.unref()
  return {
    stop(reason) {
      clearInterval(timer)
      const [, service] = heartbeatRows(options, now())
      const { next_run: _due, ...stopped } = service as StatusRow
      try {
        options.status.upsert([{ ...stopped, state: 'off', meaning: `Stopped (${reason}).` }])
      } catch (error) {
        console.error('[aico-web] status stop row failed:', error)
      }
    },
  }
}
