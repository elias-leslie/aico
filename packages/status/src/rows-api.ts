// aico-web's row endpoint (packages/web-server/src/status.ts): POST /api/status/rows takes a list
// of rows, DELETE /api/status/rows?id= drops one. Writers call these and keep their own failure
// handling (throw, retry, keep in the outbox, or ignore). No database code: the Tether daemon
// imports this through @aico/fleet.

export interface RowsRequest {
  timeoutMs: number
  fetch?: typeof fetch
}

/** The endpoint on `base`, an aico-web origin or the endpoint URL itself; `id` names one row. */
export function statusRowsUrl(base: string | URL, id?: string): URL {
  const url = new URL('/api/status/rows', base)
  if (id !== undefined) url.searchParams.set('id', id)
  return url
}

export function postStatusRows(
  base: string | URL,
  rows: readonly unknown[],
  request: RowsRequest,
): Promise<Response> {
  return (request.fetch ?? fetch)(statusRowsUrl(base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(rows),
    signal: AbortSignal.timeout(request.timeoutMs),
  })
}

export function deleteStatusRow(
  base: string | URL,
  id: string,
  request: RowsRequest,
): Promise<Response> {
  return (request.fetch ?? fetch)(statusRowsUrl(base, id), {
    method: 'DELETE',
    signal: AbortSignal.timeout(request.timeoutMs),
  })
}
