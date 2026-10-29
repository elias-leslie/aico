// The routes a GUI needs to show a native chat for an Agent Hub session
// (docs/api-v1.md "Agent Hub sessions"): read the chat and the follow-up
// queue, follow the running turn as NDJSON, cancel it, and list the models.
// Sending a message is the existing inject route. Tether calls Agent Hub from
// here with the owner token read per request in client.ts; nothing below ever
// puts the token, or a request header, into an answer.

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { IdleEvent, Session, TurnEvent } from '@agent-hub/sdk'
import { HttpError, type Router, readJsonObject, sendJson } from '../http'
import type { WidgetRow } from '../lifecycle/catalog'
import { type AgentHubRuntime, classifyHubError, HubError } from './runtime'

/** `GET /v1/sessions/:id/chat` */
export interface ChatAnswer {
  /** The Agent Hub session as the SDK returns it (with `messages` unless `messages=false`). */
  session: Session
  /** Follow-up texts waiting in Tether's durable queue, oldest first. */
  queued: string[]
}

/** `POST /v1/sessions/:id/chat/cancel` */
export interface ChatCancelAnswer {
  cancelled: boolean
}

/** `GET /v1/chat/models` */
export interface ChatModelsAnswer {
  items: Awaited<ReturnType<AgentHubRuntime['models']>>
}

/** One line of `GET /v1/sessions/:id/chat/stream`. */
export type ChatStreamLine =
  | TurnEvent
  | IdleEvent
  | { type: 'heartbeat' }
  | { type: 'stream_error'; code: string; message: string }

/** Heartbeat spacing of the chat stream; a test shortens it. */
export const chatTiming = { heartbeatMs: 15_000 }

const MAX_ERROR_MESSAGE = 200

/** What the lifecycle API lends these routes (its own session lookup and fence). */
export interface ChatApiDeps {
  runtime: () => AgentHubRuntime | null
  requireSession: (id: string | undefined) => WidgetRow
  fence: (row: WidgetRow, generation: string) => void
  requireGeneration: (body: Record<string, unknown>) => string
  only: (body: Record<string, unknown>, allowed: readonly string[]) => void
  whenReady: () => Promise<unknown>
}

/** Map an Agent Hub failure to the status deliverToAgentHub gives it. */
export function hubHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error
  const failure = classifyHubError(error)
  if (failure.code === 'agent_hub_unavailable') return new HttpError(503, 'agent_hub_unavailable')
  return new HttpError(409, 'workload_unavailable', { reason: failure.message })
}

function hubRuntime(deps: ChatApiDeps): AgentHubRuntime {
  const runtime = deps.runtime()
  if (!runtime) throw new HttpError(503, 'agent_hub_unavailable')
  return runtime
}

function requireHubSession(deps: ChatApiDeps, id: string | undefined): WidgetRow {
  const row = deps.requireSession(id)
  if (row.backend !== 'agent-hub')
    throw new HttpError(409, 'workload_unavailable', {
      reason: 'only an Agent Hub session has a chat',
    })
  return row
}

/** Run an operation, turning any Agent Hub failure into the API's answer. */
export async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof HubError || (error as { status?: unknown })?.status !== undefined)
      throw hubHttpError(error)
    throw error
  }
}

export function parseAfterSeq(query: URLSearchParams): number {
  const raw = query.get('afterSeq')
  if (raw === null) return 0
  const value = /^\d{1,15}$/.test(raw) ? Number(raw) : Number.NaN
  if (!Number.isSafeInteger(value)) throw new HttpError(400, 'invalid_query', { field: 'afterSeq' })
  return value
}

/** Follow a turn as NDJSON on a response (`attach` opens the event source; the
 * SDK reconnects itself). A failure before the first event is an HTTP answer. */
export async function streamTurn(
  attach: (signal: AbortSignal) => AsyncGenerator<TurnEvent | IdleEvent, void, undefined>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  req.once('close', () => {
    if (!res.writableEnded) abort()
  })
  res.once('close', abort)
  const iterator = attach(controller.signal)
  const line = (value: ChatStreamLine) => {
    if (!res.destroyed) res.write(`${JSON.stringify(value)}\n`)
  }
  let first: IteratorResult<TurnEvent | IdleEvent, void>
  try {
    // The SDK connects on the first read: failures here are still an HTTP answer.
    first = await iterator.next()
  } catch (error) {
    if (controller.signal.aborted) return
    throw hubHttpError(error)
  }
  if (controller.signal.aborted) {
    await iterator.return(undefined).catch(() => undefined)
    return
  }
  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
  })
  const heartbeat = setInterval(() => line({ type: 'heartbeat' }), chatTiming.heartbeatMs)
  try {
    let step = first
    while (!step.done) {
      line(step.value)
      step = await iterator.next()
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      const code = (error as { code?: unknown })?.code
      const message = error instanceof Error ? error.message : 'the stream was interrupted'
      line({
        type: 'stream_error',
        code: typeof code === 'string' && code ? code : 'stream_interrupted',
        message: message.slice(0, MAX_ERROR_MESSAGE),
      })
    }
  } finally {
    clearInterval(heartbeat)
    abort()
    await iterator.return(undefined).catch(() => undefined)
    if (!res.writableEnded) res.end()
  }
}

export function registerChatRoutes(router: Router, deps: ChatApiDeps): void {
  router
    .add('GET', '/v1/sessions/:id/chat', async (_req, res, params, query) => {
      const row = requireHubSession(deps, params.id)
      const runtime = hubRuntime(deps)
      const includeMessages = query.get('messages') !== 'false'
      const answer: ChatAnswer = await guarded(() => runtime.chat(row.id, includeMessages))
      sendJson(res, 200, answer)
    })
    .add('GET', '/v1/sessions/:id/chat/stream', async (req, res, params, query) => {
      const row = requireHubSession(deps, params.id)
      const afterSeq = parseAfterSeq(query)
      const runtime = hubRuntime(deps)
      await guarded(() =>
        streamTurn((signal) => runtime.attach(row.id, afterSeq, signal), req, res),
      )
    })
    .add('POST', '/v1/sessions/:id/chat/cancel', async (req, res, params) => {
      const body = await readJsonObject(req)
      deps.only(body, ['generation'])
      const generation = deps.requireGeneration(body)
      const row = requireHubSession(deps, params.id)
      deps.fence(row, generation)
      await deps.whenReady()
      const runtime = hubRuntime(deps)
      const cancelled = await guarded(() => runtime.cancelTurn(row.id))
      const answer: ChatCancelAnswer = { cancelled }
      sendJson(res, 200, answer)
    })
    .add('GET', '/v1/chat/models', async (_req, res) => {
      const runtime = hubRuntime(deps)
      const items = await guarded(() => runtime.models())
      const answer: ChatModelsAnswer = { items }
      sendJson(res, 200, answer)
    })
}
