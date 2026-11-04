// `GET /v1/history` (API 27): the session history (history.ts). The list, one
// session's totals, and its events read from the tool's transcript.

import { HttpError, type Router, sendJson } from '../http'
import type { History } from './history'

function count(value: string | null, field: string): number | undefined {
  if (value === null) return undefined
  if (!/^\d{1,9}$/.test(value)) throw new HttpError(400, 'invalid_query', { field })
  return Number(value)
}

export function registerHistoryRoutes(router: Router, history: History): void {
  const find = (id: string | undefined) => {
    const row = history.find(id ?? '')
    if (row === 'ambiguous') throw new HttpError(409, 'ambiguous_session')
    if (!row) throw new HttpError(404, 'unknown_session')
    return row
  }
  router
    .add('GET', '/v1/history', (_req, res, _params, query) => {
      const items = history.list({
        limit: count(query.get('limit'), 'limit'),
        tool: query.get('tool') ?? undefined,
        project: query.get('project') ?? undefined,
      })
      sendJson(res, 200, { items })
    })
    .add('GET', '/v1/history/:id', (_req, res, params) => {
      sendJson(res, 200, history.get(find(params.id)))
    })
    .add('GET', '/v1/history/:id/events', (_req, res, params, query) => {
      const row = find(params.id)
      const page = history.events(row, {
        limit: count(query.get('limit'), 'limit'),
        before: count(query.get('before'), 'before'),
        from: count(query.get('from'), 'from'),
      })
      if (page === 'gone') throw new HttpError(410, 'transcript_gone')
      sendJson(res, 200, page)
    })
}
