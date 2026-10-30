// What the web app asks Tether beyond the shared client's typed calls, and
// how Tether's refusals read in the app's API.

import {
  HOST_CREATE_TIMEOUT_MS,
  type SessionDescriptor,
  type TetherClient,
  TetherError,
  TetherUnavailable,
} from 'tether/client'

/** Sessions the web app creates are stored with this origin (they open no desktop window). */
export const WEB_ORIGIN = 'a-term'

/** A refusal the API answers with `status` and `{detail}`. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    /** The Tether failure it answers, when there was one. */
    readonly cause?: unknown,
  ) {
    super(detail)
  }
}

export function createSession(
  tether: TetherClient,
  input: {
    tool: string
    projectId?: string | null
    projectRoot?: string | null
    name?: string | null
    size: { cols: number; rows: number }
    /** A remote host from Tether's hosts; omitted for this computer. */
    host?: string | null
  },
): Promise<SessionDescriptor> {
  const body: Record<string, unknown> = { origin: WEB_ORIGIN, tool: input.tool, size: input.size }
  if (input.host) body.host = input.host
  if (input.projectId) body.projectId = input.projectId
  if (input.projectRoot) body.projectRoot = input.projectRoot
  if (input.name) body.name = input.name
  return tether
    .request<SessionDescriptor>('POST', '/v1/sessions', body, {
      // A host that is off is powered on and waited for first.
      timeoutMs: input.host ? HOST_CREATE_TIMEOUT_MS : 60_000,
    })
    .then((answer) => answer.body)
}

export function respawnSession(
  tether: TetherClient,
  id: string,
  generation: string,
): Promise<SessionDescriptor> {
  return tether
    .request<SessionDescriptor>(
      'POST',
      `/v1/sessions/${encodeURIComponent(id)}/respawn`,
      { generation },
      { timeoutMs: 60_000 },
    )
    .then((answer) => answer.body)
}

/** Every tool in Tether's registry (the shared client's `tools()` lists enabled ones only). */
export async function listTools(tether: TetherClient): Promise<{
  items: Record<string, unknown>[]
  defaultSlug: string | null
}> {
  const { body } = await tether.request<{ items?: unknown; defaultSlug?: unknown }>(
    'GET',
    '/v1/tools',
  )
  return {
    items: Array.isArray(body?.items)
      ? body.items.filter(
          (item): item is Record<string, unknown> => !!item && typeof item === 'object',
        )
      : [],
    defaultSlug: typeof body?.defaultSlug === 'string' ? body.defaultSlug : null,
  }
}

/** A session by id, or null when Tether no longer has it. */
export async function findSession(
  tether: TetherClient,
  id: string,
): Promise<SessionDescriptor | null> {
  try {
    return await tether.getSession(id)
  } catch (error) {
    if (error instanceof TetherError && error.status === 404) return null
    throw error
  }
}

const DETAILS: Record<string, [number, string]> = {
  not_found: [404, 'Not found'],
  stale_generation: [409, 'The session changed since it was read; refresh and try again'],
  identity_changed: [409, 'The session changed since it was read; refresh and try again'],
  busy: [409, 'Another operation is running on this session; try again'],
  blocked: [409, 'Tether could not prove cleanup for this session; it was preserved'],
  workload_unavailable: [409, 'The session is not running'],
  admission_denied: [409, 'Tether refused to start another agent right now'],
  outcome_uncertain: [409, 'Tether could not confirm the result; refresh before retrying'],
  linger_required: [503, 'Tether refuses durable sessions until linger is enabled'],
  unknown_tool: [400, 'Unknown agent tool'],
  unknown_project: [400, 'Unknown project'],
  invalid_body: [400, 'Invalid request'],
  wake_unsupported: [409, "Aico can't tell when this session is idle, so it can't take check-ins"],
  too_many_wakes: [409, 'This session has as many check-ins as it can take'],
  unknown_run: [404, 'That run is no longer listed; it may have ended'],
  unknown_step: [404, 'That step is no longer listed; it may have ended'],
  not_allowed: [409, 'That is not possible now'],
  agent_hub_unavailable: [503, 'Agent Hub is not reachable'],
  agent_hub_refused: [409, 'Agent Hub did not accept it'],
  host_unavailable: [409, 'That host is not reachable'],
  unknown_host: [400, 'Tether does not know that host'],
}

export const UNAVAILABLE_DETAIL =
  'Tether is not reachable; sessions keep running, but control is unavailable'

/** A Tether failure as the API answers it (anything else is rethrown). */
export function toHttpError(error: unknown, notFound?: string): HttpError {
  if (error instanceof HttpError) return error
  if (error instanceof TetherUnavailable) return new HttpError(503, UNAVAILABLE_DETAIL, error)
  if (error instanceof TetherError) {
    const known = DETAILS[error.code]
    const [status, knownDetail] = known ?? [
      error.status >= 500 || error.status === 0 ? 502 : error.status,
      `Tether error: ${error.code}`,
    ]
    let detail = error.code === 'not_found' && notFound ? notFound : knownDetail
    if (error.code === 'host_unavailable') detail = hostUnavailable(error)
    if (
      (error.code === 'blocked' ||
        error.code === 'admission_denied' ||
        error.code === 'agent_hub_refused' ||
        error.code === 'not_allowed') &&
      error.reason
    )
      detail = `${detail} (${error.reason})`
    return new HttpError(status, detail, error)
  }
  throw error
}

const HOST_STATES: Record<string, string> = {
  offline: 'offline',
  connecting: 'still connecting',
  powered_off: 'powered off',
  identity_changed: 'not the same machine as before',
}

/** `agent-work is offline (link down)`: Tether's own reason, in plain words. */
function hostUnavailable(error: TetherError): string {
  const host = typeof error.body.host === 'string' ? error.body.host : 'That host'
  const state = HOST_STATES[String(error.body.state)] ?? 'not reachable'
  return `${host} is ${state}${error.reason ? ` (${error.reason})` : ''}`
}
